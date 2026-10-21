'use strict';
// The Client Agent orchestrator.
//
//   question ─▶ authorise client ─▶ plan tools ─▶ run tools ─▶ fence results
//                                                                    │
//                        structured answer ◀─ model ◀─ build prompt ◀─┘
//
// The order matters and is the security design, not a style choice:
//
//   AUTHORISE FIRST. Before any tool runs, the client is resolved through the
//   ERP with the user's own token. A clientId the caller may not see 404s here,
//   and the turn ends with a denial — no tools, no model call, no tokens spent,
//   nothing about that client in a prompt. §13's "client context is not
//   authorisation" is enforced by this being step one rather than a check
//   somewhere in the middle.
//
//   FENCE BEFORE PROMPTING. Tool output is wrapped as untrusted data
//   (platform/context/untrusted.js) before it is anywhere near the system
//   prompt, so there is no window in which raw client notes and instructions
//   share a plain string.
//
// Conversation history is accepted from the caller and deliberately bounded and
// re-fenced on every turn — see buildMessages().

const { planTools, planIntent } = require('./planner');
const { systemPrompt } = require('./prompt');
const { run: runTool } = require('../../platform/tools/registry');
const { newFenceId, buildContextBlock, neutralise } = require('../../platform/context/untrusted');
const { inferUsageKnown } = require('../../lib/usageLedger');
const logger = require('../../lib/logger');

/** How many prior turns to replay. Enough for "what about his attendance?"; not
 *  enough for an unbounded prompt that grows until it costs real money. */
const HISTORY_TURNS = 6;

/**
 * Resolve the client through the ERP as the calling user.
 * Doubles as the authorisation gate: a 404 here means "not yours".
 */
async function authoriseClient({ clientId, erp, userToken, requestId }) {
  const result = await runTool({
    name: 'getClientProfile', args: { clientId }, erp, userToken, requestId,
  });

  if (!result.ok) {
    // A 404 from the PROFILE endpoint while authorising IS the client denial:
    // the ERP answers 404 when the client is invisible to this org (orgWhere).
    // Unknown-ROUTE 404s never reach here — they belong to this service's own
    // router — so remap is safe and gives the FE a dedicated code (WIRE-01 req.8).
    const code = result.code === 'NOT_FOUND' ? 'CLIENT_NOT_FOUND' : result.code;
    return { ok: false, ...result, code };
  }
  // The ERP shape is { data: {...} } on pt-os routes; tolerate both.
  const row = result.data?.data ?? result.data;
  const name = row?.name;
  if (!name) {
    // Same meaning as the 404 denial above: the record is not visible to you.
    return { ok: false, code: 'CLIENT_NOT_FOUND', message: 'Not found, or not visible to you.' };
  }
  return { ok: true, name, profile: result };
}

function buildMessages({ system, contextBlock, history, question }) {
  const messages = [{ role: 'system', content: system }];

  // Prior turns are replayed as plain text. The user's own past questions are
  // legitimate instructions; past ASSISTANT text is not re-trusted blindly —
  // it is neutralised, because an earlier turn may have quoted a malicious
  // note verbatim, and replaying that quote unfenced would smuggle it back in
  // outside the fence that contained it the first time.
  for (const turn of history.slice(-HISTORY_TURNS)) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: String(turn.content).slice(0, 4000) });
    } else if (turn.role === 'assistant') {
      messages.push({ role: 'assistant', content: neutralise(String(turn.content).slice(0, 4000), '') });
    }
  }

  if (contextBlock) messages.push({ role: 'user', content: contextBlock });
  messages.push({ role: 'user', content: question });
  return messages;
}

function createClientAgent({ config, erp, router, ledger }) {
  /**
   * The studio-quota gate (round-2 Phase B). The ERP owns the limit; this is
   * only its enforcement point. In `enforce` mode the check is FAIL-CLOSED:
   * a limit that cannot be evaluated refuses the model call, because "I could
   * not check" is not a spending authorisation. Refusal also respects the
   * ERP's own switch — an operator who turned enforcement off in the ERP is
   * not re-enforced against here without knowing.
   */
  async function checkQuota({ userToken, requestId }) {
    const mode = config.AI_QUOTA_MODE;
    if (mode === 'off') return { ok: true };
    try {
      const { data } = await erp.get('/api/ai/usage/service/quota', { userToken, requestId });
      const q = data?.data ?? data;
      if (q?.over) {
        if (mode === 'enforce' && q.enforcement_enabled) {
          return {
            ok: false,
            status: 429,
            code: 'QUOTA_EXCEEDED',
            message: 'This studio has reached its monthly AI allowance. Please contact your administrator.',
          };
        }
        logger.warn({
          requestId,
          tokens_used: q.tokens_used,
          limit: q.limit,
          used_pct: q.used_pct,
          enforcement_enabled: Boolean(q.enforcement_enabled),
        }, 'client_agent_quota_spent');
      }
      return { ok: true, quota: q };
    } catch (err) {
      if (mode === 'enforce') {
        logger.warn({ requestId, code: err?.code }, 'client_agent_quota_unverifiable');
        return {
          ok: false,
          status: 503,
          code: 'QUOTA_UNVERIFIED',
          message: 'The assistant cannot verify your studio\'s AI allowance right now. Please try again shortly.',
        };
      }
      logger.warn({ requestId, code: err?.code }, 'client_agent_quota_check_unavailable');
      return { ok: true };
    }
  }

  /**
   * Best-effort report into the ERP's ai_usage_log (Phase B). The ERP resolves
   * user and studio from the forwarded token — identity is never claimed. A
   * failed report degrades bookkeeping, never the answer; unknown token usage
   * arrives as null and the ERP labels it estimated, exactly as it does for
   * its own gateway (metering.usageFields).
   */
  function reportUsage({ userToken, requestId, payload }) {
    if (!erp.post) return; // test fakes without a post method just skip it
    erp.post('/api/ai/usage/service/ingest', payload, { userToken, requestId })
      // Phase 4E: a failed report degrades bookkeeping, never the answer — but
      // it must be observable. `debug` was invisible in production's log
      // level, so an ERP outage dropped every ingest without a trace. `warn`
      // names the event and the code, no prompt content, no tokens.
      .catch((err) => logger.warn({ requestId, code: err?.code, status: err?.status }, 'usage_ingest_failed'));
  }

  /** Attempts summary for the ledger and the ERP report. */
  function attemptsOf(err) { return Array.isArray(err?.attempts) ? err.attempts : []; }

  /**
   * @param {object} req
   * @param {string} req.clientId    From the browser. Untrusted until authorised.
   * @param {string} req.message     The trainer's question.
   * @param {Array}  [req.history]   [{role, content}], most recent last.
   * @param {string} req.userToken   The end user's JWT, forwarded to the ERP.
   * @param {string} req.requestId
   * @param {(fullSoFar:string)=>void} [req.onDelta] Streaming hook: called with
   *   the CUMULATIVE answer as the model writes it (the frontend parser's
   *   contract), only while the model is generating.
   */
  async function ask({ clientId, message, history = [], userToken, requestId, onDelta }) {
    const started = Date.now();

    // 1. Authorise. Nothing else happens until this passes.
    const auth = await authoriseClient({ clientId, erp, userToken, requestId });
    if (!auth.ok) {
      logger.info({ requestId, code: auth.code }, 'client_agent_denied');
      ledger?.record?.({
        request_id: requestId, agent: 'client', outcome: 'client_denied',
        code: auth.code || 'DENIED', latency_ms: Date.now() - started,
      });
      return {
        ok: false,
        status: auth.status || (auth.code === 'RATE_LIMITED' ? 429 : auth.code === 'CLIENT_NOT_FOUND' || auth.code === 'NOT_FOUND' ? 404 : 403),
        code: auth.code,
        message: auth.message,
        toolsUsed: [],
      };
    }

    // 2. Plan — deterministic, so cheap questions stay cheap.
    const { tools: planned } = planTools(message);
    const intent = planIntent(message);

    // getClientProfile was already fetched by the authorisation step; reuse it
    // rather than paying for the same call twice in one turn.
    const toRun = planned.filter((t) => t !== 'getClientProfile');
    const results = [auth.profile];

    // 3. The quota gate runs BEFORE any model spend (Phase B). It does not
    //    gate the tool reads — they are local database reads, not tokens.
    const quota = await checkQuota({ userToken, requestId });
    if (!quota.ok) {
      logger.info({ requestId, code: quota.code }, 'client_agent_quota_blocked');
      ledger?.record?.({
        request_id: requestId, agent: 'client', outcome: quota.code === 'QUOTA_EXCEEDED' ? 'quota_exceeded' : 'quota_unverified',
        latency_ms: Date.now() - started,
      });
      return {
        ok: false,
        status: quota.status,
        code: quota.code,
        message: quota.message,
        toolsUsed: [],
      };
    }

    // 4. Retrieve. In parallel — these are independent reads, and a trainer
    //    mid-session should not wait on them serially.
    const rest = await Promise.all(toRun.map((name) => runTool({
      name, args: { clientId }, erp, userToken, requestId,
    })));
    results.push(...rest);

    const okResults = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    // 5. Fence, then prompt.
    const fenceId = newFenceId();
    const contextBlock = buildContextBlock(
      okResults.map((r) => ({ label: r.label, tool: r.tool, data: r.data })),
      fenceId,
    );

    const system = systemPrompt({
      clientName: auth.name,
      toolsRun: okResults.map((r) => r.tool),
      toolsFailed: failed.map((r) => r.tool),
    });

    const messages = buildMessages({ system, contextBlock, history, question: message });

    // 6. Answer. onDelta streams the cumulative answer out while the model
    //    writes, so an SSE caller shows text as it arrives. The provenance
    //    rides along on the first delta so the caller can emit a factual
    //    `start` event (which tools ran, whose client it is) at that moment.
    const provenance = {
      clientName: auth.name,
      toolsUsed: okResults.map((r) => r.tool),
      toolsUnavailable: failed.map((r) => ({ tool: r.tool, reason: r.message })),
    };
    let completion;
    try {
      completion = await router.chat({
        intent,
        messages,
        onDelta: onDelta ? (cumulative) => onDelta(cumulative, provenance) : undefined,
      });
    } catch (err) {
      const attempts = attemptsOf(err);
      logger.error({ requestId, code: err.code }, 'client_agent_model_failed');
      ledger?.record?.({
        request_id: requestId, agent: 'client', outcome: 'model_failed',
        code: err.code || 'MODEL_FAILED', attempts,
        latency_ms: Date.now() - started,
        tools_run: okResults.length, tools_failed: failed.length,
      });
      return {
        ok: false,
        status: err.status || 503,
        code: err.code || 'MODEL_FAILED',
        message: 'The assistant is temporarily unavailable. Please try again.',
        toolsUsed: okResults.map((r) => r.tool),
      };
    }

    const elapsed = Date.now() - started;
    const attempts = attemptsOf(completion) ?? [];
    const tokensPrompt = completion.usage?.prompt ?? null;
    const tokensCompletion = completion.usage?.completion ?? null;
    const tokensLogged = (tokensPrompt ?? 0) + (tokensCompletion ?? 0);

    logger.info({
      requestId,
      intent,
      model: completion.model,
      used_fallback: completion.used_fallback,
      tools_ok: okResults.length,
      tools_failed: failed.length,
      tokens: tokensLogged,
      usage_known: inferUsageKnown(completion),
      latency_ms: elapsed,
    }, 'client_agent_answered');

    const payload = {
      requestId,
      outcome: 'ok',
      intent,
      model: completion.model,
      usedFallback: Boolean(completion.used_fallback),
      latencyMs: elapsed,
      attemptCount: attempts.length,
      // null tokens = the provider did not report usage; the ERP labels those
      // rows estimated (its own convention), never "0 cost verified".
      promptTokens: tokensPrompt,
      completionTokens: tokensCompletion,
      usageKnown: inferUsageKnown(completion),
      // Character proxy for a transparent estimate when tokens are unknown.
      // Never health data — a length only.
      replyChars: completion.content.length,
    };
    ledger?.record?.({
      request_id: requestId, agent: 'client', outcome: 'ok',
      intent, model: completion.model, used_fallback: Boolean(completion.used_fallback),
      usage: { prompt: tokensPrompt, completion: tokensCompletion, known: inferUsageKnown(completion) },
      attempts, latency_ms: elapsed,
      tools_run: okResults.length, tools_failed: failed.length,
    });
    reportUsage({ userToken, requestId, payload });

    return {
      ok: true,
      status: 200,
      message: completion.content,
      clientId,
      clientName: auth.name,
      // Provenance the UI can show, so a trainer can see what the answer rests on.
      toolsUsed: okResults.map((r) => r.tool),
      toolsUnavailable: failed.map((r) => ({ tool: r.tool, reason: r.message })),
      // Phase 1 is read-only. The field exists so the confirmation contract in
      // §27 has a shape from day one and adding a write is additive.
      proposedAction: null,
      requiresConfirmation: false,
      meta: {
        requestId,
        intent,
        model: completion.model,
        used_fallback: completion.used_fallback,
        latency_ms: elapsed,
        tokens: completion.usage,
        usage_known: inferUsageKnown(completion),
      },
    };
  }

  return { ask };
}

module.exports = { createClientAgent, authoriseClient, buildMessages, HISTORY_TURNS };

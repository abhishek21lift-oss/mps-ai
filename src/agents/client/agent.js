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

  if (!result.ok) return { ok: false, ...result };

  // The ERP shape is { data: {...} } on pt-os routes; tolerate both.
  const row = result.data?.data ?? result.data;
  const name = row?.name;
  if (!name) {
    return { ok: false, code: 'NOT_FOUND', message: 'Not found, or not visible to you.' };
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

function createClientAgent({ erp, router }) {
  /**
   * @param {object} req
   * @param {string} req.clientId    From the browser. Untrusted until authorised.
   * @param {string} req.message     The trainer's question.
   * @param {Array}  [req.history]   [{role, content}], most recent last.
   * @param {string} req.userToken   The end user's JWT, forwarded to the ERP.
   * @param {string} req.requestId
   */
  async function ask({ clientId, message, history = [], userToken, requestId }) {
    const started = Date.now();

    // 1. Authorise. Nothing else happens until this passes.
    const auth = await authoriseClient({ clientId, erp, userToken, requestId });
    if (!auth.ok) {
      logger.info({ requestId, code: auth.code }, 'client_agent_denied');
      return {
        ok: false,
        status: auth.status || (auth.code === 'NOT_FOUND' ? 404 : 403),
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

    // 3. Retrieve. In parallel — these are independent reads, and a trainer
    //    mid-session should not wait on them serially.
    const rest = await Promise.all(toRun.map((name) => runTool({
      name, args: { clientId }, erp, userToken, requestId,
    })));
    results.push(...rest);

    const okResults = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    // 4. Fence, then prompt.
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

    // 5. Answer.
    let completion;
    try {
      completion = await router.chat({ intent, messages });
    } catch (err) {
      logger.error({ requestId, code: err.code }, 'client_agent_model_failed');
      return {
        ok: false,
        status: err.status || 503,
        code: err.code || 'MODEL_FAILED',
        message: 'The assistant is temporarily unavailable. Please try again.',
        toolsUsed: okResults.map((r) => r.tool),
      };
    }

    const elapsed = Date.now() - started;
    logger.info({
      requestId,
      intent,
      model: completion.model,
      used_fallback: completion.used_fallback,
      tools_ok: okResults.length,
      tools_failed: failed.length,
      tokens: completion.usage.prompt + completion.usage.completion,
      latency_ms: elapsed,
    }, 'client_agent_answered');

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
        intent,
        model: completion.model,
        used_fallback: completion.used_fallback,
        latency_ms: elapsed,
        tokens: completion.usage,
      },
    };
  }

  return { ask };
}

module.exports = { createClientAgent, authoriseClient, buildMessages, HISTORY_TURNS };

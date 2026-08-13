'use strict';
// The audit trail (§28).
//
// Distinct from the operational logging in lib/logger.js, and deliberately so.
// Operational logs answer "is the service healthy?" and may be sampled, noisy
// or dropped. Audit events answer "who asked for what, and what did they get?"
// and are the record you read after an incident. Mixing them means the second
// question gets answered by whatever survived log-level filtering.
//
// Every event carries `audit: true` so a log pipeline can route the stream
// somewhere with a longer retention than application noise.
//
// ── Who is the actor? ────────────────────────────────────────────────────────
//
// §28 asks for user_id and tenant_id on every event. This service CANNOT
// produce either, and that is not an oversight to work around — it is the
// architecture. The ERP's JWT payload is `{ id, token_version }`; role and
// organisation are resolved from Postgres by the ERP on each request. Decoding
// the token here to fish out an id would mean parsing an unverified credential
// (there is no JWT_SECRET to verify it with) and then logging whatever an
// attacker put in it. That is worse than useless: an audit trail you can forge
// is one that launders a forgery into evidence.
//
// So instead: `actor`, an HMAC of the token keyed with SERVICE_AUTH_SECRET,
// truncated. Properties that matter here —
//
//   * Stable. The same session produces the same actor, so a sequence of
//     requests can be correlated and rate-of-access questions can be answered.
//   * Non-reversible. The audit log never holds a usable credential, so a leaked
//     log is not a set of live sessions. (A plain hash would be reversible by
//     anyone holding the token already; the key makes the log useless on its own.)
//   * Rotates with the secret. Rotating SERVICE_AUTH_SECRET breaks correlation
//     across the rotation — accepted, and preferable to a permanent identifier.
//
// Joining `actor` back to a real user requires the ERP's own request log. That
// join is the correct place for it: the ERP is the only party that ever knew
// the answer.
//
// ── What is never recorded ───────────────────────────────────────────────────
//
// Not the token. Not the question text (a trainer types client names, injuries
// and phone numbers into it). Not tool result payloads. Not the model's answer.
// §28's own instruction is to log the metadata, not the data — an audit trail
// that copies the medical notes it is auditing access to has doubled the number
// of places those notes live.

const crypto = require('node:crypto');
const logger = require('../../lib/logger');

/** Pseudonymous, stable, non-reversible. See the header. */
function actorFor(userToken, secret) {
  if (!userToken) return 'anonymous';
  return crypto.createHmac('sha256', String(secret)).update(String(userToken)).digest('hex').slice(0, 16);
}

function createAudit({ config, sink = logger }) {
  const base = () => ({ audit: true, ts: new Date().toISOString() });

  /**
   * One AI request, start to finish.
   * @param {object} e
   * @param {string} e.requestId
   * @param {string} e.actor       From actorFor().
   * @param {string} [e.clientId]  The resource asked about. An opaque id, not a name.
   * @param {string} e.outcome     'answered' | 'denied' | 'failed'
   */
  function request(e) {
    sink.info({
      ...base(),
      event: 'ai_request',
      requestId: e.requestId,
      actor: e.actor,
      agent: e.agent,
      clientId: e.clientId ?? null,
      intent: e.intent ?? null,
      outcome: e.outcome,
      code: e.code ?? null,
      status: e.status ?? null,
      tools_ok: e.toolsOk ?? 0,
      tools_failed: e.toolsFailed ?? 0,
      model: e.model ?? null,
      used_fallback: e.usedFallback ?? null,
      tokens_prompt: e.tokens?.prompt ?? null,
      tokens_completion: e.tokens?.completion ?? null,
      context_chars: e.contextChars ?? null,
      truncated_tools: e.truncatedTools ?? [],
      dropped_tools: e.droppedTools ?? [],
      latency_ms: e.latencyMs ?? null,
    }, 'audit_ai_request');
  }

  /** One tool invocation. Arguments are recorded; they are ids, never content. */
  function tool(e) {
    sink.info({
      ...base(),
      event: 'ai_tool_call',
      requestId: e.requestId,
      actor: e.actor,
      tool: e.tool,
      args: e.args ?? null,
      ok: e.ok,
      code: e.code ?? null,
      status: e.status ?? null,
      result_chars: e.resultChars ?? null,
      truncated: e.truncated ?? false,
      latency_ms: e.latencyMs ?? null,
    }, 'audit_tool_call');
  }

  /**
   * An authorisation refusal. Logged at warn so it surfaces without a query:
   * a run of these against different client ids from one actor is the shape of
   * enumeration, and §29 asks specifically that rejected cross-tenant attempts
   * be observable.
   */
  function denied(e) {
    sink.warn({
      ...base(),
      event: 'ai_denied',
      requestId: e.requestId,
      actor: e.actor,
      clientId: e.clientId ?? null,
      tool: e.tool ?? null,
      code: e.code,
      status: e.status,
      reason: e.reason ?? null,
    }, 'audit_denied');
  }

  return {
    request,
    tool,
    denied,
    actor: (userToken) => actorFor(userToken, config.SERVICE_AUTH_SECRET),
  };
}

module.exports = { createAudit, actorFor };

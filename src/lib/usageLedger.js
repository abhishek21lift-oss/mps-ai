'use strict';
// Usage ledger (round-2 remediation, MPS-01).
//
// One JSONL line per request the agent handled — the auditable record the old
// service kept nowhere: request id, outcome, per-attempt model/latency/tokens.
//
// What is deliberately NOT in it, because MPS-01 forbids it: prompts, replies,
// client names, health or payment data, JWTs, keys. Every value is an id, a
// count, a duration or an outcome code. Identity of the actor is resolved
// server-side by the ERP when the same request is reported into ai_usage_log;
// this file only needs to be correlatable by request_id.
//
// Append failures are logged once and swallowed: an audit file on a read-only
// filesystem must never take the user's answer down with it.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Known-token test shared by the router and agent (MPS-01): usage counts only
 * count as KNOWN when the provider explicitly reports them. An explicit
 * `usageKnown` flag wins; otherwise a complete usage object counts.
 */
function inferUsageKnown(out) {
  if (!out) return false;
  if (typeof out.usageKnown === 'boolean') return out.usageKnown;
  return Boolean(
    out.usage
    && Number.isFinite(out.usage.prompt)
    && Number.isFinite(out.usage.completion),
  );
}

function createUsageLedger({ config }) {
  const file = config.usageLedgerFile || null;
  let warned = false;

  function record(row) {
    if (!file) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
      return true;
    } catch (err) {
      if (!warned) {
        warned = true;
        logger.warn({ file, err: err?.message }, 'usage_ledger_unwritable');
      }
      return false;
    }
  }

  return { record, enabled: Boolean(file) };
}

module.exports = { createUsageLedger, inferUsageKnown };

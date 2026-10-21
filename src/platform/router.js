'use strict';
// Model selection and fallback.
//
// Two jobs, kept here so no other file names a model:
//
//   1. INTENT → TIER. §20 asks that a cheap question not pay for a strong
//      model. The routing table is the seam; today both tiers may resolve to
//      the same model and nothing breaks, but the call sites already pass an
//      intent, so changing the table later is a one-line change rather than a
//      refactor.
//   2. FALLBACK. Free-tier models are rate-limited and go away without notice.
//      One retry on the fallback model turns a provider outage into a slower
//      answer instead of a failed one. Mirrors lib/ai/router.js in the ERP.
//
// Deliberately NOT here: retry loops beyond a single fallback. A model that has
// failed twice is not going to succeed on the third attempt inside one user's
// request, and §44 is explicit that runaway cost is a failure mode of its own.

const logger = require('../lib/logger');
const { inferUsageKnown } = require('../lib/usageLedger');

const INTENT_TIERS = {
  // Short factual lookups — "when does the package expire?"
  lookup: 'primary',
  // Multi-source reasoning — "how is this client progressing?"
  analysis: 'primary',
  // Structured narrative — "give me a full status report"
  summary: 'primary',
};

function resolveModel(config, intent) {
  const tier = INTENT_TIERS[intent] || 'primary';
  return { model: config.AI_PRIMARY_MODEL, tier };
}

function createRouter({ config, provider }) {
  // Every model attempt — primary success, fallback success or both failures —
  // is recorded so the usage ledger can account for what was actually spent
  // (MPS-01), including the request that produced NO answer at all.
  async function chat({ intent = 'analysis', messages, temperature, maxTokens, onDelta, signal }) {
    const { model, tier } = resolveModel(config, intent);
    const attempts = [];

    try {
      const out = await provider.generate({ model, messages, temperature, maxTokens, onDelta, signal });
      attempts.push({ model: out.model || model, ok: true, usage: out.usage ?? null, usageKnown: inferUsageKnown(out), latency_ms: out.latency_ms ?? 0 });
      return { ...out, intent, tier, used_fallback: false, attempts };
    } catch (primaryErr) {
      logger.warn({ model, intent, code: primaryErr.code }, 'ai_primary_failed');
      attempts.push({ model, ok: false, code: primaryErr.code || 'AI_FAILED', latency_ms: 0 });
      attachAttempts(primaryErr, attempts);

      // A caller that hung up is not a provider fault, and starting the
      // fallback would answer a question nobody is waiting for (audit P1-4).
      if (primaryErr.code === 'AI_ABORTED') throw primaryErr;

      if (config.AI_FALLBACK_MODEL === model) throw primaryErr;

      try {
        const out = await provider.generate({
          model: config.AI_FALLBACK_MODEL, messages, temperature, maxTokens, onDelta, signal,
        });
        logger.info({ fallback: config.AI_FALLBACK_MODEL, intent }, 'ai_fallback_success');
        attempts.push({ model: out.model || config.AI_FALLBACK_MODEL, ok: true, usage: out.usage ?? null, usageKnown: inferUsageKnown(out), latency_ms: out.latency_ms ?? 0 });
        return { ...out, intent, tier, used_fallback: true, attempts };
      } catch (fallbackErr) {
        logger.error({ intent, code: fallbackErr.code }, 'ai_all_models_failed');
        attempts.push({ model: config.AI_FALLBACK_MODEL, ok: false, code: fallbackErr.code || 'AI_FAILED', latency_ms: 0 });
        const e = new Error('The AI service is temporarily unavailable.');
        e.code = 'ALL_MODELS_FAILED';
        e.status = 503;
        attachAttempts(e, attempts);
        throw e;
      }
    }
  }

  return { chat, resolveModel: (intent) => resolveModel(config, intent) };
}

function attachAttempts(err, attempts) {
  try { err.attempts = attempts; } catch { /* frozen errors can't carry it */ }
}

module.exports = { createRouter, INTENT_TIERS };

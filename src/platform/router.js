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
  async function chat({ intent = 'analysis', messages, temperature, maxTokens }) {
    const { model, tier } = resolveModel(config, intent);

    try {
      const out = await provider.generate({ model, messages, temperature, maxTokens });
      return { ...out, intent, tier, used_fallback: false };
    } catch (primaryErr) {
      logger.warn({ model, intent, code: primaryErr.code }, 'ai_primary_failed');

      if (config.AI_FALLBACK_MODEL === model) throw primaryErr;

      try {
        const out = await provider.generate({
          model: config.AI_FALLBACK_MODEL, messages, temperature, maxTokens,
        });
        logger.info({ fallback: config.AI_FALLBACK_MODEL, intent }, 'ai_fallback_success');
        return { ...out, intent, tier, used_fallback: true };
      } catch (fallbackErr) {
        logger.error({ intent, code: fallbackErr.code }, 'ai_all_models_failed');
        const e = new Error('The AI service is temporarily unavailable.');
        e.code = 'ALL_MODELS_FAILED';
        e.status = 503;
        throw e;
      }
    }
  }

  /**
   * Streaming counterpart to chat().
   *
   * ── The fallback rule is different here, and the difference is the point ────
   *
   * Non-streaming, a failed primary is invisible: retry on the fallback and the
   * user sees one answer, slightly later. Streaming, the moment a single token
   * has been written to the response the retry stops being free — the fallback
   * would start its answer from the beginning, and the user would watch a
   * half-finished sentence be followed by a fresh one.
   *
   * So fallback applies ONLY before the first delta. After that a failure is
   * reported as a failure. A truncated answer the reader can see is truncated
   * beats a seamless-looking one that silently contains two attempts.
   */
  async function* chatStream({ intent = 'analysis', messages, temperature, maxTokens }) {
    const { model, tier } = resolveModel(config, intent);

    if (typeof provider.generateStream !== 'function') {
      const e = new Error('The configured AI provider does not support streaming.');
      e.code = 'STREAMING_UNSUPPORTED';
      e.status = 501;
      throw e;
    }

    let started = false;

    async function* attempt(m, usedFallback) {
      for await (const ev of provider.generateStream({ model: m, messages, temperature, maxTokens })) {
        if (ev.type === 'delta') started = true;
        yield ev.type === 'done' ? { ...ev, intent, tier, used_fallback: usedFallback } : ev;
      }
    }

    try {
      yield* attempt(model, false);
      return;
    } catch (primaryErr) {
      if (started) {
        // Past the point of no return: the reader already has text.
        logger.error({ model, intent, code: primaryErr.code }, 'ai_stream_failed_mid_flight');
        throw primaryErr;
      }
      logger.warn({ model, intent, code: primaryErr.code }, 'ai_primary_stream_failed');
      if (config.AI_FALLBACK_MODEL === model) throw primaryErr;
    }

    try {
      yield* attempt(config.AI_FALLBACK_MODEL, true);
      logger.info({ fallback: config.AI_FALLBACK_MODEL, intent }, 'ai_stream_fallback_success');
    } catch (fallbackErr) {
      if (started) throw fallbackErr;
      logger.error({ intent, code: fallbackErr.code }, 'ai_all_stream_models_failed');
      const e = new Error('The AI service is temporarily unavailable.');
      e.code = 'ALL_MODELS_FAILED';
      e.status = 503;
      throw e;
    }
  }

  return { chat, chatStream, resolveModel: (intent) => resolveModel(config, intent) };
}

module.exports = { createRouter, INTENT_TIERS };

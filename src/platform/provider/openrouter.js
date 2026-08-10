'use strict';
// OpenRouter implementation of the AIProvider interface.
//
// Chosen because the ERP backend already talks to OpenRouter
// (src/lib/ai/openrouter.js) and the studio's model choices, free-tier
// defaults and billing already live there. Reusing the provider means one
// account, one set of model names and one place where cost is understood —
// rather than a second vendor relationship introduced by a second service.
//
// This file knows about HTTP and OpenRouter's response shape. Nothing above it
// does, which is what makes a second provider an additive change.

const logger = require('../../lib/logger');

const BASE_URL = 'https://openrouter.ai/api/v1';

function createOpenRouterProvider({ config, fetchImpl = globalThis.fetch }) {
  async function generate({ model, messages, temperature = 0.3, maxTokens = 1200, timeoutMs }) {
    const controller = new AbortController();
    const limit = timeoutMs || config.AI_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), limit);
    const started = Date.now();

    let res;
    try {
      res = await fetchImpl(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.AI_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'MY PT STUDIO AI',
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      const e = new Error(timedOut ? 'Model request timed out' : 'Model request failed');
      e.code = timedOut ? 'AI_TIMEOUT' : 'AI_UNREACHABLE';
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The body can echo the request, and the request carries the system
      // prompt — logged at debug only, never at the error the operator reads.
      const e = new Error(`Model provider responded ${res.status}`);
      e.code = 'AI_PROVIDER_ERROR';
      e.status = res.status;
      logger.warn({ model, status: res.status }, 'ai_provider_non_ok');
      throw e;
    }

    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const e = new Error('Model returned an empty completion');
      e.code = 'AI_EMPTY';
      throw e;
    }

    return {
      content,
      model: body.model || model,
      usage: {
        prompt: body?.usage?.prompt_tokens ?? 0,
        completion: body?.usage?.completion_tokens ?? 0,
      },
      latency_ms: Date.now() - started,
    };
  }

  return { name: 'openrouter', generate };
}

module.exports = { createOpenRouterProvider };

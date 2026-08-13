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

  /**
   * Streaming counterpart to generate(). Async generator, yielding:
   *
   *   { type: 'delta', text }        zero or more, in order
   *   { type: 'done', model, usage } exactly once, last
   *
   * Throws before the first `delta` if the request fails — which is the
   * property the router's fallback depends on. Once a delta has been yielded,
   * a mid-stream failure throws too, and the caller must NOT retry: the user
   * has already seen text, and a retry would replay it from the top.
   */
  async function* generateStream({ model, messages, temperature = 0.3, maxTokens = 1200, timeoutMs }) {
    const controller = new AbortController();
    const limit = timeoutMs || config.AI_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), limit);

    let res;
    try {
      res = await fetchImpl(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.AI_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'MY PT STUDIO AI',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          // Usage arrives in a final chunk rather than not at all, so the audit
          // trail records real token counts for streamed turns too.
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err?.name === 'AbortError';
      const e = new Error(timedOut ? 'Model request timed out' : 'Model request failed');
      e.code = timedOut ? 'AI_TIMEOUT' : 'AI_UNREACHABLE';
      throw e;
    }

    if (!res.ok) {
      clearTimeout(timer);
      const e = new Error(`Model provider responded ${res.status}`);
      e.code = 'AI_PROVIDER_ERROR';
      e.status = res.status;
      logger.warn({ model, status: res.status }, 'ai_provider_stream_non_ok');
      throw e;
    }

    let usage = { prompt: 0, completion: 0 };
    let resolvedModel = model;
    let any = false;
    let buffer = '';

    try {
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });

        // SSE frames are separated by a blank line. A frame can straddle two
        // network chunks, so only complete ones are consumed and the remainder
        // stays buffered — parsing on chunk boundaries is the classic way to
        // lose the middle of a sentence.
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;      // comments, event: lines
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;   // a keep-alive or a frame we do not understand
            }

            if (parsed.model) resolvedModel = parsed.model;
            if (parsed.usage) {
              usage = {
                prompt: parsed.usage.prompt_tokens ?? 0,
                completion: parsed.usage.completion_tokens ?? 0,
              };
            }

            const text = parsed?.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text.length) {
              any = true;
              yield { type: 'delta', text };
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (!any) {
      const e = new Error('Model returned an empty completion');
      e.code = 'AI_EMPTY';
      throw e;
    }

    yield { type: 'done', model: resolvedModel, usage };
  }

  return { name: 'openrouter', generate, generateStream };
}

module.exports = { createOpenRouterProvider };

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
  /**
   * One model attempt. Streams the completion line by line (round-2 remediation,
   * WIRE-01/MPS-03): `onDelta(fullSoFar)` fires with the CUMULATIVE answer as it
   * grows — exactly the contract the frontend parser expects (client-ai.ts reads
   * `event.content` as the full answer so far, not the delta) — so a stream
   * route can forward progress while the model is still writing.
   *
   * Usage is NEVER silently zeroed (MPS-01): tokens are null when the provider
   * sent none, with `usageKnown: false`. Estimation happens one layer up, where
   * it can be labelled.
   */
  async function generate({ model, messages, temperature = 0.3, maxTokens = 1200, timeoutMs, onDelta }) {
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
        // stream+usage: usage rides the final data chunk, so exact tokens are
        // available on streamed responses too (round-1 P1#3, mps-ai side).
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true, usage: { include: true } }),
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
      // The body can echo the request, and the request carries the system
      // prompt — logged at debug only, never at the error the operator reads.
      const e = new Error(`Model provider responded ${res.status}`);
      e.code = 'AI_PROVIDER_ERROR';
      e.status = res.status;
      logger.warn({ model, status: res.status }, 'ai_provider_non_ok');
      throw e;
    }

    try {
      // ── SSE parse ───────────────────────────────────────────────────────────
      // OpenRouter sends `data: {json}` lines (deltas, then a usage chunk, then
      // `data: [DONE]`), possibly with `: comment` heartbeat lines. Lines can
      // split across chunk boundaries, so we buffer on newlines.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let usage = null;
      let sawDone = false;

      const handlePayload = (payload) => {
        if (payload === '[DONE]') { sawDone = true; return; }
        let chunk;
        try { chunk = JSON.parse(payload); } catch { return; } // tolerate junk lines
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          content += delta;
          if (onDelta) onDelta(content);
        }
        if (chunk?.usage) usage = chunk.usage;
      };

      // The abort timer stays live through the read loop: a model that hangs
      // mid-stream aborts like one that never answered.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          handlePayload(line.slice(5).trim());
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith('data:')) handlePayload(tail.slice(5).trim());

      if (typeof content !== 'string' || !content.trim()) {
        const e = new Error('Model returned an empty completion');
        e.code = 'AI_EMPTY';
        throw e;
      }
      if (!sawDone) logger.warn({ model }, 'ai_stream_missing_done');

      const usageKnown = usage != null
        && Number.isFinite(usage.prompt_tokens)
        && Number.isFinite(usage.completion_tokens);

      return {
        content,
        model: usage?.model || model,
        // Per-field: keep what was reported, null where the provider said
        // nothing. `usageKnown` is only true when BOTH arrived.
        usage: {
          prompt: Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null,
          completion: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null,
        },
        usageKnown,
        latency_ms: Date.now() - started,
      };
    } catch (err) {
      if (err?.code) throw err; // our own typed errors propagate untouched
      // A read that died or was aborted by the (still-live) timer.
      if (err?.name === 'AbortError') {
        const e = new Error('Model request timed out');
        e.code = 'AI_TIMEOUT';
        throw e;
      }
      if (process.env.NODE_ENV !== 'test') {
        logger.warn({ errMsg: err?.message }, 'ai_stream_read_failed');
      }
      const e = new Error('Model stream failed');
      e.code = 'AI_STREAM_FAILED';
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return { name: 'openrouter', generate };
}

module.exports = { createOpenRouterProvider };

'use strict';
// POST /ai/client-agent/chat        — JSON answer (existing contract)
// POST /ai/client-agent/chat/stream — SSE answer   (WIRE-01 canonical fix)
//
// Both take the caller's credential straight off the request and hand it to the
// agent, which forwards it to the ERP — this service never inspects it for
// authorisation, because there is nothing in it to inspect (the ERP's JWT
// payload is `{id, token_version}`).
//
// Credential forms, in order of preference (WIRE-01 req.2/5 — "ERP stays the
// only credential judge"):
//
//   1. `Authorization: Bearer <jwt>` — service and non-browser callers.
//   2. The httpOnly `token` cookie — what the browser session has. It arrives
//      here only over same-origin transports (the Next.js /ai rewrite), it is
//      SameSite=strict so it cannot ride a cross-site request, and it is never
//      echoed into any response. It is forwarded verbatim to the ERP, which
//      remains the only thing that validates it — accepting the cookie does
//      NOT make this service a token validator, and nothing about it is
//      exposed to JavaScript.

const express = require('express');
const { z } = require('zod');
const crypto = require('node:crypto');
const logger = require('../lib/logger');

const Body = z.object({
  clientId: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1, 'message is required').max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(40).optional(),
});

/** Bearer when present, else the session cookie (unchanged, not echoed). */
function credentialFrom(req) {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) {
    return h.slice(7).trim() || null;
  }
  const raw = req.headers.cookie;
  if (typeof raw === 'string') {
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === 'token') {
        try {
          return decodeURIComponent(part.slice(eq + 1).trim()) || null;
        } catch {
          return part.slice(eq + 1).trim() || null; // malformed escape: try raw
        }
      }
    }
  }
  return null;
}

/** Parse failures map to the error event, then the stream closes. */
function sseWrite(res, event, data) {
  // A caller that hung up leaves a destroyed socket behind; writing to it
  // raises asynchronously and would surface as an unhandled 'error' (P1-4).
  if (res.writableEnded || res.destroyed) return;
  // Two addressing conventions at once, on purpose: `event:` for generic SSE
  // consumers, and a `type` field inside the payload because that is the
  // contract the frontend parser actually keys on (same shape as the ERP's
  // lib/ai-stream.ts — one switch, one place).
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

function createClientAgentRouter({ agent }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    const userToken = credentialFrom(req);
    if (!userToken) {
      // No credential means no identity to forward, and this service has no
      // way to manufacture one. Refuse before doing any work.
      return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Authentication required.' } });
    }

    const parsed = Body.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
    }

    const { clientId, message, history } = parsed.data;

    // A caller that navigates away aborts the upstream generation instead of
    // paying for an answer nobody will read (audit P1-4). `close` fires on
    // normal completion too, so it only counts when the response did not end.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      const result = await agent.ask({
        clientId, message, history, userToken, requestId, signal: controller.signal,
      });

      // Nobody left to answer (audit P1-4).
      if (res.destroyed) return undefined;

      if (!result.ok) {
        return res.status(result.status).json({
          error: { code: result.code, message: result.message },
          requestId,
        });
      }

      return res.json({
        message: result.message,
        clientId: result.clientId,
        clientName: result.clientName,
        toolsUsed: result.toolsUsed,
        toolsUnavailable: result.toolsUnavailable,
        proposedAction: result.proposedAction,
        requiresConfirmation: result.requiresConfirmation,
        meta: result.meta,
        requestId,
      });
    } catch (err) {
      // Unexpected only — handled failures return through result.ok above.
      // The message is deliberately generic: err.message here could carry a
      // fragment of the prompt or an upstream URL.
      logger.error({ requestId, err: err?.message }, 'client_agent_unhandled');
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Something went wrong.' },
        requestId,
      });
    }
  });

  // ── SSE ─────────────────────────────────────────────────────────────────────
  // Event sequence (frontend/parser contract, client-ai.ts):
  //   start  { clientId, clientName, toolsUsed, toolsUnavailable, requestId }
  //   chunk  { content: <FULL answer so far> }        — incremental display
  //   done   { message, clientId, clientName, toolsUsed, toolsUnavailable,
  //            proposedAction, requiresConfirmation, meta, requestId }
  //   error  { code, message, partial }               — terminal
  // `: ping` comments are emitted while the model is thinking so proxies do not
  // close an idle connection (the 60s quiet-period failure, MPS-03).
  router.post('/chat/stream', async (req, res) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    const userToken = credentialFrom(req);
    if (!userToken) {
      return res.status(401).json({ error: { code: 'NO_TOKEN', message: 'Authentication required.' } });
    }

    const parsed = Body.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
    }

    const { clientId, message, history } = parsed.data;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
    }, 15_000);
    let sentStart = false;
    let sentChars = 0;
    let lastContent = '';

    // The trainer closed the panel: abort the model call and let the agent
    // record the turn as cancelled rather than reporting usage (audit P1-4).
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    const finish = () => {
      clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    try {
      const result = await agent.ask({
        clientId,
        message,
        history,
        userToken,
        requestId,
        signal: controller.signal,
        onDelta(cumulative, provenance) {
          lastContent = cumulative;
          if (!sentStart) {
            // First token proves the turn passed authorisation and tools —
            // emit `start` with the real provenance the agent carried out.
            sentStart = true;
            sseWrite(res, 'start', {
              clientId,
              clientName: provenance?.clientName,
              toolsUsed: provenance?.toolsUsed ?? [],
              toolsUnavailable: provenance?.toolsUnavailable ?? [],
              requestId,
            });
          }
          // The frontend accumulates (`text += content`), so each chunk is the
          // DELTA, not the answer so far — matching the ERP stream contract
          // byte-for-byte.
          const delta = cumulative.slice(sentChars);
          if (delta) {
            sentChars = cumulative.length;
            sseWrite(res, 'chunk', { content: delta });
          }
        },
      });

      if (!result.ok) {
        // Note: authorisation/quota denials happen BEFORE any delta, so the
        // stream closes with a single error event. A model failure after
        // tokens arrived keeps `partial` true.
        sseWrite(res, 'error', {
          code: result.code,
          message: result.message,
          partial: sentChars > 0,
          status: result.status || 0,
        });
        return finish();
      }

      if (!sentStart) {
        sseWrite(res, 'start', {
          clientId,
          clientName: result.clientName,
          toolsUsed: result.toolsUsed,
          toolsUnavailable: result.toolsUnavailable,
          requestId,
        });
      }
      if (!lastContent) {
        // Deltas never fired (defensive; ask() returns full content on ok):
        // deliver the whole answer as one delta so the panel still paints.
        sseWrite(res, 'chunk', { content: result.message });
      }
      sseWrite(res, 'done', {
        message: result.message,
        clientId: result.clientId,
        clientName: result.clientName,
        toolsUsed: result.toolsUsed,
        toolsUnavailable: result.toolsUnavailable,
        proposedAction: result.proposedAction,
        requiresConfirmation: result.requiresConfirmation,
        meta: result.meta,
        requestId,
      });
      return finish();
    } catch (err) {
      logger.error({ requestId, err: err?.message }, 'client_agent_stream_unhandled');
      sseWrite(res, 'error', {
        code: 'INTERNAL',
        message: err?.message || 'Something went wrong.',
        partial: sentChars > 0,
        status: err?.status || 0,
      });
      return finish();
    }
  });

  return router;
}

module.exports = { createClientAgentRouter, Body, credentialFrom };

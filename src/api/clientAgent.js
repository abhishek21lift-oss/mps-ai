'use strict';
// POST /ai/client-agent/chat
//
// The only endpoint that reasons about a client. It takes the caller's bearer
// token straight off the request and hands it to the agent, which forwards it
// to the ERP — this service never inspects it for authorisation, because there
// is nothing in it to inspect (the ERP's JWT payload is `{id, token_version}`).

const express = require('express');
const { z } = require('zod');
const crypto = require('node:crypto');
const logger = require('../lib/logger');

const Body = z.object({
  // The same shape the tool registry enforces. Validating it here too means a
  // malformed id is a clean 400 at the edge rather than surfacing later as a
  // tool-level failure that reads like a permissions problem. The registry
  // keeps its own copy regardless — it is the enforcement point, and a check
  // that only exists at the edge is one refactor away from not existing.
  clientId: z.string().trim().min(1).max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'clientId must be an opaque id'),
  message: z.string().trim().min(1, 'message is required').max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(40).optional(),
});

const { tokenFrom } = require('../lib/requestToken');

function createClientAgentRouter({ agent }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    const userToken = tokenFrom(req);
    if (!userToken) {
      // No token means no identity to forward, and this service has no way to
      // manufacture one. Refuse before doing any work.
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

    try {
      const result = await agent.ask({ clientId, message, history, userToken, requestId });

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
        grounding: result.grounding,
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

  /* ─────────────────────────────────────────────────────────────────────────
     POST /ai/client-agent/chat/stream

     Same contract, same guards, delivered as Server-Sent Events. Additive: the
     non-streaming route above is unchanged, because a frontend that works today
     must keep working and §39 says so.

     The ordering that matters: the agent runs every fallible, status-bearing
     step BEFORE this route writes a single header. Once SSE headers go out the
     response is committed to 200, and a 404 that arrives after that is no
     longer a 404 — it is a success carrying a sad message. So a denial returns
     from askStream() as an ordinary object and is sent as an ordinary HTTP
     error, exactly as it would be on the non-streaming route.
     ───────────────────────────────────────────────────────────────────────── */
  router.post('/chat/stream', async (req, res) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    const userToken = tokenFrom(req);
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

    let result;
    try {
      result = await agent.askStream({ clientId, message, history, userToken, requestId });
    } catch (err) {
      logger.error({ requestId, err: err?.message }, 'client_agent_stream_unhandled');
      return res.status(500).json({
        error: { code: 'INTERNAL', message: 'Something went wrong.' },
        requestId,
      });
    }

    // Denials, short-circuits and anything else that resolved without needing a
    // model come back as a plain response — still with a real status code.
    if (!result.streaming) {
      if (!result.ok) {
        return res.status(result.status).json({
          error: { code: result.code, message: result.message },
          requestId,
        });
      }
      // A short-circuit has nothing to stream. Sent as one event over SSE
      // anyway, so a client has exactly one code path rather than two.
      res.writeHead(200, SSE_HEADERS);
      send(res, {
        type: 'start',
        clientId: result.clientId,
        clientName: result.clientName,
        toolsUsed: result.toolsUsed,
        toolsUnavailable: result.toolsUnavailable,
        requestId,
      });
      send(res, { type: 'chunk', content: result.message });
      send(res, {
        type: 'done',
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
      return res.end();
    }

    res.writeHead(200, SSE_HEADERS);

    // A client that navigates away mid-answer should stop the work, not leave
    // it writing into a dead socket until the model finishes.
    let aborted = false;
    req.on('close', () => { aborted = true; });

    // The gap before the first token is the dangerous one: the ERP reads are
    // done, but a cold free-tier model can take tens of seconds to say anything,
    // and the proxies in front of this service close a connection that has been
    // silent for about sixty. A comment frame is not an event — the client skips
    // any line that is not `data:` — so this keeps the socket warm without the
    // consumer needing to know it exists.
    const heartbeat = setInterval(() => {
      if (!aborted && !res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    try {
      for await (const ev of result.stream) {
        if (aborted) break;
        send(res, ev.type === 'done' ? { ...ev, requestId } : ev);
      }
    } catch (err) {
      // The generator itself failing is a bug rather than a model outage — the
      // model's own failures are yielded as an 'error' event inside it.
      logger.error({ requestId, err: err?.message }, 'client_agent_stream_broke');
      if (!aborted) send(res, { type: 'error', code: 'INTERNAL', message: 'Something went wrong.' });
    } finally {
      clearInterval(heartbeat);
    }

    return res.end();
  });

  return router;
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx sits in front of this service and will otherwise buffer the whole
  // response, which turns streaming back into waiting — with extra steps.
  'X-Accel-Buffering': 'no',
};

/**
 * One SSE frame.
 *
 * The event name is carried INSIDE the JSON as `type`, not only as an SSE
 * `event:` line. That is what the consumer reads (`619-erp-frontend`,
 * `src/lib/client-ai.ts`): it scans for `data:` lines and switches on
 * `evt.type`, ignoring everything else — which also lets `: ping` comment
 * frames pass through harmlessly. An `event:` line is emitted as well so the
 * stream is well-formed SSE for anything that does listen by event name, but
 * `type` is the field that matters and must never be dropped from the payload.
 *
 * JSON.stringify before writing is not decoration: a payload containing a
 * newline would otherwise end the frame early, and retrieved client notes are
 * full of newlines. Encoding removes the possibility rather than relying on
 * nobody ever putting one there.
 */
function send(res, payload) {
  res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

module.exports = { createClientAgentRouter, Body, SSE_HEADERS };

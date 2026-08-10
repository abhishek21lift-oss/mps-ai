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
  clientId: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1, 'message is required').max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(4000),
  })).max(40).optional(),
});

function bearerFrom(req) {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  return null;
}

function createClientAgentRouter({ agent }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();

    const userToken = bearerFrom(req);
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

  return router;
}

module.exports = { createClientAgentRouter, Body };

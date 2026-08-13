'use strict';
// Express app assembly, separated from listen() so tests build the real app
// with fake collaborators instead of asserting against a mock of themselves.

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { createErpClient } = require('./integrations/erp/client');
const { createOpenRouterProvider } = require('./platform/provider/openrouter');
const { createRouter } = require('./platform/router');
const { createClientAgent } = require('./agents/client/agent');
const { createClientAgentRouter } = require('./api/clientAgent');
const { list: listTools } = require('./platform/tools/registry');
const { createStudioClock } = require('./platform/time/studioClock');
const { createAudit } = require('./platform/audit/log');
const { rateLimitKey } = require('./lib/requestToken');
const logger = require('./lib/logger');

function buildApp({ config, erp, provider, clock, audit }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '128kb' }));

  // §47 — an explicit allow-list.
  //
  // `credentials` stays off, and that is still right even though the browser
  // now authenticates with a cookie. It never makes a cross-origin call here:
  // the frontend rewrites /ai/* to this service same-origin (next.config.js),
  // precisely because the `token` cookie is httpOnly and sameSite:'strict' and
  // would not survive a cross-site request. So the browser's cookie arrives via
  // that server-side hop, no CORS is involved in the path that matters, and
  // refusing credentialed cross-origin requests keeps CSRF out of the threat
  // model rather than inviting it back in.
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);              // server-to-server, curl
      if (config.allowedOrigins.includes(origin)) return cb(null, true);
      logger.warn({ origin }, 'cors_rejected');
      return cb(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: false,
  }));

  // §48 — liveness. No config, no secrets, no upstream calls: a health check
  // that fails because OpenRouter is slow tells the orchestrator to restart a
  // process that is working fine.
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mps-ai' }));

  // Capability discovery (§37). Names and summaries only — the endpoints they
  // map to are internal, and publishing them would just be a map of the ERP.
  app.get('/capabilities', (_req, res) => res.json({
    agents: ['client'],
    tools: listTools(),
  }));

  const rateLimited = {
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
  };

  // A per-IP backstop, in front of the token-keyed limiter.
  //
  // The token limiter below runs BEFORE authentication — it has to, since it is
  // middleware — so a caller presenting a fresh junk token on each request lands
  // in a fresh bucket every time and is never limited. Those requests do 401
  // without touching the ERP or a model, so the cost is small, but "small times
  // unbounded" is still unbounded. The ceiling is set well above the per-token
  // limit so a whole studio behind one NAT is not throttled as one person.
  const ipLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_IP_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimited,
  });

  // §45 — keyed by the caller's TOKEN rather than their IP, so one studio
  // behind one NAT is not rate-limited as a single user.
  //
  // Derived through requestToken.rateLimitKey rather than read off the
  // Authorization header directly. That distinction is not tidiness: the
  // browser authenticates with an httpOnly cookie through the frontend's
  // same-origin rewrite, so reading only the header made every real request
  // fall through to req.ip — and that IP is the frontend container. One bucket
  // for the whole studio, and nobody would have noticed until a busy morning.
  const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    message: rateLimited,
  });

  const router = createRouter({ config, provider });
  const agent = createClientAgent({
    erp,
    router,
    clock: clock || createStudioClock({ timeZone: config.STUDIO_TIMEZONE }),
    audit: audit || createAudit({ config }),
    budget: {
      maxPerResult: config.MAX_TOOL_RESULT_CHARS,
      maxTotal: config.MAX_CONTEXT_CHARS,
    },
    // Phase 7. Non-null flips the classifier's ragAvailable: policy questions
    // stop short-circuiting on "I don't have your policy documents" and start
    // retrieving through searchStudioKnowledge instead.
    //
    // Gated on config rather than always-on because it depends on an ERP that
    // carries GET /api/ai/knowledge/search. Enabling it against an ERP without
    // that route means every policy question spends a 404 to learn nothing —
    // which the agent reports honestly, but the honest answer was already
    // available for free with this off.
    knowledgeBase: config.AI_KNOWLEDGE_ENABLED
      ? { topK: config.AI_KNOWLEDGE_TOP_K }
      : null,
  });

  app.use('/ai/client-agent', ipLimiter, limiter, createClientAgentRouter({ agent }));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }));

  app.use((err, _req, res, _next) => {
    if (err && err.message === 'Origin not allowed') {
      return res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' } });
    }

    // body-parser failures are the CALLER's problem and must say so. Reporting
    // them as 500 tells a client the server broke and the request is worth
    // retrying — when the truth is that it will fail identically every time.
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
      });
    }
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
      return res.status(400).json({
        error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' },
      });
    }

    logger.error({ err: err?.message }, 'unhandled_error');
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  return app;
}

/** Wire the real collaborators. Split out so buildApp stays injectable. */
function buildAppFromConfig(config) {
  const erp = createErpClient({ config });
  const provider = createOpenRouterProvider({ config });
  return buildApp({ config, erp, provider });
}

module.exports = { buildApp, buildAppFromConfig };

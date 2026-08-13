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
const logger = require('./lib/logger');

function buildApp({ config, erp, provider, clock, audit }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '128kb' }));

  // §47 — an explicit allow-list. `credentials` stays off: the browser sends
  // the token in an Authorization header it sets itself, so this service never
  // needs cookies, and not accepting them removes CSRF from the threat model.
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

  // §45 — keyed by token rather than IP so one studio behind one NAT is not
  // rate-limited as a single user. The token is hashed into the key by
  // express-rate-limit's store, never logged.
  const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return typeof h === 'string' && h.length > 16 ? h.slice(-32) : req.ip;
    },
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
  });

  app.use('/ai/client-agent', ipLimiter, limiter, createClientAgentRouter({ agent }));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }));

  app.use((err, _req, res, _next) => {
    if (err && err.message === 'Origin not allowed') {
      return res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' } });
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

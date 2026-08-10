'use strict';
// Configuration, validated once at boot and never re-read.
//
// Fail-fast on purpose: a misconfigured AI service that starts and then 500s on
// every request is harder to diagnose than one that refuses to boot with the
// name of the missing variable. The ERP backend does the same for DATABASE_URL.
//
// ── What is deliberately ABSENT from this file ───────────────────────────────
//
// There is no JWT_SECRET and no DATABASE_URL, and adding either would undo the
// two security properties this whole service is built around:
//
//   1. No JWT_SECRET means this service CANNOT MINT A USER TOKEN. It can only
//      forward one the user already presented. Impersonation is therefore
//      impossible by construction rather than by policy — there is no code path
//      to review, because the key needed to sign a token is not here.
//
//   2. No DATABASE_URL means this service CANNOT REACH POSTGRES. Every fact it
//      states has to come back through an ERP endpoint that has already applied
//      tenantScope(). "The AI must never receive raw database credentials" is
//      not a rule someone has to remember; it is the absence of a connection
//      string.
//
// assertNoForbiddenSecrets() below turns both into a boot-time check, so if
// someone later copies the ERP's .env wholesale into this service — the
// realistic way this gets undone — the process refuses to start and says why.

const { z } = require('zod');

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ── AI provider ───────────────────────────────────────────────────────────
  // Provider is named rather than assumed so a second implementation can be
  // added without touching call sites. See platform/provider/index.js.
  AI_PROVIDER: z.enum(['openrouter']).default('openrouter'),
  AI_API_KEY: z.string().min(1, 'AI_API_KEY is required'),
  AI_PRIMARY_MODEL: z.string().min(1).default('openai/gpt-oss-120b:free'),
  AI_FALLBACK_MODEL: z.string().min(1).default('nvidia/nemotron-3-ultra-550b-a55b:free'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // ── ERP backend — the authority ───────────────────────────────────────────
  ERP_BACKEND_URL: z.string().url('ERP_BACKEND_URL must be an absolute URL'),
  ERP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Proves *this service* is calling. It does NOT identify a user — the
  // forwarded user JWT does that, and the ERP resolves identity from it.
  // Both are required; neither is sufficient alone.
  SERVICE_AUTH_SECRET: z.string().min(32, 'SERVICE_AUTH_SECRET must be at least 32 characters'),

  // ── HTTP ──────────────────────────────────────────────────────────────────
  // Comma-separated. No wildcard default: an authenticated API that reflects
  // any origin is a credential-forwarding hole, and §47 rules it out.
  ALLOWED_ORIGINS: z.string().default(''),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
});

/**
 * Secrets that must never reach this process. Presence means someone copied the
 * ERP's environment across, which would hand this service the two capabilities
 * its threat model says it must not have.
 */
const FORBIDDEN = ['JWT_SECRET', 'DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

function assertNoForbiddenSecrets(env) {
  const present = FORBIDDEN.filter((k) => env[k] != null && env[k] !== '');
  if (present.length) {
    throw new Error(
      `Refusing to start: ${present.join(', ')} must not be set for the AI service. `
      + 'It forwards the user\'s token and reads through the ERP API; it neither signs tokens '
      + 'nor connects to Postgres. See the header of src/config.js.',
    );
  }
}

function load(env = process.env) {
  assertNoForbiddenSecrets(env);

  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }

  const cfg = parsed.data;
  const allowedOrigins = cfg.ALLOWED_ORIGINS
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // In production an empty allow-list means no browser can call this service,
  // which is a silent outage. Say so at boot instead.
  if (cfg.NODE_ENV === 'production' && allowedOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must list at least one origin in production.');
  }
  if (allowedOrigins.includes('*')) {
    throw new Error('ALLOWED_ORIGINS must not contain "*" — this API is authenticated.');
  }

  return Object.freeze({ ...cfg, allowedOrigins });
}

module.exports = { load, Schema, FORBIDDEN, assertNoForbiddenSecrets };

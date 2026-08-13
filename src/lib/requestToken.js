'use strict';
// Where the end user's token comes from.
//
// Two sources, because there are two callers and they authenticate differently:
//
//   Authorization: Bearer <jwt>   server-to-server, curl, tests
//   Cookie: token=<jwt>           the browser
//
// The browser one is not a style preference. The frontend's cookie is httpOnly
// and sameSite:'strict', so JavaScript cannot read it to build a header, and a
// cross-site request would not carry it at all. That is why /ai/* is a
// same-origin Next.js rewrite rather than a direct call to this service — and
// why what arrives here is a Cookie header, not an Authorization one.
//
// Supporting only Bearer meant every request from the actual product was a 401.
//
// Whichever way it arrives, it is forwarded to the ERP as a Bearer. The ERP
// accepts both too (middleware/auth.js), so this service does not need to know
// or care which door the caller came through.
//
// ── Not a parser ─────────────────────────────────────────────────────────────
//
// No cookie library. One name is read, its value is not decoded beyond
// percent-encoding, and nothing here interprets the token — this service cannot
// verify a JWT and must not try. Adding cookie-parser to read a single value
// would put a dependency in the request path for no gain.

const COOKIE_NAME = 'token';

/** The value of one cookie, or null. Split-once so a `=` inside the value survives. */
function cookieValue(header, name) {
  if (typeof header !== 'string' || !header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;

    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;   // not percent-encoded; use it as written
    }
  }
  return null;
}

/**
 * The caller's token, or null.
 *
 * Header first: an explicit Authorization is a deliberate act, whereas a cookie
 * rides along on every request to the origin. If a caller troubles itself to
 * set a header, that is the identity it means to use.
 */
function tokenFrom(req) {
  const h = req.headers?.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) {
    const t = h.slice(7).trim();
    if (t) return t;
  }
  return cookieValue(req.headers?.cookie, COOKIE_NAME);
}

/**
 * A stable, non-identifying rate-limit key for this caller.
 *
 * Must be derived from the TOKEN rather than the header, and that is the whole
 * point of it living here. Keying on `req.headers.authorization` broke the
 * moment the browser started authenticating by cookie: every real request fell
 * through to `req.ip`, and because the browser reaches this service through the
 * frontend's rewrite, that IP is the frontend container. One bucket for the
 * entire studio.
 *
 * Falls back to the IP only when there is no token at all, which is a caller
 * that is about to be refused anyway.
 */
function rateLimitKey(req) {
  const token = tokenFrom(req);
  return token && token.length > 16 ? token.slice(-32) : req.ip;
}

module.exports = { tokenFrom, cookieValue, rateLimitKey, COOKIE_NAME };

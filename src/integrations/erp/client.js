'use strict';
// The only way out of this service to MY PT STUDIO data.
//
// Every read the agent performs goes through here, and every call carries TWO
// independent credentials that answer two different questions:
//
//   X-Service-Auth   — "is this the AI service?"   (shared secret, this service)
//   Authorization    — "who is asking?"            (the END USER's own JWT,
//                                                   forwarded verbatim)
//
// Neither is sufficient. The service secret proves the caller is us and not the
// open internet; it says nothing about which studio's data may be read. The
// user JWT is what the ERP's auth() middleware resolves into a user row, an
// organization_id and a role, and it is that resolution — not anything this
// file computes — which decides what comes back.
//
// ── Why forwarding, rather than the AI service holding its own identity ──────
//
// The ERP's JWT payload is `{ id, token_version }` and nothing else
// (routes/auth.js:229). Role, organisation and tenant are loaded from Postgres
// on every request by auth() (middleware/auth.js). So there is no authorisation
// information in the token for this service to read, act on, or get wrong —
// even if it wanted to. Forwarding is not a shortcut here; it is the only
// design in which the ERP stays the authority.
//
// Two consequences worth stating, because they are the security argument:
//
//   * This service has no JWT_SECRET (enforced at boot, src/config.js), so it
//     cannot mint a token for a different user. It can only relay one that was
//     already presented to it.
//   * token_version revocation keeps working. Log a user out everywhere and
//     their forwarded token dies at the ERP on the next call, with no cache to
//     invalidate here — because this service caches no identity at all.
//
// ── Client ids are not authorisation ─────────────────────────────────────────
//
// A clientId reaching this file came from the browser and is untrusted. It is
// passed to the ERP as a path parameter, and the ERP's orgWhere() answers 404
// when the client belongs to another organisation (pt-os.routes.js:1629-1635).
// This file never checks org itself, and must not start to: a second opinion
// about tenancy is a second thing to get out of step with the first.

const logger = require('../../lib/logger');

class ErpError extends Error {
  constructor(message, { status, code, endpoint }) {
    super(message);
    this.name = 'ErpError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }
}

/** Statuses the caller must see unchanged rather than have translated. */
const PASSTHROUGH_STATUS = new Set([401, 403, 404, 429]);

function createErpClient({ config, fetchImpl = globalThis.fetch }) {
  const base = config.ERP_BACKEND_URL.replace(/\/+$/, '');

  /**
   * GET an ERP endpoint as the end user.
   *
   * @param {string} path        e.g. '/api/pt-os/clients/abc/snapshot'
   * @param {object} opts
   * @param {string} opts.userToken  The end user's JWT, forwarded verbatim.
   * @param {string} [opts.requestId]
   */
  async function get(path, { userToken, requestId } = {}) {
    if (!userToken) {
      // Refusing here rather than calling unauthenticated: an unauthenticated
      // ERP call would 401 anyway, but the failure would look like an ERP
      // problem instead of a bug in how this service was invoked.
      throw new ErpError('No user token to forward', { status: 401, code: 'NO_USER_TOKEN', endpoint: path });
    }

    const url = `${base}${path}`;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.ERP_REQUEST_TIMEOUT_MS);

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          // The user's identity. The ERP resolves org and role from this.
          Authorization: `Bearer ${userToken}`,
          // This service's identity. Proves the call is not from the internet.
          'X-Service-Auth': config.SERVICE_AUTH_SECRET,
          'X-Request-Id': requestId || '',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      logger.warn({ endpoint: path, requestId, err: err?.message }, 'erp_request_failed');
      throw new ErpError(
        timedOut ? 'The MY PT STUDIO backend did not respond in time' : 'Could not reach the MY PT STUDIO backend',
        { status: timedOut ? 504 : 502, code: timedOut ? 'ERP_TIMEOUT' : 'ERP_UNREACHABLE', endpoint: path },
      );
    } finally {
      clearTimeout(timer);
    }

    const latency_ms = Date.now() - started;

    if (!res.ok) {
      // 401/403/404 are ANSWERS, not failures. "You may not see this client"
      // and "that client does not exist in your studio" are exactly what the
      // agent must relay — flattening them into a generic error would make the
      // assistant report an outage where the truth is an authorisation result.
      const status = PASSTHROUGH_STATUS.has(res.status) ? res.status : 502;
      logger.info({ endpoint: path, status: res.status, latency_ms, requestId }, 'erp_non_ok');
      throw new ErpError(`ERP responded ${res.status}`, {
        status,
        code: res.status === 404 ? 'NOT_FOUND' : res.status === 429 ? 'RATE_LIMITED' : 'ERP_DENIED',
        endpoint: path,
      });
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new ErpError('ERP returned a non-JSON body', { status: 502, code: 'ERP_BAD_BODY', endpoint: path });
    }

    logger.debug({ endpoint: path, latency_ms, requestId }, 'erp_ok');
    return { data: body, latency_ms };
  }

  return { get };
}

module.exports = { createErpClient, ErpError, PASSTHROUGH_STATUS };

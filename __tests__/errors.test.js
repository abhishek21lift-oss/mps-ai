'use strict';
// §30 — safe user-facing errors that still say something actionable.
//
// The distinctions being defended: 400, 401, 403 and 404 are four different
// answers, and only some of them are the caller's to fix. Collapsing them into
// one "not authorised" is the failure mode this covers — it sends a frontend
// author hunting a permissions bug when the real answer was "the session
// expired, sign in again".

const request = require('supertest');
const { fakeErp, okErp, appWith, post, fixedClock, configWith, ERP_ERR } = require('./helpers');

describe('status codes are distinct answers', () => {
  test('404 — a client outside your organisation', async () => {
    const { app } = appWith({ erp: fakeErp(async () => ERP_ERR(404)), clock: fixedClock() });
    const res = await post(app, { clientId: 'c-theirs', message: 'summary' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/not found, or not visible to you/i);
  });

  test('403 — refused, and the caller cannot fix it by re-authenticating', async () => {
    const { app } = appWith({ erp: fakeErp(async () => ERP_ERR(403)), clock: fixedClock() });
    const res = await post(app, { clientId: 'c-x', message: 'summary' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/not authorised/i);
    expect(res.body.error.message).not.toMatch(/sign in/i);
  });

  test('401 — an expired session says so, and is not reported as a permissions problem', async () => {
    const { app } = appWith({ erp: fakeErp(async () => ERP_ERR(401)), clock: fixedClock() });
    const res = await post(app, { clientId: 'c-1', message: 'summary' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.message).toMatch(/sign in again/i);
  });

  test('400 — a malformed client id is the caller\'s mistake, not a denial', async () => {
    const { app, erp } = appWith({ erp: okErp(), clock: fixedClock() });
    const res = await post(app, { clientId: '../../admin/all', message: 'summary' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    // Rejected at the edge — nothing reached the ERP.
    expect(erp.calls).toHaveLength(0);
  });

  test('a path-traversal id is refused at the registry too, not only at the edge', async () => {
    // The edge check is a convenience; the registry is the enforcement point.
    const { run } = require('../src/platform/tools/registry');
    const erp = fakeErp(async () => ({ data: {}, latency_ms: 1 }));

    const res = await run({ name: 'getClientSummary', args: { clientId: '../../x' }, erp, userToken: 't' });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.code).toBe('BAD_ARGS');
    expect(erp.calls).toHaveLength(0);
  });
});

describe('errors never leak internals', () => {
  test('an upstream failure does not expose the ERP host, path or exception', async () => {
    const { app } = appWith({
      erp: fakeErp(async () => {
        const e = new Error('connect ECONNREFUSED 10.0.0.7:5000 /api/pt-os/clients/c-1');
        e.status = 502;
        throw e;
      }),
      clock: fixedClock(),
    });

    const res = await post(app, { clientId: 'c-1', message: 'summary' });
    const body = JSON.stringify(res.body);

    expect(body).not.toContain('10.0.0.7');
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('/api/pt-os');
    expect(body).not.toMatch(/at .*\.js:\d+/);      // no stack frames
  });

  test('a model outage reads as temporary, not as a permissions problem', async () => {
    const provider = {
      name: 'fake',
      seen: [],
      generate: async () => { const e = new Error('down'); e.code = 'AI_UNREACHABLE'; throw e; },
    };
    const { app } = appWith({ erp: okErp(), provider, clock: fixedClock() });

    const res = await post(app, { clientId: 'c-1', message: 'summary' });

    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/temporarily unavailable/i);
  });
});

describe('§45 — rate limiting has a backstop below the token key', () => {
  test('the token-keyed limit still applies to one authenticated caller', async () => {
    const config = configWith({ RATE_LIMIT_MAX: '3', RATE_LIMIT_IP_MAX: '100' });
    const { app } = appWith({ erp: okErp(), config, clock: fixedClock() });

    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await post(app, { clientId: 'c-1', message: 'hi' }, 'one-token')).status);
    }

    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  test('rotating the token no longer buys an unlimited number of requests', async () => {
    // The gap this closes: the token-keyed limiter runs BEFORE authentication,
    // so a caller presenting a fresh junk token each time landed in a fresh
    // bucket every time and was never limited. Each such request 401s without
    // touching the ERP or a model — cheap, but unbounded.
    const config = configWith({ RATE_LIMIT_MAX: '1000', RATE_LIMIT_IP_MAX: '5' });
    const { app, erp } = appWith({ erp: okErp(), config, clock: fixedClock() });

    const codes = [];
    for (let i = 0; i < 12; i += 1) {
      codes.push(
        (await request(app)
          .post('/ai/client-agent/chat')
          .set('Authorization', `Bearer junk-token-number-${i}-padded-out-past-sixteen-chars`)
          .send({ clientId: 'c-1', message: 'hi' })).status,
      );
    }

    // Twelve attempts, a ceiling of five: the rest are refused.
    expect(codes.filter((c) => c !== 429)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);

    // And the refused ones never became upstream load. Each admitted request
    // makes two ERP reads (authorise, then the planned tool), so the bound is
    // per-request rather than per-call.
    const requests = new Set(erp.calls.map((c) => c.requestId));
    expect(requests.size).toBe(5);
  });

  test('the IP ceiling sits well above the per-token limit', () => {
    // A studio behind one NAT must not be throttled as though it were one
    // person; the backstop exists for floods, not for normal use.
    const config = configWith();
    expect(config.RATE_LIMIT_IP_MAX).toBeGreaterThan(config.RATE_LIMIT_MAX);
  });
});

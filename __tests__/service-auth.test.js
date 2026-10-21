'use strict';
// Audit P1-3 — the service-auth handshake, from boot to refusal.
//
// The secret has two halves that must match: mps-ai refuses to start without
// one, and the ERP refuses every forwarded call when its own copy is missing.
// The failure used to read as a generic outage ("temporarily unavailable"), so
// the point of these tests is that each half fails loudly and names itself.

const request = require('supertest');
const { buildApp } = require('../src/app');
const { load } = require('../src/config');
const { createErpClient } = require('../src/integrations/erp/client');

const BASE_ENV = {
  NODE_ENV: 'test',
  AI_API_KEY: 'test-key',
  ERP_BACKEND_URL: 'https://erp.example.test',
  SERVICE_AUTH_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: 'https://app.example.test',
};

const config = load(BASE_ENV);

function spyProvider() {
  const seen = [];
  return {
    seen,
    name: 'fake',
    generate: async ({ model }) => {
      seen.push({ model });
      return { content: 'Answer.', model: model || 'fake-model', usage: { prompt: 1, completion: 1 } };
    },
  };
}

const post = (app) => request(app).post('/ai/client-agent/chat')
  .set('Cookie', 'token=user-jwt-alpha')
  .send({ clientId: 'c-1', message: 'summary' });

describe('P1-3 — mps-ai refuses to boot without a usable secret', () => {
  test('a missing SERVICE_AUTH_SECRET is a boot error, not a first-request error', () => {
    const { SERVICE_AUTH_SECRET, ...withoutSecret } = BASE_ENV;
    expect(SERVICE_AUTH_SECRET).toBeTruthy();
    expect(() => load(withoutSecret)).toThrow(/SERVICE_AUTH_SECRET/);
  });

  test('a short secret is refused at boot', () => {
    expect(() => load({ ...BASE_ENV, SERVICE_AUTH_SECRET: 'too-short' }))
      .toThrow(/at least 32 characters/);
  });
});

describe('P1-3 — the ERP names a half-configured deploy, and so do we', () => {
  /** A fetch that answers like the ERP's serviceAuth middleware with no secret. */
  const halfConfiguredErp = () => createErpClient({
    config,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({
        error: {
          code: 'SERVICE_AUTH_NOT_CONFIGURED',
          message: 'Service authentication is not configured on this server.',
        },
      }),
    }),
  });

  test('the ERP body code survives the transport instead of becoming ERP_DENIED', async () => {
    await expect(halfConfiguredErp().get('/api/pt-os/clients/c-1', { userToken: 't' }))
      .rejects.toMatchObject({ code: 'SERVICE_AUTH_NOT_CONFIGURED' });
  });

  test('a turn is refused with that code and a message naming the backend', async () => {
    const provider = spyProvider();
    const app = buildApp({ config, erp: halfConfiguredErp(), provider });
    const res = await post(app);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_AUTH_NOT_CONFIGURED');
    expect(res.body.error.message).toMatch(/not authorised by the backend/i);
    expect(provider.seen).toHaveLength(0);
  });

  test('an ordinary ERP 503 is still ERP_DENIED — the new code is not a catch-all', async () => {
    const erp = createErpClient({
      config,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: { code: 'SOMETHING_ELSE', message: 'down' } }),
      }),
    });

    await expect(erp.get('/api/features', { userToken: 't' }))
      .rejects.toMatchObject({ code: 'ERP_DENIED' });
  });

  test('a non-JSON error body does not break the mapping', async () => {
    const erp = createErpClient({
      config,
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        json: async () => { throw new Error('not json'); },
      }),
    });

    await expect(erp.get('/api/features', { userToken: 't' }))
      .rejects.toMatchObject({ code: 'ERP_DENIED' });
  });
});

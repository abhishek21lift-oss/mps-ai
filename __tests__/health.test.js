'use strict';
// /health is the deploy gate (deploy/deploy-ai.sh): it must answer without
// config, auth or upstream calls, and it must name the commit it serves so a
// healthy-but-old container cannot be mistaken for a successful deploy.

const request = require('supertest');
const { buildApp } = require('../src/app');
const { load } = require('../src/config');

const config = load({
  NODE_ENV: 'test',
  AI_API_KEY: 'test-key',
  ERP_BACKEND_URL: 'https://erp.example.test',
  SERVICE_AUTH_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: 'https://app.example.test',
});

const originalSha = process.env.GIT_SHA;

afterEach(() => {
  if (originalSha === undefined) delete process.env.GIT_SHA;
  else process.env.GIT_SHA = originalSha;
});

test('health answers without auth and reports the baked commit', async () => {
  process.env.GIT_SHA = 'a0bf02bde67ecedc426f5fe70c5aab3017ce0113';
  const app = buildApp({ config, erp: {}, provider: {} });

  const res = await request(app).get('/health');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    status: 'ok',
    service: 'mps-ai',
    sha: 'a0bf02bde67ecedc426f5fe70c5aab3017ce0113',
  });
});

test('health reports "unknown" when the image was built without a sha', async () => {
  delete process.env.GIT_SHA;
  const app = buildApp({ config, erp: {}, provider: {} });

  const res = await request(app).get('/health');

  expect(res.status).toBe(200);
  expect(res.body.sha).toBe('unknown');
});

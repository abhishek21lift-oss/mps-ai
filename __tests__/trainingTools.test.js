'use strict';
// The training-depth tools.
//
// These are the first tools that pass the client as a QUERY parameter rather
// than a path segment — the ERP's shape for them, not a choice made here — so
// they are also the first chance to get the tenant boundary wrong in a new way.
// Most of what follows checks that nothing about the boundary changed.

const { run, get } = require('../src/platform/tools/registry');
const { fakeErp, appWith, post, fixedClock, ERP_ERR } = require('./helpers');

describe('endpoint construction', () => {
  test('analytics builds a bounded, encoded query', () => {
    const tool = get('getClientTrainingAnalytics');
    expect(tool.endpoint({ clientId: 'c-1', weeks: 8 }))
      .toBe('/api/pt-os/workout-log/analytics?client_id=c-1&weeks=8');
  });

  test('volume summary passes the ERP\'s own parameter name', () => {
    const tool = get('getClientVolumeSummary');
    expect(tool.endpoint({ clientId: 'c-1', groupBy: 'month' }))
      .toBe('/api/pt-os/workout-log/volume-summary?client_id=c-1&group_by=month');
  });

  test('defaults are applied rather than left undefined in the URL', async () => {
    const erp = fakeErp(async () => ({ data: {}, latency_ms: 1 }));

    await run({ name: 'getClientTrainingAnalytics', args: { clientId: 'c-1' }, erp, userToken: 't' });
    await run({ name: 'getClientVolumeSummary', args: { clientId: 'c-1' }, erp, userToken: 't' });

    expect(erp.calls[0].path).toBe('/api/pt-os/workout-log/analytics?client_id=c-1&weeks=12');
    expect(erp.calls[1].path).toBe('/api/pt-os/workout-log/volume-summary?client_id=c-1&group_by=week');
    for (const c of erp.calls) expect(c.path).not.toMatch(/undefined|null|NaN/);
  });
});

describe('arguments are validated before a URL exists', () => {
  test.each([
    ['traversal id', { clientId: '../../admin', weeks: 4 }],
    ['query smuggling in the id', { clientId: 'c-1&organization_id=17', weeks: 4 }],
    ['weeks out of range', { clientId: 'c-1', weeks: 999 }],
    ['weeks not a number', { clientId: 'c-1', weeks: 'DROP TABLE' }],
    ['negative weeks', { clientId: 'c-1', weeks: -1 }],
  ])('%s is rejected', async (_label, args) => {
    const erp = fakeErp(async () => ({ data: {}, latency_ms: 1 }));
    const res = await run({ name: 'getClientTrainingAnalytics', args, erp, userToken: 't' });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('BAD_ARGS');
    expect(res.status).toBe(400);
    expect(erp.calls).toHaveLength(0);
  });

  test('an unknown group_by is refused rather than passed through', async () => {
    const erp = fakeErp(async () => ({ data: {}, latency_ms: 1 }));
    const res = await run({
      name: 'getClientVolumeSummary',
      args: { clientId: 'c-1', groupBy: 'year; DROP TABLE workout_sets' },
      erp,
      userToken: 't',
    });

    expect(res.ok).toBe(false);
    expect(erp.calls).toHaveLength(0);
  });
});

describe('the tenant boundary is unchanged by the new shape', () => {
  test('a client outside the caller\'s organisation still 404s', async () => {
    // The ERP calls clientInOrg() on this route and answers 404 exactly as the
    // by-id routes do. A query parameter is not a weaker boundary here — it is
    // the same boundary, checked in the same place.
    const erp = fakeErp(async () => ERP_ERR(404));
    const res = await run({
      name: 'getClientTrainingAnalytics', args: { clientId: 'c-theirs' }, erp, userToken: 't',
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.message).toMatch(/not found, or not visible to you/i);
  });

  test('the caller\'s own token is what the read is made with', async () => {
    const erp = fakeErp(async () => ({ data: {}, latency_ms: 1 }));
    await run({ name: 'getClientVolumeSummary', args: { clientId: 'c-1' }, erp, userToken: 'my-token' });

    expect(erp.calls[0].userToken).toBe('my-token');
  });

  test('no as_of is sent — the ERP keeps the only opinion about today', () => {
    // Two ideas of "today" inside one request is the same class of bug as two
    // ideas of the active tenant.
    const path = get('getClientTrainingAnalytics').endpoint({ clientId: 'c-1', weeks: 12 });
    expect(path).not.toMatch(/as_of/);
  });
});

describe('the planner reaches for them on the questions they answer', () => {
  const { planTools } = require('../src/agents/client/planner');

  test.each([
    'Is he getting stronger?',
    'What is his bench PR?',
    'How much load is he lifting now?',
  ])('strength question routes to analytics: %s', (msg) => {
    expect(planTools(msg).tools).toContain('getClientTrainingAnalytics');
  });

  test.each([
    'What is his training volume this month?',
    'How much work is he doing?',
  ])('volume question routes to the summary: %s', (msg) => {
    expect(planTools(msg).tools).toContain('getClientVolumeSummary');
  });

  test.each([
    'Is any muscle group being neglected?',
    'Is he overtraining?',
    'When did he last train legs?',
  ])('coverage and recovery route to analytics: %s', (msg) => {
    expect(planTools(msg).tools).toContain('getClientTrainingAnalytics');
  });

  test('a question about payments does not drag the workout log along', () => {
    // Data minimisation: a dues question must not ship the training history.
    const { tools } = planTools('What is his outstanding balance?');
    expect(tools).not.toContain('getClientTrainingAnalytics');
    expect(tools).not.toContain('getClientVolumeSummary');
  });
});

describe('end to end', () => {
  test('the retrieved analytics reach the model, fenced', async () => {
    const analytics = {
      attendance: { planned: 24, completed: 19 },
      strength: [{ exercise: 'Bench Press', est_1rm_change_kg: 7.5 }],
      days_since_trained: { legs: 11 },
    };

    const erp = fakeErp(async (path) => {
      if (path.includes('/workout-log/analytics')) return { data: { data: analytics }, latency_ms: 1 };
      return { data: { data: { name: 'Rahul' } }, latency_ms: 1 };
    });
    const { app, provider } = appWith({ erp, clock: fixedClock() });

    const res = await post(app, { clientId: 'c-1', message: 'Is he getting stronger?' });

    expect(res.status).toBe(200);
    expect(res.body.toolsUsed).toContain('getClientTrainingAnalytics');

    const ctx = provider.seen[0].messages.find((m) => m.content.includes('RETRIEVED DATA'));
    expect(ctx.content).toContain('7.5');
    expect(ctx.content).toContain('training analytics');
  });

  test('an unavailable log is reported, not filled in', async () => {
    const erp = fakeErp(async (path) => {
      if (path.includes('/workout-log/')) { const e = new Error('x'); e.status = 500; throw e; }
      return { data: { data: { name: 'Rahul' } }, latency_ms: 1 };
    });
    const { app } = appWith({ erp, clock: fixedClock() });

    const res = await post(app, { clientId: 'c-1', message: 'Is he getting stronger?' });

    expect(res.status).toBe(200);
    expect(res.body.toolsUnavailable.map((t) => t.tool)).toContain('getClientTrainingAnalytics');
  });

  test('the tools stay read-only and single-client', () => {
    const { list } = require('../src/platform/tools/registry');
    const names = list().map((t) => t.name);

    expect(names).toContain('getClientTrainingAnalytics');
    expect(names).toContain('getClientVolumeSummary');
    for (const n of names) expect(n).toMatch(/^getClient/);
  });
});

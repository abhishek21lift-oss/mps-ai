'use strict';
// §24, §44 — a client's data volume must not set the size of the prompt.
//
// The gap these close: `JSON.stringify(erpResponse)` went into the context with
// nothing between it and the model. maxTokens caps the COMPLETION; the INPUT was
// bounded only by how long a client had been a member.
//
// The assertions care as much about the ANNOUNCEMENT as the cut. Silently
// handing over the first 6,000 characters of an attendance history and asking
// "how many sessions did they miss?" yields a confident, precise, wrong number:
// the model counts what it was given and cannot know it received a prefix.

const { truncate, applyBudget } = require('../src/platform/limits');
const { buildContext, newFenceId } = require('../src/platform/context/untrusted');
const { fakeErp, appWith, post, contextOf, fixedClock, configWith } = require('./helpers');

describe('truncate', () => {
  test('leaves text under the cap untouched', () => {
    const r = truncate('short', 100);
    expect(r).toMatchObject({ text: 'short', truncated: false, originalChars: 5 });
  });

  test('cuts to the cap and reports the original size', () => {
    const r = truncate('x'.repeat(500), 100);
    expect(r.truncated).toBe(true);
    expect(r.keptChars).toBeLessThanOrEqual(100);
    expect(r.originalChars).toBe(500);
  });

  test('prefers a line boundary so a JSON row is not halved', () => {
    const text = `${'a'.repeat(80)}\n${'b'.repeat(80)}`;
    const r = truncate(text, 100);
    expect(r.text).toBe('a'.repeat(80));
    expect(r.text.endsWith('\n')).toBe(false);
  });

  test('ignores a line boundary that would waste most of the budget', () => {
    // Newline at index 5 of a 100-char budget: honouring it would throw away
    // 95% of what could have been sent.
    const text = `head\n${'c'.repeat(500)}`;
    const r = truncate(text, 100);
    expect(r.keptChars).toBeGreaterThan(90);
  });
});

describe('applyBudget', () => {
  const big = (n) => ({ tool: `t${n}`, label: `l${n}`, data: 'z'.repeat(5000) });

  test('caps each result individually', () => {
    const { kept } = applyBudget([big(1)], { maxPerResult: 1000, maxTotal: 10_000 });
    expect(kept[0].truncated).toBe(true);
    expect(kept[0].keptChars).toBeLessThanOrEqual(1000);
    expect(kept[0].originalChars).toBeGreaterThan(4900);
  });

  test('enforces a total across results, dropping what will not fit', () => {
    const { kept, dropped, usedChars } = applyBudget(
      [big(1), big(2), big(3)],
      { maxPerResult: 2000, maxTotal: 3000 },
    );

    expect(usedChars).toBeLessThanOrEqual(3000);
    // Nothing is silently lost: what did not fit is named.
    expect(kept.length + dropped.length).toBe(3);
    expect(dropped.length).toBeGreaterThan(0);
  });

  test('order is priority — the first result gets the budget', () => {
    const { kept } = applyBudget(
      [{ tool: 'profile', label: 'p', data: 'a'.repeat(100) }, big(2)],
      { maxPerResult: 5000, maxTotal: 200 },
    );
    expect(kept[0].tool).toBe('profile');
    expect(kept[0].truncated).toBe(false);
  });

  test('a small result is untouched and reports no truncation', () => {
    const { kept } = applyBudget(
      [{ tool: 't', label: 'l', data: { weight: 78.4 } }],
      { maxPerResult: 6000, maxTotal: 24_000 },
    );
    expect(kept[0].truncated).toBe(false);
    expect(kept[0].body).toContain('78.4');
  });
});

describe('the model is told what it could not see', () => {
  const fenceId = newFenceId();

  test('a truncated block is labelled inside its own fence', () => {
    const ctx = buildContext(
      [{ tool: 'getClientAttendance', label: 'attendance', data: 'row\n'.repeat(5000) }],
      fenceId,
      { maxPerResult: 500, maxTotal: 5000 },
    );

    expect(ctx.truncated).toEqual(['getClientAttendance']);
    expect(ctx.text).toContain('truncated="true"');
    expect(ctx.text).toContain('[TRUNCATED');
    expect(ctx.text).toMatch(/do not state totals, counts/i);

    // The caveat sits INSIDE the fence, so it cannot be separated from the data
    // it qualifies.
    const openIdx = ctx.text.indexOf('<untrusted-data');
    const caveatIdx = ctx.text.indexOf('[TRUNCATED');
    const closeIdx = ctx.text.indexOf('</untrusted-data');
    expect(openIdx).toBeLessThan(caveatIdx);
    expect(caveatIdx).toBeLessThan(closeIdx);
  });

  test('a dropped tool is named rather than silently omitted', () => {
    const ctx = buildContext(
      [
        { tool: 'a', label: 'a', data: 'x'.repeat(400) },
        { tool: 'getClientPayments', label: 'payments', data: 'y'.repeat(400) },
      ],
      fenceId,
      { maxPerResult: 400, maxTotal: 400 },
    );

    expect(ctx.dropped).toContain('getClientPayments');
    expect(ctx.text).toContain('[NOT INCLUDED: getClientPayments');
    expect(ctx.text).toMatch(/say you could not review it/i);
  });

  test('an untruncated block carries no caveat and no truncated attribute', () => {
    const ctx = buildContext(
      [{ tool: 't', label: 'l', data: { ok: true } }],
      fenceId,
      { maxPerResult: 6000, maxTotal: 24_000 },
    );
    expect(ctx.truncated).toEqual([]);
    expect(ctx.text).not.toContain('truncated="true"');
    expect(ctx.text).not.toContain('[TRUNCATED');
  });
});

describe('end to end — a client with an enormous history', () => {
  test('the prompt stays bounded and the truncation is announced', async () => {
    // 400 KB of attendance, the shape of a four-year member.
    const huge = Array.from({ length: 4000 }, (_, i) => ({
      date: `2026-01-${(i % 28) + 1}`, status: 'present', note: 'z'.repeat(80),
    }));

    const erp = fakeErp(async (path) => {
      if (path.endsWith('/attendance')) return { data: huge, latency_ms: 1 };
      if (path.endsWith('/snapshot')) return { data: { weight: 78.4 }, latency_ms: 1 };
      return { data: { data: { name: 'Rahul' } }, latency_ms: 1 };
    });

    const config = configWith({ MAX_TOOL_RESULT_CHARS: '4000', MAX_CONTEXT_CHARS: '10000' });
    const { app, provider } = appWith({ erp, config, clock: fixedClock() });

    const res = await post(app, { clientId: 'c-1', message: 'How is his attendance?' });

    expect(res.status).toBe(200);

    const ctx = contextOf(provider);
    expect(ctx).toBeDefined();
    // Bounded by config, not by how long the client has been a member.
    expect(ctx.content.length).toBeLessThan(14_000);
    expect(ctx.content).toContain('truncated="true"');
    expect(ctx.content).toMatch(/this is a partial extract/i);
  });

  test('config refuses a per-result cap larger than the total', () => {
    expect(() => configWith({ MAX_TOOL_RESULT_CHARS: '50000', MAX_CONTEXT_CHARS: '10000' }))
      .toThrow(/must not exceed/i);
  });
});

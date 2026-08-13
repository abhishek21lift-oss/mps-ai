'use strict';
// Checking the answer's figures against the records they came from.
//
// Two failure directions, and they are not symmetric:
//
//   A FALSE ALARM — flagging a correct figure — is the expensive one. An
//   indicator that cries wolf on good answers gets ignored within a week, and
//   then catches nothing. Most of what follows guards that direction.
//
//   A MISS — a fabricated small integer that happens to appear somewhere in a
//   JSON payload — costs one uncaught case and is the direction to fail in.
//   Asserted explicitly at the bottom, so it is a documented property rather
//   than a surprise.

const { checkGrounding, extractFigures } = require('../src/platform/grounding/check');
const { fakeErp, appWith, post, postStream, parseSse, fakeStreamProvider, fixedClock } = require('./helpers');

const SOURCES = [
  { data: { name: 'Rahul Sharma', weight: 78.4, balance_amount: 4200, pt_end_date: '2026-09-01' } },
  { data: [{ amount: 6000 }, { amount: 6000 }, { amount: 6000 }] },
  { data: [{ date: '2026-08-01', status: 'present' }, { date: '2026-08-03', status: 'present' }] },
];

const check = (answer, sources = SOURCES) => checkGrounding({ answer, sources });

describe('extraction', () => {
  test('finds figures with their line and surrounding text', () => {
    const figs = extractFigures('Weight is 78.4 kg.\nBalance ₹4,200.');
    expect(figs).toHaveLength(2);
    expect(figs[0]).toMatchObject({ value: 78.4, line: 1 });
    expect(figs[0].context).toBe('Weight is 78.4 kg.');
    expect(figs[1]).toMatchObject({ value: 4200, line: 2 });
  });

  test('thousands separators and currency are parsed, not treated as text', () => {
    expect(extractFigures('₹18,000 total').map((f) => f.value)).toEqual([18000]);
    expect(extractFigures('Rs. 1,25,000').map((f) => f.value)).toEqual([125000]);
  });

  test('an ISO date is one figure, not three', () => {
    // Split into 2026 / 08 / 13, each part would match something incidental and
    // the date itself would never actually be checked.
    const figs = extractFigures('Expires 2026-09-01.');
    expect(figs).toHaveLength(1);
    expect(figs[0].text).toBe('2026-09-01');
  });

  test('numbers inside identifiers are not figures', () => {
    expect(extractFigures('See section v1.2 and h2 heading')).toHaveLength(0);
  });

  test('percentages keep their sign', () => {
    expect(extractFigures('Attendance 75%')[0]).toMatchObject({ value: 75, percent: true });
  });
});

describe('figures that are really in the data', () => {
  test('a verbatim value verifies', () => {
    expect(check('His weight is 78.4 kg.')).toMatchObject({ checked: 1, inSource: 1, unverified: 0 });
  });

  test('formatting differences do not matter', () => {
    // 4200 in the record, "₹4,200" in the answer.
    expect(check('Balance ₹4,200.')).toMatchObject({ inSource: 1, unverified: 0 });
  });

  test('a date present in the records verifies', () => {
    expect(check('Package ends 2026-09-01.')).toMatchObject({ inSource: 1, unverified: 0 });
  });

  test('a numeric string in the payload counts as a source value', () => {
    // This ERP stores money as "4500.00" in places.
    const r = check('Balance is 4500.', [{ data: { balance: '4500.00' } }]);
    expect(r.unverified).toBe(0);
  });
});

describe('figures the model worked out', () => {
  test('a column total is derived, not fabricated', () => {
    // ₹18,000 appears in no record — it is the sum of three payments.
    expect(check('He has paid ₹18,000 in total.')).toMatchObject({ derived: 1, unverified: 0 });
  });

  test('a count of records is derived', () => {
    expect(check('There are 2 attendance records.')).toMatchObject({ derived: 1, unverified: 0 });
  });

  test('a percentage is derived, however it was rounded', () => {
    // 2 of 3 is 66.666…; a model writes 66.7% or 67%, never the full expansion.
    for (const written of ['66.7%', '67%', '66.67%']) {
      expect(check(`Attendance is ${written}.`).unverified).toBe(0);
    }
  });

  test('a rounded measurement is derived', () => {
    expect(check('He weighs about 78 kg.')).toMatchObject({ unverified: 0 });
  });

  test('a difference between two values is derived', () => {
    const r = check('He is 1,800 short of the total.', [{ data: { paid: 4200, due: 6000 } }]);
    expect(r.unverified).toBe(0);
  });
});

describe('figures that are not accounted for', () => {
  test('a fabricated balance is reported, with where it was said', () => {
    const r = check('His outstanding balance is ₹4,500.');

    expect(r).toMatchObject({ checked: 1, inSource: 0, derived: 0, unverified: 1 });
    expect(r.figures[0]).toMatchObject({ text: '₹4,500', value: 4500, line: 1 });
    expect(r.figures[0].context).toContain('outstanding balance');
  });

  test('a fabricated date is reported', () => {
    const r = check('His package expires on 2027-01-15.');
    expect(r.unverified).toBe(1);
    expect(r.figures[0].text).toBe('2027-01-15');
  });

  test('only the unaccounted-for figures are listed', () => {
    const r = check('Weight 78.4 kg, balance ₹4,200, and 9,999 sessions.');
    expect(r.checked).toBe(3);
    expect(r.unverified).toBe(1);
    expect(r.figures).toHaveLength(1);
    expect(r.figures[0].value).toBe(9999);
  });

  test('the line number points at the right line of a multi-line answer', () => {
    const r = check('FACT — weight is 78.4 kg.\nINTERPRETATION — good.\nHe owes ₹7,777.');
    expect(r.figures[0].line).toBe(3);
  });
});

describe('it never breaks the answer', () => {
  test('no sources at all does not throw', () => {
    expect(() => check('He weighs 78.4 kg.', [])).not.toThrow();
    expect(check('He weighs 78.4 kg.', []).unverified).toBe(1);
  });

  test('an answer with no figures is vacuously clean', () => {
    expect(check('He is progressing well.')).toMatchObject({ checked: 0, unverified: 0, figures: [] });
  });

  test('awkward payloads are walked without error', () => {
    const nasty = [null, undefined, { a: { b: { c: [1, 2, { d: 'x' }] } } }, [[[]]], 'plain string'];
    expect(() => check('Value 5.', nasty)).not.toThrow();
  });

  test('a huge payload does not attempt the quadratic search', () => {
    // Above the pairwise bound only direct and single-value derivations run,
    // so this must stay fast rather than becoming a latency problem.
    const big = [{ data: Array.from({ length: 5000 }, (_, i) => ({ v: i })) }];
    const t0 = Date.now();
    const r = check('A figure of 987654321.', big);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.unverified).toBe(1);
  });
});

describe('the documented blind spot', () => {
  test('a small integer finds an incidental match and is NOT flagged', () => {
    // "3" appears in almost any payload. This is a MISS, and it is the safe
    // direction to fail in — recorded as a property rather than left to be
    // discovered as a surprise.
    const r = check('He has 3 sessions left.', [{ data: { a: 1, b: 2, c: 3 } }]);
    expect(r.unverified).toBe(0);
  });

  test('but a precise figure has nowhere to hide', () => {
    const r = check('He has 47.3 kg to lose.', [{ data: { a: 1, b: 2, c: 3 } }]);
    expect(r.unverified).toBe(1);
  });
});

describe('end to end', () => {
  const erpWith = (snapshot) => fakeErp(async (path) => (path.endsWith('/snapshot')
    ? { data: snapshot, latency_ms: 1 }
    : { data: { data: { name: 'Rahul Sharma', balance_amount: 4200 } }, latency_ms: 1 }));

  const providerSaying = (content) => ({
    name: 'fake',
    seen: [],
    generate: async () => ({ content, model: 'm', usage: { prompt: 1, completion: 1 }, latency_ms: 1 }),
    generateStream: async function* () {
      yield { type: 'delta', text: content };
      yield { type: 'done', model: 'm', usage: { prompt: 1, completion: 1 } };
    },
  });

  test('the JSON route reports a fabricated figure', async () => {
    const { app } = appWith({
      erp: erpWith({ weight: 78.4 }),
      provider: providerSaying('His balance is ₹9,900.'),
      clock: fixedClock(),
    });

    const res = await post(app, { clientId: 'c-1', message: 'What is his balance?' });

    expect(res.status).toBe(200);
    expect(res.body.grounding).toMatchObject({ checked: 1, unverified: 1 });
    expect(res.body.grounding.figures[0].value).toBe(9900);
  });

  test('a correct answer comes back clean', async () => {
    // A summary question, deliberately: "what is his balance?" plans only the
    // profile and payments, so an answer quoting a WEIGHT would be flagged —
    // correctly, since nothing retrieved it. The check sees what the tools
    // actually returned, not what the client record contains in principle.
    const { app } = appWith({
      erp: erpWith({ weight: 78.4 }),
      provider: providerSaying('He weighs 78.4 kg and owes ₹4,200.'),
      clock: fixedClock(),
    });

    const res = await post(app, { clientId: 'c-1', message: 'Summarize this client' });

    expect(res.body.grounding).toMatchObject({ checked: 2, unverified: 0, figures: [] });
  });

  test('a figure from data the question never retrieved is flagged', () => {
    // The property the test above depends on, asserted directly: grounding is
    // against what was RETRIEVED this turn, not against the record in the
    // abstract. A weight nobody looked up is unaccounted for.
    const r = check('He weighs 78.4 kg.', [{ data: { name: 'Rahul', balance_amount: 4200 } }]);
    expect(r.unverified).toBe(1);
  });

  test('the streamed done event carries it too', async () => {
    const { app } = appWith({
      erp: erpWith({ weight: 78.4 }),
      provider: providerSaying('His balance is ₹9,900.'),
      clock: fixedClock(),
    });

    const res = await postStream(app, { clientId: 'c-1', message: 'What is his balance?' });
    const done = parseSse(res.text).at(-1);

    expect(done.data.grounding).toMatchObject({ unverified: 1 });
  });

  test('a checker failure costs the indicator, never the answer', async () => {
    // The answer is the product; this is commentary on it. A bug here must not
    // be able to turn a good answer into a 500.
    const { app } = appWith({
      erp: erpWith({ weight: 78.4 }),
      provider: providerSaying('He weighs 78.4 kg.'),
      clock: fixedClock(),
    });

    const mod = require('../src/platform/grounding/check');
    const original = mod.checkGrounding;
    Object.defineProperty(mod, 'checkGrounding', {
      value: () => { throw new Error('boom'); }, configurable: true, writable: true,
    });

    try {
      const res = await post(app, { clientId: 'c-1', message: 'weight?' });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('He weighs 78.4 kg.');
    } finally {
      Object.defineProperty(mod, 'checkGrounding', {
        value: original, configurable: true, writable: true,
      });
    }
  });

  test('short-circuited turns carry no grounding block', async () => {
    // No model wrote them and no records were read; there is nothing to check.
    const { app } = appWith({
      erp: erpWith({}), provider: fakeStreamProvider(), clock: fixedClock(),
    });

    const res = await post(app, { clientId: 'c-1', message: 'thanks' });
    expect(res.body.grounding).toBeUndefined();
  });
});

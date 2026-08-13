'use strict';
// Which tools a question reaches for.
//
// This suite exists because the planner was badly broken for a long time and
// nothing noticed. Every rule ended in `\b`, which meant no rule matched an
// inflected word: `\bpayment\b` misses "payments", `\bsummar\b` matches neither
// "summary" nor "summarize", `\bgoal\b` misses "goals". Twenty of twenty-six
// realistic trainer questions fell through to the default.
//
// It hid because the default — snapshot plus profile — is a plausible answer to
// almost anything, so nothing ever looked wrong. The real cost was not a
// suboptimal tool choice. "Any injuries?" never fetched the training brief, so
// the agent truthfully reported having no injury data about a client whose
// record contained some. A false "I don't have that information" is precisely
// what the grounding rules exist to prevent, arriving through the retrieval
// layer rather than the model.
//
// So the assertions below are mostly about INFLECTIONS, and there is a
// deliberate false-positive section: broadening a pattern is how you fix a miss
// and cause three others.

const { planTools, planIntent, DEFAULT_TOOLS, MAX_TOOLS } = require('../src/agents/client/planner');

const toolsFor = (q) => planTools(q).tools;
const matched = (q) => planTools(q).matched;

describe('inflections reach the same rule as the stem', () => {
  test.each([
    ['Summarize this client', 'getClientSummary'],
    ['Give me a summary', 'getClientSummary'],
    ['What are their goals?', 'getClientSummary'],
    ['What is their goal?', 'getClientSummary'],
    ['What payments has he made?', 'getClientPayments'],
    ['Show me his payments', 'getClientPayments'],
    ['When do his packages expire?', 'getClientSubscriptions'],
    ['What is his expiry date?', 'getClientSubscriptions'],
    ['Has he renewed?', 'getClientRenewals'],
    ['Renewals?', 'getClientRenewals'],
    ['Any injuries?', 'getClientTrainingBrief'],
    ['Does he have an injury?', 'getClientTrainingBrief'],
    ['How many sessions has he done?', 'getClientTrainingBrief'],
    ['What exercises is he doing?', 'getClientTrainingBrief'],
    ['What programmes is he on?', 'getClientTrainingBrief'],
    ['Show his measurements', 'getClientSummary'],
    ['Any communications logged?', 'getClientCommunication'],
    ['Is he attending?', 'getClientAttendance'],
    ['Any pains?', 'getClientTrainingBrief'],
    ['His subscriptions?', 'getClientSubscriptions'],
    ['What are his targets?', 'getClientSummary'],
  ])('%s → %s', (question, tool) => {
    expect(matched(question)).toBe(true);
    expect(toolsFor(question)).toContain(tool);
  });
});

describe('the frontend\'s starter questions all map to a rule', () => {
  // Mirrored from 619-erp-frontend, src/lib/client-ai.ts → SUGGESTED_QUESTIONS.
  // That file states the coupling as a fact — "every one of these maps to a
  // rule in the service's planner, so each returns a grounded answer rather
  // than a shrug" — and at the time this suite was written, two of them did
  // not. A claim made in another repo about this one is worth an assertion
  // here, because that is where it can actually be checked.
  const SUGGESTED = [
    'Summarize this client',
    'How is their progress?',
    'What are their goals?',
    'Show recent attendance',
    'When does their package expire?',
    'What should I focus on next session?',
  ];

  test.each(SUGGESTED)('%s', (question) => {
    expect(matched(question)).toBe(true);
  });

  test('none of them is a short-circuit either', () => {
    // A question offered as a button must reach the tools, not a canned
    // "this assistant covers one client at a time".
    const { classify } = require('../src/platform/intent/classifier');
    for (const q of SUGGESTED) expect(classify(q).shortCircuit).toBe(false);
  });
});

describe('broadening did not create false positives', () => {
  test('"during" is not a money question', () => {
    // `due\w*` would swallow it. `due` is matched exactly for this reason.
    expect(toolsFor('What is he doing during the session?')).not.toContain('getClientPayments');
  });

  test('an outstanding balance does not drag in the workout log', () => {
    // `balanc\w*` matches "balance" as well as "balanced" — so the muscle
    // coverage rule uses `balanced` exactly.
    const tools = toolsFor('What is his outstanding balance?');
    expect(tools).toContain('getClientPayments');
    expect(tools).not.toContain('getClientTrainingAnalytics');
  });

  test('a payments question does not fetch training data', () => {
    const tools = toolsFor('Show me his payments');
    expect(tools).not.toContain('getClientTrainingAnalytics');
    expect(tools).not.toContain('getClientVolumeSummary');
  });

  test('a renewal-date question does not fetch medical notes', () => {
    // Data minimisation is the whole reason planning is deterministic: the
    // cheapest way not to leak a field is not to retrieve it.
    expect(toolsFor('When does their package expire?')).not.toContain('getClientTrainingBrief');
  });
});

describe('the default is still a real safety net', () => {
  test('an unanticipated phrasing retrieves rather than refusing', () => {
    const { tools, matched: m } = planTools('so what do you reckon about this bloke then');
    expect(m).toBe(false);
    expect(tools).toEqual(DEFAULT_TOOLS);
  });

  test('the fan-out stays bounded however many rules match', () => {
    const q = 'Give me a complete status report with payments attendance progress goals '
      + 'measurements injuries programme communication renewals subscriptions everything';
    expect(planTools(q).tools.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  test('no rule ever names a tool that is not registered', () => {
    const { get } = require('../src/platform/tools/registry');
    const { RULES } = require('../src/agents/client/planner');
    for (const r of [...RULES, { tools: DEFAULT_TOOLS }]) {
      for (const name of r.tools) expect(get(name)).not.toBeNull();
    }
  });
});

describe('intent tiering sees the same inflections', () => {
  test.each(['Summarize this client', 'Give me a summary', 'summary please'])(
    '%s → summary', (q) => expect(planIntent(q)).toBe('summary'),
  );

  test.each(['How is their progress?', 'Analyse his training', 'Compare to last month'])(
    '%s → analysis', (q) => expect(planIntent(q)).toBe('analysis'),
  );

  test.each(['When does it expire?', 'How many sessions?', 'What is his balance?'])(
    '%s → lookup', (q) => expect(planIntent(q)).toBe('lookup'),
  );

  test('an unrecognised question still gets a tier', () => {
    expect(['lookup', 'analysis', 'summary']).toContain(planIntent('hmm'));
  });
});

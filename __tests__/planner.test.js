'use strict';
// Audit P1-1 — planner reachability.
//
// `search_knowledge` was registered, advertised in the tool summary and
// exercised directly by security.test.js, but no rule ever selected it: every
// methodology/policy question was answered from client records alone. These
// tests pin two things — the phrasing reaches the tool, and no registered tool
// can go back to being unreachable without failing here.

const { planTools, RULES, DEFAULT_TOOLS } = require('../src/agents/client/planner');
const { list, get } = require('../src/platform/tools/registry');

describe('P1-1 — methodology and policy questions select search_knowledge', () => {
  const cases = [
    'What is our policy on refunds?',
    'Which protocol do we follow for a returning injury?',
    'SOP for onboarding a new client',
    'What guideline do we use for squat depth?',
    'Is there a standard procedure for a missed session?',
  ];

  test.each(cases)('%s', (message) => {
    const { tools, matched } = planTools(message);
    expect(matched).toBe(true);
    expect(tools).toContain('search_knowledge');
  });

  test('the knowledge read survives the tool cap when other rules also match', () => {
    // Four matching families: knowledge, renewal, payment, training.
    const { tools } = planTools(
      'What is our policy on renewals when a payment is due and the package expired?',
    );
    expect(tools).toHaveLength(4);
    expect(tools[0]).toBe('search_knowledge');
  });

  test('a client question does not silently become a knowledge search', () => {
    const { tools } = planTools('How is this client doing?');
    expect(tools).not.toContain('search_knowledge');
  });
});

describe('P1-1 — every registered tool is reachable, or this test says so', () => {
  // A tool can only run if the planner selects it (or the agent fetches it as
  // part of authorisation). Adding a tool to the registry without a rule used
  // to be invisible; now it fails here.
  const reachable = new Set([...RULES.flatMap((r) => r.tools), ...DEFAULT_TOOLS]);

  test('no registered tool is unreachable', () => {
    const unreachable = list().map((t) => t.name).filter((name) => !reachable.has(name));
    expect(unreachable).toEqual([]);
  });

  test('every rule names a tool that actually exists', () => {
    const missing = [...reachable].filter((name) => !get(name));
    expect(missing).toEqual([]);
  });
});

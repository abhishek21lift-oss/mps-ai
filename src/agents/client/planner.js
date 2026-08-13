'use strict';
// Which tools does this question need?
//
// Deterministic pattern matching, not a model call. Three reasons, in order of
// how much they matter:
//
//   1. §44 COST. "When does their package expire?" should cost one ERP read and
//      one model call. Asking a model which tools to use first doubles the
//      model calls on every question to decide something a regex answers.
//   2. §24 DATA MINIMISATION. Fetching everything and letting the model sort it
//      out sends a client's medical notes to a provider to answer a question
//      about a renewal date. The cheapest way not to leak a field is not to
//      retrieve it.
//   3. TESTABILITY. A pure function from text to tool names can be asserted
//      exactly. A model's tool choice can only be sampled.
//
// This mirrors the ERP's own decision: lib/ai/tools.js chose pattern matching
// over native function calling because the free-tier models in use emit
// tool_calls unreliably. Same constraint, same answer, and the two stay
// comparable.
//
// The cost of determinism is honest: a phrasing nobody anticipated falls to the
// default. So the default is the broad summary set rather than nothing — an
// unrecognised question gets a well-grounded general answer instead of "I don't
// know", and the model is told which tools ran so it can say what it lacked.

/**
 * A stem and everything grown from it: `expir` covers expires, expiry, expiring.
 *
 * ── Why this helper exists ───────────────────────────────────────────────────
 *
 * Every rule below used to end in `\b`, which quietly meant NONE of them matched
 * an inflected word. `\bpayment\b` does not match "payments". `\bsummar\b`
 * matches neither "summary" nor "summarize". `\bgoal\b` misses "goals". On a
 * realistic set of trainer questions, twenty of twenty-six fell through to the
 * default.
 *
 * That was invisible because the default — snapshot plus profile — is a
 * perfectly plausible answer to almost anything, so nothing looked broken. What
 * it actually cost was worse than a wrong tool: "Any injuries?" never fetched
 * the training brief, so the agent correctly reported that it had no injury
 * data, about a client whose record contained some. A false "I don't have that"
 * is the exact failure the grounding rules exist to prevent, arriving through
 * the retrieval layer instead of the model.
 */
const stems = (...words) => `\\b(?:${words.join('|')})\\w*`;

/**
 * Words that must NOT grow a suffix, because the suffix is a different word.
 * `due` is the reason this exists: `due\w*` swallows "during", and "what is he
 * doing during the session?" is not a question about money.
 */
const exact = (...words) => `\\b(?:${words.join('|')})\\b`;

const rule = (pattern, tools) => ({ re: new RegExp(pattern, 'i'), tools });

const RULES = [
  // Money and package status.
  rule([
    stems('packag', 'expir', 'renew', 'subscription', 'validity', 'khatam'),
    exact('valid till', 'end date', 'kab tak'),
  ].join('|'), ['getClientProfile', 'getClientSubscriptions']),

  rule([
    stems('payment', 'balance', 'outstanding', 'invoice', 'fee', 'paisa', 'baki'),
    exact('due', 'dues', 'paid', 'unpaid'),
  ].join('|'), ['getClientProfile', 'getClientPayments']),

  rule(stems('renewal', 'renewed'), ['getClientRenewals']),

  // Training and physical state.
  rule([
    stems('attend', 'absent', 'missed', 'inactive', 'coming', 'aaya', 'aayi'),
    exact('present', 'no.?show'),
  ].join('|'), ['getClientAttendance']),

  rule(
    stems('workout', 'session', 'training', 'programme', 'program', 'exercis', 'routine', 'plan'),
    ['getClientTrainingBrief'],
  ),

  rule([
    stems('injur', 'pain', 'postur', 'mobility', 'limitation', 'restriction', 'medical'),
    exact('par.?q'),
  ].join('|'), ['getClientTrainingBrief']),

  rule([
    stems('measure', 'weight', 'waist', 'chest', 'hip', 'assessment', 'inch'),
    exact('body fat', 'bodyfat', 'kg'),
  ].join('|'), ['getClientSummary']),
  // "What changed since the last assessment?" needs more than the latest one.
  // /snapshot returns latest-only, so a comparison question that matched only
  // the rule above would be answered from a single row — and a model asked to
  // describe a change with one data point will describe one anyway.
  { re: /\b(since (the )?last|compared? (to|with)|previous assessment|assessment history|last assessment|re.?assess\w*|first assessment|over time)\b/i,
    tools: ['getClientAssessmentHistory', 'getClientSummary'] },
  rule(stems('goal', 'target', 'objective', 'aim'), ['getClientSummary']),

  rule([
    stems('progress', 'improve', 'trend', 'chang'),
    exact('better', 'worse', 'since'),
  ].join('|'), ['getClientSummary', 'getClientAttendance']),

  // Training depth, from the workout log. Kept distinct from the generic
  // "progress" rule above: that one is about measurements and showing up,
  // these are about what was actually lifted.
  rule([
    stems('stronger', 'strength', 'lift'),
    exact('1rm', 'one.?rep', 'pr', 'personal record', 'load', 'loads'),
  ].join('|'), ['getClientTrainingAnalytics']),

  rule([
    stems('volume', 'tonnage', 'workload'),
    exact('training load', 'how much work'),
  ].join('|'), ['getClientVolumeSummary']),

  rule([
    stems('neglect', 'overtrain', 'overcook', 'recovery'),
    // `balanced` exactly, never `balanc\w*` — that also catches "balance", and
    // an outstanding-balance question would drag the workout log along with it.
    exact('balanced', 'muscle group', 'muscle groups', 'coverage', 'rest day', 'rest days'),
    'last train\\w*',
  ].join('|'), ['getClientTrainingAnalytics']),

  // Contact.
  rule([
    stems('contact', 'phone', 'mobile', 'message', 'communicat', 'whatsapp'),
    exact('call', 'called', 'number', 'follow.?up', 'follow.?ups'),
  ].join('|'), ['getClientProfile', 'getClientCommunication']),

  // Whole-picture asks — the "give me everything" family.
  rule([
    stems('summar', 'overview'),
    exact('status report', 'full picture', 'everything', 'brief me', 'complete status', 'kaisa hai'),
  ].join('|'), ['getClientSummary', 'getClientProfile', 'getClientAttendance', 'getClientTrainingBrief']),

  rule([
    stems('focus', 'concern', 'worry', 'risk', 'discuss'),
    exact('next session', 'should i', 'what to do', 'advice'),
  ].join('|'), ['getClientSummary', 'getClientAttendance', 'getClientTrainingBrief']),
];

/** Unrecognised questions still get grounded — see the header. */
const DEFAULT_TOOLS = ['getClientSummary', 'getClientProfile'];

/** Never fan out further than this in one turn, whatever the rules matched. */
const MAX_TOOLS = 4;

/**
 * @param {string} message  The trainer's question, verbatim.
 * @returns {{tools: string[], matched: boolean}}
 */
function planTools(message) {
  const text = String(message || '');
  const picked = [];

  for (const rule of RULES) {
    if (!rule.re.test(text)) continue;
    for (const t of rule.tools) if (!picked.includes(t)) picked.push(t);
  }

  if (!picked.length) return { tools: [...DEFAULT_TOOLS], matched: false };
  return { tools: picked.slice(0, MAX_TOOLS), matched: true };
}

/**
 * Cheap questions should not be billed as reasoning. Kept alongside the rules
 * so a new rule and its intent are chosen together.
 */
function planIntent(message) {
  const text = String(message || '');
  // Same stem rule as the tool rules above, and for the same reason: `summar`
  // followed by \b matched neither "summary" nor "summarize", so the one intent
  // this function exists to detect was the one it could never see.
  if (new RegExp(`${stems('summar', 'overview')}|${exact('status report', 'full picture', 'brief me')}`, 'i').test(text)) return 'summary';
  if (new RegExp(`${stems('progress', 'analy', 'compar', 'trend', 'focus', 'concern')}|${exact('why', 'should i')}`, 'i').test(text)) return 'analysis';
  if (new RegExp(`${stems('expir', 'balance', 'number')}|${exact('when', 'what is', 'who', 'how many', 'due', 'dues')}`, 'i').test(text)) return 'lookup';
  return 'analysis';
}

module.exports = { planTools, planIntent, RULES, DEFAULT_TOOLS, MAX_TOOLS };

'use strict';
// §14 — what KIND of question is this?
//
// Not to be confused with platform/router.js, which routes an intent to a MODEL
// TIER. This decides what a question is *for*: studio records, policy
// documents, both, neither, or nothing this service can do.
//
// ── Deterministic, for the same reasons the tool planner is ──────────────────
//
// Asking a model to classify before answering doubles the model calls on every
// question to decide something a regex decides, and a free-tier model's
// classification can only be sampled, never asserted. The cost of determinism is
// honest and is paid in one place: an unrecognised phrasing falls to
// DATABASE_QUERY, which is the safe default — it retrieves records and grounds
// the answer, rather than refusing or inventing.
//
// ── The line this file does NOT cross ────────────────────────────────────────
//
// UNAUTHORIZED_REQUEST here is a statement about CAPABILITY, never about
// ENTITLEMENT. "This assistant covers one client at a time" is a fact about the
// tool surface. "You may not see that client" is an authorisation decision, and
// it is made by the ERP against the caller's own token — never by a regex over
// their sentence.
//
// That distinction matters because keyword detection fails both ways: it fails
// open on the phrasing nobody listed, and closed on a trainer legitimately
// asking "how does he compare to my other clients?". If this file were the
// security boundary, both failures would be breaches. It is not. The boundary
// is that no tool returns another studio and every call is re-authorised
// upstream — the same argument context/untrusted.js makes about injection.
// Classification improves the answer and saves tokens. It does not protect
// anything, and nothing here should ever be written as though it did.

const CLASSES = Object.freeze({
  DATABASE_QUERY: 'DATABASE_QUERY',
  RAG_QUERY: 'RAG_QUERY',
  DATABASE_PLUS_RAG: 'DATABASE_PLUS_RAG',
  GENERAL_SMALLTALK: 'GENERAL_SMALLTALK',
  CLARIFICATION_REQUIRED: 'CLARIFICATION_REQUIRED',
  UNAUTHORIZED_REQUEST: 'UNAUTHORIZED_REQUEST',
  UNSUPPORTED_REQUEST: 'UNSUPPORTED_REQUEST',
});

/* ── Scope: asks this agent cannot serve because of what it IS ────────────────
   The Client Agent answers about ONE client, chosen in the UI. A question about
   a different client, another trainer's roster, or the studio at large has no
   tool behind it — not because the caller is forbidden, but because the tool
   does not exist. Saying so is more useful than an answer about the wrong
   person. */
const OTHER_SCOPE = [
  /\b(all|every|other|another|others'?|rest of the)\s+(clients?|members?|customers?|people|trainers?|staff|studios?|gyms?|branch(es)?|locations?|organi[sz]ations?)\b/i,
  /\b(list|show|give)\s+(me\s+)?(all|every)\b/i,
  /\b(another|other|different|someone else'?s?|somebody else'?s?)\s+(studio|gym|branch|organi[sz]ation|trainer|client|member)\b/i,
  /\b(organi[sz]ation|org|studio|branch|tenant)\s*(id\s*)?[#:=]?\s*\d+\b/i,
  /\b(compare|versus|vs\.?)\s+(him|her|them|this client)?\s*(to|with|against)\s+(other|all|another|the rest)\b/i,
  /\bstudio(-|\s)?wide\b/i,
  /\b(total|overall)\s+(revenue|income|earnings|turnover|sales)\b/i,
  /\bhow many (clients?|members?|trainers?|staff)\b.*\b(do i|in (the|my) (studio|gym|branch))\b/i,
];

/* ── Impersonation and instruction-override phrasings ────────────────────────
   Listed to produce a clear refusal rather than a confused answer. They are NOT
   what stops the attack: an attacker who rephrases past this list still cannot
   read another tenant, because no tool returns one. See the header. */
const OVERRIDE = [
  /\bignore\s+(all\s+|any\s+|your\s+|the\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?|messages?)\b/i,
  /\b(pretend|act as if|act like|imagine)\s+(you\s+are|i\s+am|i'm|im)\b/i,
  /\b(you\s+are\s+now|from\s+now\s+on\s+you)\b/i,
  /\b(disable|bypass|turn off|remove|skip|without)\s+(the\s+)?(tenant|org(ani[sz]ation)?|security|auth\w*|permission|filter\w*|restriction\w*|scoping)\b/i,
  /\b(reveal|show|print|repeat|output|what is)\s+(me\s+)?(your\s+|the\s+)?(system\s+prompt|instructions|prompt|rules)\b/i,
  /\b(api[_\s-]?keys?|secrets?|passwords?|credentials?|env(ironment)?\s+variables?|database[_\s-]?(url|password|credential)s?)\b/i,
  // Environment-variable names as written: DATABASE_URL, SERVICE_AUTH_SECRET,
  // AI_API_KEY. An underscore is a word character, so \bsecret\b does not match
  // inside SERVICE_AUTH_SECRET — these have to be matched on their own terms.
  /\b\w*_(secret|key|token|password|url|credentials?)\b/i,
  /\bas\s+(a\s+)?(superadmin|super\s+admin|admin\s+of\s+another|root)\b/i,
];

/* ── Requests to change something. This service reads; it cannot write ────────
   Matched in IMPERATIVE POSITION only — at the start of the message, or after
   "can you"/"please". A bare verb list would swallow "any update on his
   progress?" and "what changed since last month?", which are questions, not
   commands. */
const WRITE_VERBS = 'book|schedule|rebook|reschedule|create|make|add|register|enrol|enroll'
  + '|delete|remove|cancel|renew|extend|send|message|whatsapp|email|notify|remind'
  + '|charge|refund|assign|update|edit|mark|set|record|log|activate|deactivate';

const IMPERATIVE_WRITE = new RegExp(`^\\s*(please\\s+)?(${WRITE_VERBS})\\b`, 'i');
const POLITE_WRITE = new RegExp(`\\b(can|could|would|will|pls|please)\\s+(you\\s+)?(please\\s+)?(${WRITE_VERBS})\\b`, 'i');

/* ── Policy and document questions — the RAG side of §13 ─────────────────────
   Static knowledge: what the studio's rules SAY. Distinct from what the records
   SHOW, which is the database side. */
const POLICY = [
  /\b(policy|policies|sop|s\.o\.p\.|guideline|guidelines|rule|rules|procedure|protocol)\b/i,
  /\b(terms|t&c|contract|agreement|waiver|handbook|manual|documentation)\b/i,
  /\b(are we (allowed|supposed)|what('s| is) our|how (are we|should we|do we) (meant|supposed) to)\b/i,
  /\b(entitled to|eligible for|qualif(y|ies|ied) for)\b.*\b(refund|cancellation|transfer|freeze|extension)\b/i,
];

/* ── This client's records specifically ──────────────────────────────────────
   Used only to separate "what does our policy SAY?" from "does THIS CLIENT's
   situation satisfy it?". The distinction has to be narrow: "show me the
   trainer SOP" contains "show me", and a generic verb is not evidence that
   anyone wants a record read. What marks the difference is a reference to the
   client, or to a window of time in which events happened. */
const CLIENT_RECORD_SIGNAL = [
  /\b(his|her|hers|their|theirs|him|them|this client|the client|client'?s)\b/i,
  /\b(how many|how much)\b.*\b(session|payment|attendance|cancellation|visit|renewal|class)/i,
  /\b(this|last|next)\s+(week|month|quarter|year)\b/i,
  /\b(today|yesterday|tomorrow|so far|to date)\b/i,
];

/* ── What the records SHOW ──────────────────────────────────────────────────── */
const DATA_SIGNAL = [
  /\b(how many|how much|when|what date|which|who|list|show me|total|count|number of)\b/i,
  /\b(attendance|attended|session|sessions|payment|paid|due|dues|balance|outstanding|invoice|fee|fees)\b/i,
  /\b(package|subscription|membership|expir|renew|validity|valid)\b/i,
  /\b(weight|measurement|body fat|assessment|progress|goal|programme|program|workout|injur|par.?q)\b/i,
  /\b(last|recent|latest|this (week|month|year)|today|yesterday)\b/i,
];

/* ── Conversational filler that needs no data and no model ───────────────────── */
const SMALLTALK = [
  /^\s*(hi|hey|hello|yo|namaste|hola)\b[\s!.?]*$/i,
  /^\s*(thanks|thank you|thx|ty|cheers|great|perfect|ok|okay|got it|cool|nice|awesome|understood)\b[\s!.?]*$/i,
  /^\s*(good\s+(morning|afternoon|evening|night))\b[\s!.?]*$/i,
  /^\s*(bye|goodbye|see you|later)\b[\s!.?]*$/i,
];

/* ── Too little to act on ──────────────────────────────────────────────────────
   Only genuinely contentless messages. A short question with a noun in it
   ("dues?") is answerable; "how much?" alone is not. */
const VAGUE = [
  /^\s*(how much|how many|what about|and|so|well|hmm+|\?+)\s*\??\s*$/i,
  /^\s*(him|her|them|it|this|that|those|they)\s*\??\s*$/i,
  /^\s*(more|again|continue|go on|next)\s*\??\s*$/i,
];

const any = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * Classify one question.
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {boolean} [opts.ragAvailable=false]  Whether a knowledge base is configured.
 *   No knowledge base exists yet (Phase 7), so policy questions must be answered
 *   with "I don't have your policy documents" rather than by a model improvising
 *   a plausible cancellation policy — which is the §3 failure this guards.
 * @returns {{intent: string, reason: string, shortCircuit: boolean, useTools: boolean, directive: string|null}}
 */
function classify(message, { ragAvailable = false } = {}) {
  const text = String(message || '').trim();

  if (!text) {
    return decision(CLASSES.CLARIFICATION_REQUIRED, 'empty message', {
      shortCircuit: true, useTools: false,
    });
  }

  // Order is precedence, and it is deliberate.

  // 1. Override and secret-extraction attempts. First, so a payload wrapped in a
  //    plausible data question is still named for what it is.
  if (any(OVERRIDE, text)) {
    return decision(CLASSES.UNAUTHORIZED_REQUEST, 'instruction override or secret extraction', {
      shortCircuit: true,
      useTools: false,
      directive: null,
    });
  }

  // 2. Scope. A question about other clients or the whole studio has no tool
  //    behind it in this agent.
  if (any(OTHER_SCOPE, text)) {
    return decision(CLASSES.UNAUTHORIZED_REQUEST, 'outside this agent\'s single-client scope', {
      shortCircuit: true,
      useTools: false,
    });
  }

  // 3. Smalltalk, before the data patterns — "thanks!" needs no ERP read.
  if (any(SMALLTALK, text)) {
    return decision(CLASSES.GENERAL_SMALLTALK, 'conversational filler', {
      shortCircuit: true, useTools: false,
    });
  }

  // 4. Contentless.
  if (any(VAGUE, text)) {
    return decision(CLASSES.CLARIFICATION_REQUIRED, 'not enough to act on', {
      shortCircuit: true, useTools: false,
    });
  }

  const wantsPolicy = any(POLICY, text);
  const wantsData = any(DATA_SIGNAL, text);
  // Deliberately the narrow signal, not the broad one: "show me the trainer
  // SOP" is a document request that happens to start with a verb, and treating
  // it as half a records question would send it to the tools for an answer they
  // do not hold.
  const wantsThisClientsRecords = any(CLIENT_RECORD_SIGNAL, text);

  // 5. Policy, alone or combined with a records question.
  if (wantsPolicy && wantsThisClientsRecords) {
    return decision(CLASSES.DATABASE_PLUS_RAG, 'records plus policy', {
      shortCircuit: false,
      useTools: true,
      // Degrades honestly: the records half is still answered, and the policy
      // half is declared missing rather than improvised.
      directive: ragAvailable ? null : NO_POLICY_DIRECTIVE,
    });
  }

  if (wantsPolicy) {
    return decision(CLASSES.RAG_QUERY, 'policy or document question', {
      // With no knowledge base there is nothing to retrieve and nothing a
      // client record can substitute for. Answering from the client's data
      // would be a fabricated policy stated as the studio's own.
      shortCircuit: !ragAvailable,
      useTools: ragAvailable,
    });
  }

  // 6. Write requests. NOT short-circuited: "create a workout for this client"
  //    is a request for content the trainer will enter by hand, and refusing it
  //    outright is less useful than producing the plan and saying it must be
  //    entered in the app. The prompt already carries that instruction; this
  //    only labels the turn.
  if (IMPERATIVE_WRITE.test(text) || POLITE_WRITE.test(text)) {
    return decision(CLASSES.UNSUPPORTED_REQUEST, 'asks for a change this service cannot make', {
      shortCircuit: false,
      useTools: true,
      directive: WRITE_DIRECTIVE,
    });
  }

  // 7. Default. Retrieve and ground rather than refuse — an unanticipated
  //    phrasing should get a well-sourced answer, not "I don't understand".
  return decision(CLASSES.DATABASE_QUERY, wantsData ? 'records question' : 'default', {
    shortCircuit: false, useTools: true,
  });
}

const NO_POLICY_DIRECTIVE = [
  'This question refers to a studio policy or document.',
  'You have NO access to policy documents, SOPs, contracts or handbooks — none are configured.',
  'Answer the part that comes from the client\'s records, then say plainly that you cannot',
  'check it against the studio\'s written policy because you do not have those documents.',
  'Do not state, summarise, paraphrase or infer what any policy says.',
].join('\n');

const WRITE_DIRECTIVE = [
  'The trainer has asked for something to be changed, sent or booked.',
  'You have read-only access and cannot do it. Do not imply that you have.',
  'If the request is for content (a plan, a message draft, a suggestion), produce it and say',
  'it must be entered in the app. If it is an action on a record, say what you would change',
  'and where in the app to do it.',
].join('\n');

function decision(intent, reason, { shortCircuit, useTools, directive = null }) {
  return Object.freeze({ intent, reason, shortCircuit, useTools, directive });
}

/**
 * The deterministic answer for a short-circuited turn.
 *
 * Written here rather than generated, because these are statements about what
 * this service is — and a model asked to phrase "I have no policy documents"
 * will eventually phrase it as a policy.
 */
function shortCircuitAnswer(intent, { clientName } = {}) {
  switch (intent) {
    case CLASSES.UNAUTHORIZED_REQUEST:
      return 'This assistant answers about one client at a time — the one open in front of you'
        + `${clientName ? ` (${clientName})` : ''}. It has no access to other clients, other`
        + ' trainers, or other studios, and no way to obtain it. To ask about someone else,'
        + ' open their profile and ask there.';

    case CLASSES.RAG_QUERY:
      return 'I don\'t have your studio\'s policy documents, SOPs or contracts — only client'
        + ' records. I can\'t tell you what your written policy says. For questions about this'
        + ' client\'s data, ask and I\'ll answer from the records.';

    case CLASSES.GENERAL_SMALLTALK:
      return 'Ask me anything about this client — sessions, attendance, payments, package'
        + ' validity, measurements or progress.';

    case CLASSES.CLARIFICATION_REQUIRED:
      return 'Could you say a bit more about what you need? For example: package expiry,'
        + ' outstanding balance, recent attendance, or progress since the last assessment.';

    default:
      return null;
  }
}

module.exports = {
  classify,
  shortCircuitAnswer,
  CLASSES,
  NO_POLICY_DIRECTIVE,
  WRITE_DIRECTIVE,
};

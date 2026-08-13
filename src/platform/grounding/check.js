'use strict';
// Does every figure in the answer actually appear in the data it came from?
//
// The last gap in the grounding story. Everything else in this service controls
// what the model is GIVEN — authorised reads, fenced context, an instruction not
// to invent. Nothing checked what it then SAID. A model handed a client's real
// record can still write "₹4,500 outstanding" when the record says ₹4,200, and
// every layer upstream of it was working correctly at the time.
//
// So this reads the finished answer, pulls out the numerals, and tries to
// account for each one against the payloads the tools returned.
//
// ── It reports; it does not censor ───────────────────────────────────────────
//
// Nothing here rewrites, blocks or retries an answer. A checker that silently
// edits output is worse than none: the trainer loses the ability to see that
// anything was uncertain, and a bug in this file becomes a bug in the answer.
// The result is metadata, and the UI decides what to do with it.
//
// ── Numbers only, and deliberately so ────────────────────────────────────────
//
// "He is progressing well" is not checkable this way and is not attempted.
// Figures are where fabrication is both most likely and most costly — a wrong
// adjective is a difference of opinion, a wrong balance is a conversation with
// a client about money they do not owe.
//
// ── Which way it fails ───────────────────────────────────────────────────────
//
// Toward silence. Small integers ("the last 3 sessions") will nearly always
// find an incidental match somewhere in a JSON payload and be counted as
// verified, whether or not that is where the model got them. That is a FALSE
// NEGATIVE, and it is the direction to fail in: an indicator that cries wolf on
// correct answers gets ignored within a week, and then catches nothing at all.
//
// What it does catch is the case worth catching: a specific, precise figure —
// 78.4, ₹4,500, 42 — that appears nowhere in the retrieved records and cannot
// be derived from them.

/** Bound on the pairwise search. Beyond this, only direct and single-value
 *  derivations are tried — quadratic work on a large payload would turn a
 *  cheap check into a latency problem. */
const MAX_PAIRWISE = 300;

/** Two figures are the same if they agree to two decimal places. Money and
 *  body measurements are quoted to at most that, and float arithmetic on a
 *  derived value should not fail a match on the eleventh digit. */
const EPSILON = 0.005;

const near = (a, b) => Math.abs(a - b) < EPSILON;

/** ISO dates are matched whole. Split into 2026/08/13 they would each match
 *  something incidental and the date itself would never be checked. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

/**
 * Numerals as a human writes them: optional currency, thousands separators,
 * optional decimals, optional trailing %.
 * Deliberately not matching inside words (h2, v1.2) via the leading boundary.
 */
const FIGURE = /(?<![\w.])(?:₹|Rs\.?\s?|\$)?(-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s?(%)?/g;

function toNumber(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Every figure in the answer, with where it was written.
 * `context` is the whole line, so a reviewer can see what the number was
 * claiming without opening the transcript.
 */
function extractFigures(answer) {
  const out = [];
  const lines = String(answer || '').split('\n');

  lines.forEach((line, i) => {
    const seenDates = new Set();

    for (const m of line.matchAll(ISO_DATE)) {
      seenDates.add(m[0]);
      out.push({
        text: m[0], value: null, date: m[0], line: i + 1, context: line.trim().slice(0, 200),
      });
    }

    // Blank out the dates so their components are not re-extracted as numbers.
    const withoutDates = [...seenDates].reduce((s, d) => s.split(d).join(' '.repeat(d.length)), line);

    for (const m of withoutDates.matchAll(FIGURE)) {
      const value = toNumber(m[1]);
      if (value === null) continue;
      out.push({
        text: m[0].trim(),
        value,
        percent: Boolean(m[2]),
        line: i + 1,
        context: line.trim().slice(0, 200),
      });
    }
  });

  return out;
}

/**
 * Everything numeric the tools actually returned, in the shapes a derivation
 * might use: the raw values, how long each array was, and the per-key totals
 * across arrays of objects.
 *
 * The last of those is what makes "he has paid ₹18,000 in total" verifiable —
 * that figure is in no record, it is the sum of a column.
 */
function collectSource(sources) {
  const numbers = new Set();
  const arrayLengths = new Set();
  const fieldSums = new Set();
  const text = [];

  const walk = (node) => {
    if (node === null || node === undefined) return;

    if (typeof node === 'number' && Number.isFinite(node)) {
      numbers.add(node);
      return;
    }
    if (typeof node === 'string') {
      text.push(node);
      // Numbers stored as strings are common in this ERP ("4500.00").
      const n = toNumber(node);
      if (n !== null && /^\s*-?[\d,]+(\.\d+)?\s*$/.test(node)) numbers.add(n);
      return;
    }
    if (Array.isArray(node)) {
      arrayLengths.add(node.length);

      // Per-key totals across the rows.
      const totals = new Map();
      for (const row of node) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        for (const [k, v] of Object.entries(row)) {
          const n = typeof v === 'number' ? v : (typeof v === 'string' ? toNumber(v) : null);
          if (n === null || !Number.isFinite(n)) continue;
          totals.set(k, (totals.get(k) ?? 0) + n);
        }
      }
      for (const t of totals.values()) fieldSums.add(t);

      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };

  (sources || []).forEach(walk);
  return { numbers, arrayLengths, fieldSums, text: text.join('\n') };
}

/**
 * Can this figure be accounted for by arithmetic over the source values?
 *
 * A bounded set on purpose: a count, a total, a difference, a percentage, or a
 * rounding. These are what a studio answer actually does with numbers. Anything
 * cleverer would be guessing at a derivation nobody performed, which turns the
 * check into a machine for explaining away wrong figures.
 */
function isDerived(value, src) {
  if (src.arrayLengths.has(value)) return true;                 // a count
  for (const s of src.fieldSums) if (near(s, value)) return true; // a column total

  // Array lengths join the operand pool, not just the direct-match set. "He
  // attended 2 of 3 planned sessions (66.7%)" derives that percentage from two
  // COUNTS, neither of which is a value stored in any record.
  const nums = [...new Set([...src.numbers, ...src.arrayLengths])];

  // A rounding, or a sign flip, of a single source value.
  for (const n of nums) {
    if (near(Math.round(n), value)) return true;
    if (near(Math.round(n * 10) / 10, value)) return true;
    if (near(-n, value)) return true;
  }

  if (nums.length > MAX_PAIRWISE) return false;

  for (let i = 0; i < nums.length; i += 1) {
    for (let j = 0; j < nums.length; j += 1) {
      if (i === j) continue;
      const a = nums[i];
      const b = nums[j];
      if (near(a + b, value)) return true;
      if (near(a - b, value)) return true;
      if (b !== 0) {
        // Percentages are quoted rounded far more often than not — 2 of 3 is
        // written "66.7%" or "67%", never 66.66666666666667. Accepting only the
        // exact quotient would flag correct arithmetic as fabrication, which is
        // the failure that gets an indicator ignored.
        const pct = (a / b) * 100;
        if (near(pct, value)
          || near(Math.round(pct), value)
          || near(Math.round(pct * 10) / 10, value)
          || near(Math.round(pct * 100) / 100, value)) return true;
      }
    }
  }

  return false;
}

/**
 * Check an answer against the payloads it was grounded in.
 *
 * @param {object} o
 * @param {string} o.answer          The model's finished text.
 * @param {unknown[]} o.sources      Raw tool payloads, as returned by the ERP.
 * @returns {{checked, inSource, derived, unverified, figures}}
 *   `figures` carries ONLY the unverified ones — the whole list would be noise,
 *   and the caller already has the answer if it wants the rest.
 */
function checkGrounding({ answer, sources }) {
  const figures = extractFigures(answer);
  const src = collectSource(sources);

  let inSource = 0;
  let derived = 0;
  const unverified = [];

  for (const fig of figures) {
    if (fig.date) {
      if (src.text.includes(fig.date)) inSource += 1;
      else unverified.push({ text: fig.text, value: null, line: fig.line, context: fig.context });
      continue;
    }

    let matched = false;
    for (const n of src.numbers) {
      if (near(n, fig.value)) { matched = true; break; }
    }

    if (matched) {
      inSource += 1;
    } else if (isDerived(fig.value, src)) {
      derived += 1;
    } else {
      unverified.push({
        text: fig.text, value: fig.value, line: fig.line, context: fig.context,
      });
    }
  }

  return {
    checked: figures.length,
    inSource,
    derived,
    unverified: unverified.length,
    figures: unverified,
  };
}

module.exports = {
  checkGrounding, extractFigures, collectSource, isDerived, MAX_PAIRWISE, EPSILON,
};

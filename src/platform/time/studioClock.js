'use strict';
// What day is it, in the studio's timezone?
//
// Nothing in this service used to answer that question, and the consequence was
// not a missing feature but a fabrication. Asked "whose package expires this
// month?", a model with no stated date answers against whatever it believes the
// date to be — its training cutoff — and states the result as though it came
// from the studio's records. §22 asks for timezone handling; §3 is the reason it
// is not cosmetic.
//
// ── Civil dates, not instants ────────────────────────────────────────────────
//
// Every range here is a pair of CIVIL DATES (YYYY-MM-DD) in the studio's zone,
// not a pair of UTC timestamps. That is deliberate:
//
//   * It is what a business question actually means. "August" is the 1st to the
//     31st on the wall calendar in the studio, not a 744-hour window measured
//     from an offset.
//   * It is what the ERP will filter on — a DATE column comparison.
//   * It sidesteps DST entirely. The arithmetic below never converts a civil
//     date back into an instant, so there is no hour that exists twice or not
//     at all for it to land on. (Asia/Kolkata has no DST, but this code should
//     not silently break for a studio that opens somewhere that does.)
//
// No dependency. A date library would be the obvious reach here, but the whole
// requirement is "add N days to a calendar date and format it", which UTC-based
// Date arithmetic does exactly and testably.

/** ISO weekday, Monday = 1 … Sunday = 7. Gyms think in weeks starting Monday. */
const WEEK_STARTS_ON = 1;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The studio-local civil date of an instant.
 * 'en-CA' is used because it formats as YYYY-MM-DD, which is the output we
 * want — not because the studio is Canadian.
 */
function civilDate(instant, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/**
 * A civil date as a UTC-midnight Date, purely so JS date arithmetic can be used
 * on it. This value is a calendar cursor, never a real moment in time — do not
 * hand it to anything that will convert it back to a local instant.
 */
function cursor(isoDate) {
  if (!ISO_DATE.test(isoDate)) throw new Error(`Not an ISO date: ${isoDate}`);
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(cur) {
  return cur.toISOString().slice(0, 10);
}

function addDays(isoDate, n) {
  const cur = cursor(isoDate);
  cur.setUTCDate(cur.getUTCDate() + n);
  return iso(cur);
}

function addMonths(isoDate, n) {
  const cur = cursor(isoDate);
  const targetDay = cur.getUTCDate();
  cur.setUTCDate(1);
  cur.setUTCMonth(cur.getUTCMonth() + n);
  // Clamp: "one month before 31 March" is 28 February, not 3 March.
  const lastDay = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate();
  cur.setUTCDate(Math.min(targetDay, lastDay));
  return iso(cur);
}

/** ISO weekday of a civil date: Monday = 1 … Sunday = 7. */
function weekday(isoDate) {
  return cursor(isoDate).getUTCDay() || 7;
}

function startOfWeek(isoDate) {
  return addDays(isoDate, -(weekday(isoDate) - WEEK_STARTS_ON));
}

function startOfMonth(isoDate) {
  return `${isoDate.slice(0, 7)}-01`;
}

function endOfMonth(isoDate) {
  const cur = cursor(startOfMonth(isoDate));
  cur.setUTCMonth(cur.getUTCMonth() + 1);
  cur.setUTCDate(0);
  return iso(cur);
}

function startOfQuarter(isoDate) {
  const cur = cursor(isoDate);
  const q = Math.floor(cur.getUTCMonth() / 3);
  return iso(new Date(Date.UTC(cur.getUTCFullYear(), q * 3, 1)));
}

/**
 * Named ranges, each returning inclusive civil-date bounds.
 *
 * "This week" and "this month" are the WHOLE calendar period, not
 * period-start-to-today. A studio owner asking "how did we do this month?"
 * means August; silently truncating to the 13th would understate every figure
 * without saying so, which is the quiet kind of wrong. Callers wanting
 * to-date semantics should ask for it explicitly.
 */
const RANGES = {
  today: (t) => ({ start: t, end: t }),
  yesterday: (t) => ({ start: addDays(t, -1), end: addDays(t, -1) }),
  tomorrow: (t) => ({ start: addDays(t, 1), end: addDays(t, 1) }),

  this_week: (t) => ({ start: startOfWeek(t), end: addDays(startOfWeek(t), 6) }),
  last_week: (t) => ({ start: addDays(startOfWeek(t), -7), end: addDays(startOfWeek(t), -1) }),
  next_week: (t) => ({ start: addDays(startOfWeek(t), 7), end: addDays(startOfWeek(t), 13) }),

  this_month: (t) => ({ start: startOfMonth(t), end: endOfMonth(t) }),
  last_month: (t) => ({ start: startOfMonth(addMonths(startOfMonth(t), -1)), end: endOfMonth(addMonths(startOfMonth(t), -1)) }),
  next_month: (t) => ({ start: startOfMonth(addMonths(startOfMonth(t), 1)), end: endOfMonth(addMonths(startOfMonth(t), 1)) }),

  this_quarter: (t) => ({ start: startOfQuarter(t), end: endOfMonth(addMonths(startOfQuarter(t), 2)) }),
  this_year: (t) => ({ start: `${t.slice(0, 4)}-01-01`, end: `${t.slice(0, 4)}-12-31` }),
  last_year: (t) => {
    const y = Number(t.slice(0, 4)) - 1;
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  },

  last_7_days: (t) => ({ start: addDays(t, -6), end: t }),
  last_30_days: (t) => ({ start: addDays(t, -29), end: t }),
  last_90_days: (t) => ({ start: addDays(t, -89), end: t }),
};

/** Phrases a trainer actually types, mapped to the named ranges above. */
const PHRASES = [
  [/\b(today|aaj)\b/i, 'today'],
  [/\b(yesterday|kal raat|beeta kal)\b/i, 'yesterday'],
  [/\btomorrow\b/i, 'tomorrow'],
  [/\bthis week\b/i, 'this_week'],
  [/\blast week\b/i, 'last_week'],
  [/\bnext week\b/i, 'next_week'],
  [/\bthis month\b/i, 'this_month'],
  [/\blast month\b/i, 'last_month'],
  [/\bnext month\b/i, 'next_month'],
  [/\bthis quarter\b/i, 'this_quarter'],
  [/\bthis year\b/i, 'this_year'],
  [/\blast year\b/i, 'last_year'],
  [/\blast 7 days\b|\bpast week\b/i, 'last_7_days'],
  [/\blast 30 days\b|\bpast month\b/i, 'last_30_days'],
  [/\blast 90 days\b|\blast quarter\b/i, 'last_90_days'],
];

function createStudioClock({ timeZone, now = () => new Date() }) {
  /** The studio-local civil date, right now. */
  function today() {
    return civilDate(now(), timeZone);
  }

  /**
   * Resolve a named range.
   * @returns {{name, start, end, timeZone}|null} null when the name is unknown,
   *   so a caller can ask for clarification rather than guess a window.
   */
  function range(name) {
    const fn = RANGES[name];
    if (!fn) return null;
    return { name, ...fn(today()), timeZone };
  }

  /**
   * Find a date range in free text.
   * Returns null when nothing matched — deliberately, because inventing a
   * default window is how "revenue" silently becomes "revenue this month".
   */
  function rangeFromText(text) {
    for (const [re, name] of PHRASES) {
      if (re.test(String(text || ''))) return range(name);
    }
    return null;
  }

  /**
   * The line the model is told the date by. Includes the weekday because
   * "this week" is unresolvable without it, and the zone because a model that
   * assumes UTC is the failure §22 is about.
   */
  function describe() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now());
    return `${parts} (${timeZone}), ISO date ${today()}`;
  }

  return { today, range, rangeFromText, describe, timeZone };
}

module.exports = {
  createStudioClock,
  civilDate,
  addDays,
  addMonths,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  weekday,
  RANGES,
  PHRASES,
  WEEK_STARTS_ON,
};

'use strict';
// §22 — the agent must know what day it is, in the studio's timezone.
//
// The bug these cover is not a missing feature. Before the studio clock existed
// nothing in the service supplied a date, so "whose package expires this month?"
// was answered against whatever the model believed the date to be — its
// training cutoff — and presented as though it came from the studio's records.
// A wrong answer delivered in the confident register of a database lookup.

const {
  createStudioClock, addDays, addMonths, startOfWeek, startOfMonth, endOfMonth, weekday,
} = require('../src/platform/time/studioClock');
const { load } = require('../src/config');
const { BASE_ENV, okErp, appWith, post, systemOf, fixedClock } = require('./helpers');

// 13 Aug 2026 is a Thursday. 09:15Z is 14:45 in Asia/Kolkata (UTC+5:30).
const AT = '2026-08-13T09:15:00Z';

describe('civil-date arithmetic', () => {
  test('adding days crosses month and year boundaries', () => {
    expect(addDays('2026-08-13', 1)).toBe('2026-08-14');
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  test('adding months clamps rather than overflowing into the next month', () => {
    // The classic off-by-a-month: 31 March minus one month is 28 February,
    // not 3 March. Getting this wrong silently shifts every "last month"
    // revenue figure by a few days.
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');   // leap year
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-08-13', 1)).toBe('2026-09-13');
  });

  test('weeks start on Monday', () => {
    expect(weekday('2026-08-13')).toBe(4);                    // Thursday
    expect(startOfWeek('2026-08-13')).toBe('2026-08-10');     // Monday
    expect(startOfWeek('2026-08-10')).toBe('2026-08-10');     // already Monday
    expect(startOfWeek('2026-08-16')).toBe('2026-08-10');     // Sunday belongs to it
  });

  test('month bounds', () => {
    expect(startOfMonth('2026-08-13')).toBe('2026-08-01');
    expect(endOfMonth('2026-08-13')).toBe('2026-08-31');
    expect(endOfMonth('2026-02-05')).toBe('2026-02-28');
    expect(endOfMonth('2024-02-05')).toBe('2024-02-29');
  });
});

describe('named ranges resolve in the studio timezone', () => {
  const clock = fixedClock(AT);

  test('today is the studio-local date, not the UTC one', () => {
    expect(clock.today()).toBe('2026-08-13');
  });

  test('an instant that is still "yesterday" in UTC is already today in the studio', () => {
    // 18:45 UTC on the 12th is 00:15 on the 13th in Asia/Kolkata. A service
    // reasoning in UTC would answer every "today" question with the wrong day
    // for five and a half hours of every day.
    const late = fixedClock('2026-08-12T18:45:00Z');
    expect(late.today()).toBe('2026-08-13');
  });

  test.each([
    ['today', '2026-08-13', '2026-08-13'],
    ['yesterday', '2026-08-12', '2026-08-12'],
    ['tomorrow', '2026-08-14', '2026-08-14'],
    ['this_week', '2026-08-10', '2026-08-16'],
    ['last_week', '2026-08-03', '2026-08-09'],
    ['next_week', '2026-08-17', '2026-08-23'],
    ['this_month', '2026-08-01', '2026-08-31'],
    ['last_month', '2026-07-01', '2026-07-31'],
    ['next_month', '2026-09-01', '2026-09-30'],
    ['this_quarter', '2026-07-01', '2026-09-30'],
    ['this_year', '2026-01-01', '2026-12-31'],
    ['last_year', '2025-01-01', '2025-12-31'],
    ['last_7_days', '2026-08-07', '2026-08-13'],
    ['last_30_days', '2026-07-15', '2026-08-13'],
  ])('%s → %s..%s', (name, start, end) => {
    expect(clock.range(name)).toMatchObject({ start, end, timeZone: 'Asia/Kolkata' });
  });

  test('an unknown range is null rather than a guess', () => {
    // Inventing a default window is how "revenue" silently becomes
    // "revenue this month". The caller must ask for clarification instead.
    expect(clock.range('since_the_gym_opened')).toBeNull();
  });

  test('free text is matched, and unmatched text yields null', () => {
    expect(clock.rangeFromText('how much did we make last month?'))
      .toMatchObject({ name: 'last_month', start: '2026-07-01' });
    expect(clock.rangeFromText("what's the revenue?")).toBeNull();
  });
});

describe('the date reaches the model', () => {
  test('the system prompt states the date, the weekday and the timezone', async () => {
    const { app, provider } = appWith({ erp: okErp(), clock: fixedClock(AT) });

    await post(app, { clientId: 'c-1', message: 'When does their package expire?' });

    const sys = systemOf(provider);
    expect(sys).toContain('2026-08-13');
    expect(sys).toContain('Thursday');          // "this week" is unresolvable without it
    expect(sys).toContain('Asia/Kolkata');
    expect(sys).toMatch(/do not assume utc/i);
  });

  test('describe() carries the studio wall-clock time, not the server\'s', () => {
    // 09:15Z is 14:45 in Asia/Kolkata.
    expect(fixedClock(AT).describe()).toContain('14:45');
  });
});

describe('the timezone is validated at boot', () => {
  test('a bogus zone refuses to start rather than failing per-request', () => {
    expect(() => load({ ...BASE_ENV, STUDIO_TIMEZONE: 'Mars/Olympus_Mons' }))
      .toThrow(/not a valid IANA timezone/i);
  });

  test('a real zone other than the default is accepted', () => {
    expect(load({ ...BASE_ENV, STUDIO_TIMEZONE: 'Europe/London' }).STUDIO_TIMEZONE)
      .toBe('Europe/London');
  });

  test('a studio in a DST zone gets civil dates, not shifted ones', () => {
    // 30 March 2025 01:30 UTC is inside the hour Europe/London skips.
    // Civil-date arithmetic must be unaffected by that.
    const c = createStudioClock({ timeZone: 'Europe/London', now: () => new Date('2025-03-30T01:30:00Z') });
    expect(c.today()).toBe('2025-03-30');
    expect(c.range('this_month')).toMatchObject({ start: '2025-03-01', end: '2025-03-31' });
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { loadCalendarSync, REF, stamp } from './load-gs.js';

let cs;
beforeAll(() => {
  cs = loadCalendarSync();
});

/** Run a parse + interval build the way csBuildEvents does. */
function interval(line, order = 'MDY', duration = 60) {
  const parsed = cs.csParseLine(line, REF, order);
  return parsed ? cs.csToInterval(parsed, duration) : null;
}

describe('date formats', () => {
  it('reads ISO dates', () => {
    expect(cs.csFindDate('due 2026-09-14 please', REF, 'MDY'))
      .toMatchObject({ year: 2026, month: 9, day: 14 });
  });

  it('reads month-first written dates', () => {
    expect(cs.csFindDate('September 14, 2026', REF, 'MDY'))
      .toMatchObject({ year: 2026, month: 9, day: 14 });
  });

  it('reads day-first written dates with ordinals', () => {
    expect(cs.csFindDate('14th Sept 2026', REF, 'MDY'))
      .toMatchObject({ year: 2026, month: 9, day: 14 });
  });

  it('honours DATE_ORDER for ambiguous numeric dates', () => {
    expect(cs.csFindDate('on 9/10/2026', REF, 'MDY')).toMatchObject({ month: 9, day: 10 });
    expect(cs.csFindDate('on 9/10/2026', REF, 'DMY')).toMatchObject({ month: 10, day: 9 });
  });

  it('ignores DATE_ORDER when only one reading is a real date', () => {
    // 14 cannot be a month, so this is 14 September under either setting.
    expect(cs.csFindDate('on 14/9/2026', REF, 'MDY')).toMatchObject({ month: 9, day: 14 });
  });

  it('expands two-digit years', () => {
    expect(cs.csFindDate('9/14/26', REF, 'MDY')).toMatchObject({ year: 2026, month: 9, day: 14 });
  });

  it('rejects impossible dates rather than guessing', () => {
    expect(cs.csFindDate('13/45/2026', REF, 'MDY')).toBeNull();
    expect(cs.csFindDate('February 30, 2026', REF, 'MDY')).toBeNull();
  });

  it('takes the written date when a weekday prefix precedes it', () => {
    expect(cs.csFindDate('Sat 14 Sep', REF, 'MDY')).toMatchObject({ month: 9, day: 14 });
  });
});

describe('year inference', () => {
  it('rolls forward to the next occurrence for a bare date', () => {
    // Reference is 1 Sep 2026, so a bare "March 3" means 2027.
    expect(cs.csFindDate('March 3', REF, 'MDY')).toMatchObject({ year: 2027, month: 3, day: 3 });
  });

  it('keeps a date just behind the reference in the current year', () => {
    // A roster mailed on 1 Sep can still reference late August.
    expect(cs.csFindDate('August 28', REF, 'MDY')).toMatchObject({ year: 2026, month: 8, day: 28 });
  });

  it('only offers 29 February in a leap year', () => {
    const ref = new Date(2026, 11, 1);
    expect(cs.csFindDate('Feb 29', ref, 'MDY')).toMatchObject({ year: 2028, month: 2, day: 29 });
  });
});

describe('time formats', () => {
  it('reads a bare 12-hour time', () => {
    expect(cs.csFindTimeRange('doors at 7pm')).toMatchObject({ start: { hour: 19, minute: 0 }, end: null });
  });

  it('reads minutes with a colon or a dot', () => {
    expect(cs.csFindTimeRange('7:30 PM').start).toMatchObject({ hour: 19, minute: 30 });
    expect(cs.csFindTimeRange('7.30pm').start).toMatchObject({ hour: 19, minute: 30 });
  });

  it('reads 24-hour times', () => {
    expect(cs.csFindTimeRange('19:30').start).toMatchObject({ hour: 19, minute: 30 });
  });

  it('maps noon and midnight correctly', () => {
    expect(cs.csFindTimeRange('12am').start).toMatchObject({ hour: 0 });
    expect(cs.csFindTimeRange('12pm').start).toMatchObject({ hour: 12 });
  });

  it('reads ranges across several separators', () => {
    for (const line of ['7pm-11pm', '7pm to 11pm', '19:00 – 23:00', '7pm until 11pm']) {
      const range = cs.csFindTimeRange(line);
      expect(stampTime(range), line).toBe('19:00-23:00');
    }
  });

  it('applies a trailing meridiem to an unmarked start', () => {
    expect(stampTime(cs.csFindTimeRange('7-11pm'))).toBe('19:00-23:00');
  });

  it('does not push the start past the end when inheriting a meridiem', () => {
    // "11-1pm" is 11am to 1pm, not 11pm to 1pm.
    expect(stampTime(cs.csFindTimeRange('11-1pm'))).toBe('11:00-13:00');
  });

  it('treats two unrelated times as a single start, not a range', () => {
    const range = cs.csFindTimeRange('call at 9am, invoice ref 5:30');
    expect(range.start).toMatchObject({ hour: 9, minute: 0 });
    expect(range.end).toBeNull();
  });

  it('rejects impossible clock readings', () => {
    expect(cs.csFindTimeRange('25:00')).toBeNull();
    expect(cs.csFindTimeRange('19:75')).toBeNull();
  });

  function stampTime(range) {
    const pad = (n) => String(n).padStart(2, '0');
    if (!range) return null;
    const start = `${pad(range.start.hour)}:${pad(range.start.minute)}`;
    return range.end ? `${start}-${pad(range.end.hour)}:${pad(range.end.minute)}` : start;
  }
});

describe('dates and times on the same line', () => {
  it('does not read a clock time as a date', () => {
    // The regression this guards: "09:00-17:00" contains "00-17", which a
    // numeric date pattern will happily match if times are not masked first.
    const result = interval('Mon 14 Sep 09:00-17:00');
    expect(stamp(result.start)).toBe('2026-09-14 09:00');
    expect(stamp(result.end)).toBe('2026-09-14 17:00');
  });

  it('does not read a dotted time as a date', () => {
    const result = interval('Sept 14 at 7.30pm');
    expect(stamp(result.start)).toBe('2026-09-14 19:30');
  });

  it('rolls an overnight shift into the next day', () => {
    const result = interval('Wed 16 Sep 22:00-06:00');
    expect(stamp(result.start)).toBe('2026-09-16 22:00');
    expect(stamp(result.end)).toBe('2026-09-17 06:00');
  });

  it('falls back to the default duration when no end time is given', () => {
    const result = interval('Sept 14, 7pm', 'MDY', 90);
    expect(stamp(result.end)).toBe('2026-09-14 20:30');
  });

  it('marks a date with no time as all-day', () => {
    const result = interval('Deadline: September 14');
    expect(result.allDay).toBe(true);
    expect(stamp(result.start)).toBe('2026-09-14 00:00');
  });

  it('returns nothing for a line with no date', () => {
    expect(interval('Thanks, talk soon')).toBeNull();
    expect(interval('meeting at 7pm')).toBeNull();
  });
});

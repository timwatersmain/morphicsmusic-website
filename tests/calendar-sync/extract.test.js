import { describe, it, expect, beforeAll } from 'vitest';
import { loadCalendarSync, REF, stamp } from './load-gs.js';

let cs;
beforeAll(() => {
  cs = loadCalendarSync();
});

const OPTS = { dateOrder: 'MDY', defaultDurationMinutes: 60 };

/** Readable shape for asserting on a list of extracted shifts. */
function summarise(shifts) {
  return shifts.map((s) => `${stamp(s.start)} -> ${stamp(s.end)} ${s.label}`.trim());
}

describe('roster extraction', () => {
  it('reads one event per dated row', () => {
    const roster = [
      'Your schedule for the week of Sept 14',
      'Mon 14 Sep: 9:00-17:00 Front desk',
      'Wed 16 Sep: 12:00-20:00 Bar',
      'Fri 18 Sep: 17:00-01:00 Close',
    ].join('\n');

    expect(summarise(cs.csExtractShifts(roster, REF, OPTS))).toEqual([
      '2026-09-14 09:00 -> 2026-09-14 17:00 Front desk',
      '2026-09-16 12:00 -> 2026-09-16 20:00 Bar',
      '2026-09-18 17:00 -> 2026-09-19 01:00 Close',
    ]);
  });

  it('ignores the header line, which has a date but no time', () => {
    // Without this, every roster gains a phantom all-day event for the week
    // it covers — the fastest way to make the calendar untrustworthy.
    const shifts = cs.csExtractShifts('Week commencing 14 September\nMon 14 Sep 9:00-17:00', REF, OPTS);
    expect(shifts).toHaveLength(1);
    expect(stamp(shifts[0].start)).toBe('2026-09-14 09:00');
  });

  it('skips days marked off', () => {
    const roster = [
      'Mon 14 Sep: 9:00-17:00',
      'Tue 15 Sep: OFF',
      'Wed 16 Sep: rest day',
      'Thu 17 Sep: 9:00-17:00',
    ].join('\n');
    expect(cs.csExtractShifts(roster, REF, OPTS)).toHaveLength(2);
  });

  it('skips footer boilerplate', () => {
    const roster = 'Mon 14 Sep 9:00-17:00\nUnsubscribe from these emails: sent 14 Sep 10:00';
    expect(cs.csExtractShifts(roster, REF, OPTS)).toHaveLength(1);
  });

  it('reads rows that arrive as one pipe-separated line', () => {
    // HTML roster tables flatten to this when Gmail renders a plain-text body.
    const shifts = cs.csExtractShifts('Mon 14 Sep | 9:00-17:00 | Front desk', REF, OPTS);
    expect(shifts).toHaveLength(1);
    expect(summarise(shifts)[0]).toBe('2026-09-14 09:00 -> 2026-09-14 17:00 Front desk');
  });

  it('collapses a shift listed twice in the same email', () => {
    const roster = 'Summary\nMon 14 Sep 9:00-17:00\nDetail\nMon 14 Sep 9:00-17:00 Front desk';
    expect(cs.csExtractShifts(roster, REF, OPTS)).toHaveLength(1);
  });

  it('returns the rows in chronological order regardless of listing order', () => {
    const roster = 'Fri 18 Sep 17:00-23:00\nMon 14 Sep 9:00-17:00';
    const shifts = cs.csExtractShifts(roster, REF, OPTS);
    expect(stamp(shifts[0].start)).toBe('2026-09-14 09:00');
  });

  it('finds nothing in an email with no dated rows', () => {
    expect(cs.csExtractShifts('Hi, your schedule is on the portal. Thanks!', REF, OPTS)).toEqual([]);
  });
});

describe('single-event extraction', () => {
  it('prefers the subject when it carries the date and time', () => {
    const event = cs.csExtractSingle(
      'Confirmed: studio Sept 14, 7pm',
      'Looking forward to it. We are usually free on Sept 20 too.',
      REF,
      OPTS
    );
    expect(stamp(event.start)).toBe('2026-09-14 19:00');
  });

  it('falls back to the body when the subject has no date', () => {
    const event = cs.csExtractSingle('Booking confirmation', 'You are booked for 16 Sept at 8pm.', REF, OPTS);
    expect(stamp(event.start)).toBe('2026-09-16 20:00');
  });

  it('prefers a dated line with a time over an earlier bare date', () => {
    // A "sent on" or deadline line should not outrank the actual appointment.
    const event = cs.csExtractSingle('Booking', 'Issued September 2, 2026\nSession: Sept 14 at 7pm', REF, OPTS);
    expect(event.allDay).toBe(false);
    expect(stamp(event.start)).toBe('2026-09-14 19:00');
  });

  it('makes an all-day event from a date with no time', () => {
    const event = cs.csExtractSingle('Master deadline', 'Masters are due September 14.', REF, OPTS);
    expect(event.allDay).toBe(true);
    expect(stamp(event.start)).toBe('2026-09-14 00:00');
  });

  it('skips a bare date when the rule opts out of all-day events', () => {
    const opts = { ...OPTS, allDayIfNoTime: false };
    expect(cs.csExtractSingle('Deadline', 'Due September 14.', REF, opts)).toBeNull();
  });

  it('returns nothing when there is no date at all', () => {
    expect(cs.csExtractSingle('Hello', 'Just checking in, no dates here.', REF, OPTS)).toBeNull();
  });
});

describe('quoted replies', () => {
  it('drops the quoted chain so old dates are not re-read', () => {
    const body = 'Moved to Sept 20 at 8pm.\n\nOn Mon, 1 Sep 2026, Booker wrote:\n> See you Sept 14 at 7pm';
    const event = cs.csExtractSingle('Re: booking', cs.csStripQuotedText(body), REF, OPTS);
    expect(stamp(event.start)).toBe('2026-09-20 20:00');
  });

  it('drops a forwarded block', () => {
    const body = 'FYI\n---------- Forwarded message ----------\nFrom: x@example.com\nSept 14 at 7pm';
    expect(cs.csStripQuotedText(body).trim()).toBe('FYI');
  });
});

describe('sender names', () => {
  it('takes the display name out of a From header', () => {
    expect(cs.csFromName('"Jane Doe" <jane@example.com>')).toBe('Jane Doe');
    expect(cs.csFromName('Jane Doe <jane@example.com>')).toBe('Jane Doe');
  });

  it('falls back to the address when there is no display name', () => {
    expect(cs.csFromName('<jane@example.com>')).toBe('jane@example.com');
    expect(cs.csFromName('jane@example.com')).toBe('jane@example.com');
  });
});

describe('titles', () => {
  it('fills placeholders', () => {
    expect(cs.csRenderTemplate('Work — {shift}', { shift: 'Front desk' })).toBe('Work — Front desk');
  });

  it('drops an empty placeholder and the punctuation left dangling', () => {
    expect(cs.csRenderTemplate('Work — {shift}', { shift: '' })).toBe('Work');
  });

  it('drops unknown placeholders rather than printing braces', () => {
    expect(cs.csRenderTemplate('{subject} {nope}', { subject: 'Gig' })).toBe('Gig');
  });
});

describe('event identity', () => {
  const shiftRule = { id: 'work', mode: 'shifts', titleTemplate: 'Work — {shift}' };
  const singleRule = { id: 'bookings', mode: 'single', titleTemplate: '{subject}' };

  function context(overrides) {
    return {
      subject: 'Schedule',
      body: 'Mon 14 Sep 9:00-17:00 Front desk',
      from: 'rota@example.com',
      fromName: 'Rota',
      threadId: 'thread-1',
      messageId: 'msg-1',
      date: REF,
      ...overrides,
    };
  }

  it('gives a shift the same key when the same roster is re-sent', () => {
    // The re-send is a different message, so a message-based key would
    // duplicate every shift in the roster.
    const first = cs.csBuildEvents(shiftRule, context({ messageId: 'msg-1' }));
    const second = cs.csBuildEvents(shiftRule, context({ messageId: 'msg-2', threadId: 'thread-2' }));
    expect(first[0].key).toBe(second[0].key);
    expect(first[0].hash).toBe(second[0].hash);
  });

  it('gives different shifts different keys', () => {
    const events = cs.csBuildEvents(shiftRule, context({
      body: 'Mon 14 Sep 9:00-17:00\nTue 15 Sep 9:00-17:00',
    }));
    expect(events).toHaveLength(2);
    expect(events[0].key).not.toBe(events[1].key);
  });

  it('changes the hash but not the key when a shift moves', () => {
    // This is what drives update-in-place instead of a duplicate.
    const before = cs.csBuildEvents(shiftRule, context())[0];
    const after = cs.csBuildEvents(shiftRule, context({ body: 'Mon 14 Sep 9:00-17:00 Bar' }))[0];
    expect(after.key).toBe(before.key);
    expect(after.hash).not.toBe(before.hash);
  });

  it('keys a single event to its thread so a follow-up updates it', () => {
    const original = cs.csBuildEvents(singleRule, context({ body: 'Sept 14 at 7pm' }))[0];
    const followUp = cs.csBuildEvents(singleRule, context({
      messageId: 'msg-2',
      body: 'Moved to Sept 20 at 8pm',
    }))[0];
    expect(followUp.key).toBe(original.key);
    expect(stamp(followUp.start)).toBe('2026-09-20 20:00');
  });

  it('keeps events from different rules apart', () => {
    const shift = cs.csBuildEvents(shiftRule, context())[0];
    const other = cs.csBuildEvents({ ...shiftRule, id: 'other' }, context())[0];
    expect(shift.key).not.toBe(other.key);
  });

  it('titles a shift from its label and records where it came from', () => {
    const event = cs.csBuildEvents(shiftRule, context())[0];
    expect(event.title).toBe('Work — Front desk');
    expect(event.description).toContain('Parsed from: Mon 14 Sep 9:00-17:00 Front desk');
    expect(event.description).toContain('rule: work');
  });

  it('falls back to the subject when the template renders empty', () => {
    const event = cs.csBuildEvents(shiftRule, context({ body: 'Mon 14 Sep 9:00-17:00' }))[0];
    expect(event.title).toBe('Work');
  });
});

import { describe, it, expect } from 'vitest';
import { loadWithFakes, ruleQueryFor } from './fake-apps-script.js';
import { stamp } from './load-gs.js';

const MAIL_DATE = new Date(2026, 8, 1, 9, 0, 0); // 1 September 2026.

const WORK_RULE = {
  id: 'work',
  enabled: true,
  query: ruleQueryFor('work'),
  mode: 'shifts',
  titleTemplate: 'Work — {shift}',
  replaceWindow: true,
  colour: 'PALE_BLUE',
};

const BOOKING_RULE = {
  id: 'bookings',
  enabled: true,
  query: ruleQueryFor('bookings'),
  mode: 'single',
  titleTemplate: '{subject}',
};

function rosterThread(id, body, { date = MAIL_DATE, messageId = `${id}-m1` } = {}) {
  return {
    id,
    matches: ['work'],
    messages: [{ subject: 'Your schedule', body, from: 'Rota <rota@work.com>', id: messageId, date }],
  };
}

/** Run a sync against a fresh fake environment. */
function run(threads, rules, { dryRun = false } = {}) {
  const env = loadWithFakes(threads);
  env.context.CONFIG.DRY_RUN = dryRun;
  env.context.RULES = rules;
  const summary = env.context.syncCalendar();
  return { ...env, summary };
}

/** Readable view of what ended up on the calendar. */
function onCalendar(calendar) {
  return calendar.events
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((e) => `${stamp(e.start)} ${e.title}`);
}

const WEEK_ONE = [
  'Week of Sept 14',
  'Mon 14 Sep: 9:00-17:00 Front desk',
  'Wed 16 Sep: 12:00-20:00 Bar',
  'Fri 18 Sep: 17:00-23:00 Close',
].join('\n');

describe('a roster on an empty calendar', () => {
  it('creates one event per shift', () => {
    const { calendar, summary } = run([rosterThread('t1', WEEK_ONE)], [WORK_RULE]);
    expect(summary.created).toHaveLength(3);
    expect(onCalendar(calendar)).toEqual([
      '2026-09-14 09:00 Work — Front desk',
      '2026-09-16 12:00 Work — Bar',
      '2026-09-18 17:00 Work — Close',
    ]);
  });

  it('tags each event with its rule and a stable key', () => {
    const { calendar } = run([rosterThread('t1', WEEK_ONE)], [WORK_RULE]);
    for (const event of calendar.events) {
      expect(event.getTag('csRule')).toBe('work');
      expect(event.getTag('csKey')).toMatch(/^work\|2026-09-/);
      expect(event.getTag('csHash')).toBeTruthy();
    }
  });

  it('applies the rule colour and labels the thread', () => {
    const { calendar, threads } = run([rosterThread('t1', WEEK_ONE)], [WORK_RULE]);
    expect(calendar.events[0].colour).toBe('1');
    expect(threads[0].labels).toContain('Calendar Sync/Added');
  });
});

describe('the same roster arriving again', () => {
  it('changes nothing on a re-run', () => {
    // Re-running by hand, or a trigger firing twice, must not duplicate.
    const env = loadWithFakes([rosterThread('t1', WEEK_ONE)]);
    env.context.CONFIG.DRY_RUN = false;
    env.context.RULES = [WORK_RULE];

    expect(env.context.syncCalendar().created).toHaveLength(3);

    const second = env.context.syncCalendar();
    expect(second.created).toHaveLength(0);
    expect(second.unchanged).toBe(3);
    expect(env.calendar.events).toHaveLength(3);
  });

  it('does not duplicate when the roster is re-sent as a new email', () => {
    // A different message id and thread, same shifts: keying on the message
    // would give six events instead of three.
    const resent = run(
      [
        rosterThread('t1', WEEK_ONE),
        rosterThread('t2', WEEK_ONE, { messageId: 't2-m1', date: new Date(2026, 8, 2, 9, 0, 0) }),
      ],
      [WORK_RULE]
    );
    expect(resent.calendar.events).toHaveLength(3);
  });
});

describe('an amended roster', () => {
  const AMENDED = [
    'Week of Sept 14 (updated)',
    'Mon 14 Sep: 9:00-17:00 Front desk',
    'Wed 16 Sep: 14:00-22:00 Bar',
    // Friday's shift is gone.
  ].join('\n');

  /** Sync the original roster, then let the amendment arrive and sync again. */
  function amendedRun() {
    const env = loadWithFakes([rosterThread('t1', WEEK_ONE)]);
    env.context.CONFIG.DRY_RUN = false;
    env.context.RULES = [WORK_RULE];
    env.context.syncCalendar();

    env.addThread(rosterThread('t2', AMENDED, { messageId: 't2-m1', date: new Date(2026, 8, 3, 9, 0, 0) }));
    const summary = env.context.syncCalendar();
    return { ...env, summary };
  }

  it('leaves one copy of a shift whose hours changed', () => {
    // A shift is identified by when it starts, so re-timing it is a removal
    // plus a creation rather than an edit. What matters is the net result:
    // exactly one Bar shift, at the new time.
    const { calendar } = amendedRun();
    const bar = calendar.events.filter((e) => e.title === 'Work — Bar');
    expect(bar).toHaveLength(1);
    expect(stamp(bar[0].start)).toBe('2026-09-16 14:00');
  });

  it('removes a shift the new roster no longer lists', () => {
    // Friday is absent from the amendment, and the amendment is the newer word
    // on that week — so the shift has to leave the calendar. The old Wednesday
    // slot goes with it, having been superseded by the re-timed one.
    const { calendar, summary } = amendedRun();
    expect(onCalendar(calendar)).toEqual([
      '2026-09-14 09:00 Work — Front desk',
      '2026-09-16 14:00 Work — Bar',
    ]);
    expect(summary.removed.join('\n')).toContain('Close');
    expect(summary.removed).toHaveLength(2);
  });

  it('leaves the amended calendar alone on a further re-run', () => {
    const { context, calendar } = amendedRun();
    const summary = context.syncCalendar();
    expect(summary.created).toHaveLength(0);
    expect(summary.removed).toHaveLength(0);
    expect(calendar.events).toHaveLength(2);
  });

  it('does not disturb a roster for a different week', () => {
    // Superseding is scoped to overlapping days; next week's roster stands.
    const env = loadWithFakes([rosterThread('t1', WEEK_ONE)]);
    env.context.CONFIG.DRY_RUN = false;
    env.context.RULES = [WORK_RULE];
    env.context.syncCalendar();

    env.addThread(rosterThread('t2', 'Week of Sept 21\nMon 21 Sep: 9:00-17:00 Front desk', {
      messageId: 't2-m1',
      date: new Date(2026, 8, 19, 9, 0, 0),
    }));
    const summary = env.context.syncCalendar();

    expect(summary.removed).toHaveLength(0);
    expect(onCalendar(env.calendar)).toHaveLength(4);
  });
});

describe('what cleanup must never touch', () => {
  const AMENDED = 'Week of Sept 14\nMon 14 Sep: 9:00-17:00 Front desk';

  function withOtherEvents() {
    const env = loadWithFakes([rosterThread('t1', WEEK_ONE)]);
    env.context.CONFIG.DRY_RUN = false;
    env.context.RULES = [WORK_RULE];
    env.context.syncCalendar();

    // Both sit inside the week the amendment will sweep.
    env.calendar.addManualEvent('Dentist', new Date(2026, 8, 16, 10, 0), new Date(2026, 8, 16, 11, 0));
    const foreign = env.calendar.createEvent(
      'Gig',
      new Date(2026, 8, 18, 20, 0),
      new Date(2026, 8, 18, 23, 0),
      {}
    );
    foreign.setTag('csRule', 'bookings');
    foreign.setTag('csKey', 'bookings|thread-x');

    env.addThread(rosterThread('t2', AMENDED, { messageId: 't2-m1', date: new Date(2026, 8, 3, 9, 0, 0) }));
    env.context.syncCalendar();
    return env;
  }

  it('leaves events the user added by hand alone', () => {
    const { calendar } = withOtherEvents();
    expect(onCalendar(calendar)).toContain('2026-09-16 10:00 Dentist');
  });

  it('leaves another rule\'s events alone', () => {
    const { calendar } = withOtherEvents();
    expect(onCalendar(calendar)).toContain('2026-09-18 20:00 Gig');
  });

  it('still removes its own dropped shift', () => {
    const { calendar } = withOtherEvents();
    expect(onCalendar(calendar).filter((e) => e.includes('Work'))).toEqual([
      '2026-09-14 09:00 Work — Front desk',
    ]);
  });
});

describe('single-event rules', () => {
  it('creates one event from a booking email', () => {
    const { calendar } = run(
      [{
        id: 'b1',
        matches: ['bookings'],
        messages: [{
          subject: 'Studio Sept 14, 7pm',
          body: 'Confirmed.',
          from: 'Studio <studio@example.com>',
          id: 'b1-m1',
          date: MAIL_DATE,
        }],
      }],
      [BOOKING_RULE]
    );
    expect(onCalendar(calendar)).toEqual(['2026-09-14 19:00 Studio Sept 14, 7pm']);
  });

  it('moves the event when a later reply reschedules it', () => {
    // Same thread, so the follow-up updates rather than adding a second entry.
    const { calendar } = run(
      [{
        id: 'b1',
        matches: ['bookings'],
        messages: [
          {
            subject: 'Studio Sept 14, 7pm',
            body: 'Confirmed.',
            from: 'Studio <studio@example.com>',
            id: 'b1-m1',
            date: MAIL_DATE,
          },
          {
            subject: 'Re: Studio',
            body: 'Moved to Sept 20 at 8pm.',
            from: 'Studio <studio@example.com>',
            id: 'b1-m2',
            date: new Date(2026, 8, 2, 9, 0, 0),
          },
        ],
      }],
      [BOOKING_RULE]
    );
    expect(calendar.events).toHaveLength(1);
    expect(stamp(calendar.events[0].start)).toBe('2026-09-20 20:00');
  });

  it('labels an email it matched but could not read a date from', () => {
    const { calendar, threads, summary } = run(
      [{
        id: 'b1',
        matches: ['bookings'],
        messages: [{
          subject: 'Quick question',
          body: 'Are you around sometime soon?',
          from: 'Studio <studio@example.com>',
          id: 'b1-m1',
          date: MAIL_DATE,
        }],
      }],
      [BOOKING_RULE]
    );
    expect(calendar.events).toHaveLength(0);
    expect(summary.unparsed).toHaveLength(1);
    expect(threads[0].labels).toContain('Calendar Sync/No Date Found');
  });
});

describe('dry run', () => {
  it('reports what it would create without writing anything', () => {
    const { calendar, threads, summary, logs } = run([rosterThread('t1', WEEK_ONE)], [WORK_RULE], { dryRun: true });
    expect(summary.created).toHaveLength(3);
    expect(calendar.events).toHaveLength(0);
    expect(threads[0].labels).toEqual([]);
    expect(logs.join('\n')).toContain('DRY RUN');
  });

  it('reports a removal without performing it', () => {
    const env = loadWithFakes([rosterThread('t1', WEEK_ONE)]);
    env.context.RULES = [WORK_RULE];

    env.context.CONFIG.DRY_RUN = false;
    env.context.syncCalendar();
    expect(env.calendar.events).toHaveLength(3);

    // The amendment drops Friday; a dry run should say so and change nothing.
    env.addThread(rosterThread('t2', 'Week of Sept 14\nMon 14 Sep: 9:00-17:00 Front desk', {
      messageId: 't2-m1',
      date: new Date(2026, 8, 3, 9, 0, 0),
    }));

    env.context.CONFIG.DRY_RUN = true;
    const summary = env.context.syncCalendar();
    expect(summary.removed.length).toBeGreaterThan(0);
    expect(env.calendar.events).toHaveLength(3);
  });
});

describe('config errors', () => {
  it('refuses to run on a duplicate rule id', () => {
    const env = loadWithFakes([]);
    env.context.RULES = [WORK_RULE, { ...WORK_RULE }];
    expect(() => env.context.syncCalendar()).toThrow(/duplicate rule id: work/);
  });
});

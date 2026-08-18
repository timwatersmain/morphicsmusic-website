// Pure-logic tests for functions/_lib/community/engagement.ts — no D1, no
// fetch. Endpoint-level wiring (D1 persistence, requireFan, rate limiting)
// is covered separately in tests/community/engagement-endpoint.test.js.

import { describe, it, expect } from 'vitest';
import {
  applyEngagementReport, utcDayKey,
  CLICK_XP_DAILY_CAP, TIME_XP_DAILY_CAP, TIME_XP_WINDOW_SECONDS, TIME_XP_PER_WINDOW,
  LISTEN_PLAY_XP, LISTEN_COMPLETE_XP, LISTEN_XP_DAILY_CAP, LISTEN_COMPLETION_FRACTION,
  type EngagementState,
} from '../../functions/_lib/community/engagement';

const DAY = '2026-08-17';

function emptyState(overrides: Partial<EngagementState> = {}): EngagementState {
  return {
    day: DAY, clicksToday: 0, activeSecondsToday: 0, listenXpToday: 0,
    listened: {}, lastSeq: 0, lifetimeEp: 0,
    ...overrides,
  };
}

describe('utcDayKey', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(utcDayKey(Date.UTC(2026, 7, 17, 23, 59))).toBe('2026-08-17');
  });
});

describe('applyEngagementReport — clicks', () => {
  it('awards 1 EP per unique element up to the cap', () => {
    const r = applyEngagementReport(
      emptyState(), { newClicks: 5, activeSeconds: 0, listens: [], seq: 1 }, DAY,
    );
    expect(r.awardedEp).toBe(5);
    expect(r.state.clicksToday).toBe(5);
    expect(r.state.lifetimeEp).toBe(5);
  });

  it('caps click XP at CLICK_XP_DAILY_CAP per day, across multiple reports', () => {
    let state = emptyState();
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const r = applyEngagementReport(state, { newClicks: 5, activeSeconds: 0, listens: [], seq: i + 1 }, DAY);
      state = r.state;
      total += r.awardedEp;
    }
    expect(state.clicksToday).toBe(CLICK_XP_DAILY_CAP);
    expect(total).toBe(CLICK_XP_DAILY_CAP);
  });

  it('a client-claimed astronomical click count is clamped, not trusted', () => {
    const r = applyEngagementReport(
      emptyState(), { newClicks: 999999, activeSeconds: 0, listens: [], seq: 1 }, DAY,
    );
    expect(r.awardedEp).toBe(CLICK_XP_DAILY_CAP);
    expect(r.state.clicksToday).toBe(CLICK_XP_DAILY_CAP);
  });
});

describe('applyEngagementReport — time', () => {
  it('awards TIME_XP_PER_WINDOW per full TIME_XP_WINDOW_SECONDS window, accrued across reports (a single report is clamped below one window — see MAX_ACTIVE_SECONDS_PER_REPORT)', () => {
    let state = emptyState();
    let total = 0;
    let seq = 1;
    let reported = 0;
    // 90s/report (the per-report clamp) until one full 600s window is crossed.
    while (reported < TIME_XP_WINDOW_SECONDS) {
      const r = applyEngagementReport(state, { newClicks: 0, activeSeconds: 90, listens: [], seq: seq++ }, DAY);
      state = r.state;
      total += r.awardedEp;
      reported += 90;
    }
    expect(total).toBe(TIME_XP_PER_WINDOW);
  });

  it('caps time XP at TIME_XP_DAILY_CAP per day', () => {
    let state = emptyState();
    let total = 0;
    // Report far more active seconds than a day allows, in small enough
    // per-report chunks to stay under MAX_ACTIVE_SECONDS_PER_REPORT.
    for (let i = 0; i < 40; i++) {
      const r = applyEngagementReport(
        state, { newClicks: 0, activeSeconds: 90, listens: [], seq: i + 1 }, DAY,
      );
      state = r.state;
      total += r.awardedEp;
    }
    expect(state.activeSecondsToday).toBeGreaterThanOrEqual(TIME_XP_DAILY_CAP * (TIME_XP_WINDOW_SECONDS / TIME_XP_PER_WINDOW));
    expect(total).toBe(TIME_XP_DAILY_CAP);
  });

  it('idle/hidden time never reaches this function at all — the client gates that (see engagement-tracker.js); a report with 0 active_seconds awards 0 time XP', () => {
    const r = applyEngagementReport(
      emptyState(), { newClicks: 0, activeSeconds: 0, listens: [], seq: 1 }, DAY,
    );
    expect(r.awardedEp).toBe(0);
  });

  it('clamps an implausible single-report active-seconds claim', () => {
    const r = applyEngagementReport(
      emptyState(), { newClicks: 0, activeSeconds: 999999, listens: [], seq: 1 }, DAY,
    );
    // MAX_ACTIVE_SECONDS_PER_REPORT (90s) is well under one full 600s
    // window, so a single spoofed report earns 0 time XP no matter how
    // large the claim.
    expect(r.awardedEp).toBe(0);
  });
});

describe('applyEngagementReport — client-supplied XP is never trusted', () => {
  it('ignores any xp/ep/amount-shaped field a client might add — only newClicks/activeSeconds/listens matter', () => {
    const report = {
      newClicks: 1, activeSeconds: 0, listens: [], seq: 1,
      // @ts-expect-error — deliberately simulating a hostile payload shape
      xp: 999999, ep: 999999, awarded_ep: 999999,
    };
    const r = applyEngagementReport(emptyState(), report, DAY);
    expect(r.awardedEp).toBe(1);
  });
});

describe('applyEngagementReport — replay protection', () => {
  it('a replayed report (same seq) awards nothing the second time', () => {
    const first = applyEngagementReport(
      emptyState(), { newClicks: 3, activeSeconds: 0, listens: [], seq: 5 }, DAY,
    );
    expect(first.awardedEp).toBe(3);
    const replay = applyEngagementReport(
      first.state, { newClicks: 3, activeSeconds: 0, listens: [], seq: 5 }, DAY,
    );
    expect(replay.awardedEp).toBe(0);
    expect(replay.state.clicksToday).toBe(3);
    expect(replay.state.lifetimeEp).toBe(3);
  });

  it('an out-of-order (lower seq) report is also treated as a no-op', () => {
    const first = applyEngagementReport(
      emptyState(), { newClicks: 1, activeSeconds: 0, listens: [], seq: 10 }, DAY,
    );
    const stale = applyEngagementReport(
      first.state, { newClicks: 1, activeSeconds: 0, listens: [], seq: 3 }, DAY,
    );
    expect(stale.awardedEp).toBe(0);
  });
});

describe('applyEngagementReport — day rollover', () => {
  it('rolls the day over, resetting today counters but keeping lifetime EP and lastSeq', () => {
    const yesterday = applyEngagementReport(
      emptyState({ day: null }), { newClicks: 25, activeSeconds: 0, listens: [], seq: 1 }, '2026-08-16',
    );
    expect(yesterday.state.clicksToday).toBe(25);

    const today = applyEngagementReport(
      yesterday.state, { newClicks: 5, activeSeconds: 0, listens: [], seq: 2 }, '2026-08-17',
    );
    expect(today.state.day).toBe('2026-08-17');
    expect(today.state.clicksToday).toBe(5); // fresh cap room, not still maxed from yesterday
    expect(today.state.lifetimeEp).toBe(30); // 25 (yesterday) + 5 (today)
  });

  it('a stale seq from just before midnight does not replay after rollover', () => {
    const yesterday = applyEngagementReport(
      emptyState({ day: null }), { newClicks: 1, activeSeconds: 0, listens: [], seq: 100 }, '2026-08-16',
    );
    const today = applyEngagementReport(
      yesterday.state, { newClicks: 1, activeSeconds: 0, listens: [], seq: 100 }, '2026-08-17',
    );
    expect(today.awardedEp).toBe(0);
  });
});

describe('applyEngagementReport — listening', () => {
  const key = 'perception-01';

  it('awards LISTEN_PLAY_XP on genuine start', () => {
    const r = applyEngagementReport(
      emptyState(),
      { newClicks: 0, activeSeconds: 0, seq: 1, listens: [{ key, started: true, progressSeconds: 0, durationSeconds: 30 }] },
      DAY,
    );
    expect(r.awardedEp).toBe(LISTEN_PLAY_XP);
    expect(r.state.listened[key]).toEqual({ played: true, completed: false });
  });

  it('awards LISTEN_COMPLETE_XP on top once genuine forward progress reaches the completion fraction — 6 total, not 9', () => {
    const start = applyEngagementReport(
      emptyState(),
      { newClicks: 0, activeSeconds: 0, seq: 1, listens: [{ key, started: true, progressSeconds: 0, durationSeconds: 30 }] },
      DAY,
    );
    const complete = applyEngagementReport(
      start.state,
      {
        newClicks: 0, activeSeconds: 0, seq: 2,
        listens: [{ key, started: false, progressSeconds: 30 * LISTEN_COMPLETION_FRACTION, durationSeconds: 30 }],
      },
      DAY,
    );
    expect(complete.awardedEp).toBe(LISTEN_COMPLETE_XP);
    expect(start.awardedEp + complete.awardedEp).toBe(LISTEN_PLAY_XP + LISTEN_COMPLETE_XP);
    expect(start.awardedEp + complete.awardedEp).toBe(6);
    expect(complete.state.listened[key]).toEqual({ played: true, completed: true });
  });

  it('refuses a completion claim without real progression evidence (progress far short of duration)', () => {
    const start = applyEngagementReport(
      emptyState(),
      { newClicks: 0, activeSeconds: 0, seq: 1, listens: [{ key, started: true, progressSeconds: 0, durationSeconds: 30 }] },
      DAY,
    );
    // Client claims "completed" via a large progressSeconds, but it falls
    // short of LISTEN_COMPLETION_FRACTION of the reported duration — e.g. a
    // seek to near the end without ever accumulating forward-progress time
    // would never make it into progressSeconds in the first place (that
    // dedup lives client-side in engagement-tracker.js), but even a raw,
    // too-small progress claim earns nothing here.
    const notComplete = applyEngagementReport(
      start.state,
      { newClicks: 0, activeSeconds: 0, seq: 2, listens: [{ key, started: false, progressSeconds: 5, durationSeconds: 30 }] },
      DAY,
    );
    expect(notComplete.awardedEp).toBe(0);
    expect(notComplete.state.listened[key].completed).toBe(false);
  });

  it('the same track earns the play award at most once per day', () => {
    const first = applyEngagementReport(
      emptyState(),
      { newClicks: 0, activeSeconds: 0, seq: 1, listens: [{ key, started: true, progressSeconds: 0, durationSeconds: 30 }] },
      DAY,
    );
    const replay = applyEngagementReport(
      first.state,
      { newClicks: 0, activeSeconds: 0, seq: 2, listens: [{ key, started: true, progressSeconds: 0, durationSeconds: 30 }] },
      DAY,
    );
    expect(replay.awardedEp).toBe(0);
  });

  it('the same track earns the completion award at most once per day, even replayed many times', () => {
    let state = emptyState();
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const r = applyEngagementReport(
        state,
        {
          newClicks: 0, activeSeconds: 0, seq: i + 1,
          listens: [{ key, started: i === 0, progressSeconds: 30, durationSeconds: 30 }],
        },
        DAY,
      );
      state = r.state;
      total += r.awardedEp;
    }
    expect(total).toBe(LISTEN_PLAY_XP + LISTEN_COMPLETE_XP);
  });

  it('caps aggregate listening XP at LISTEN_XP_DAILY_CAP per day', () => {
    let state = emptyState();
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const trackKey = `track-${i}`;
      const r = applyEngagementReport(
        state,
        {
          newClicks: 0, activeSeconds: 0, seq: i + 1,
          listens: [{ key: trackKey, started: true, progressSeconds: 30, durationSeconds: 30 }],
        },
        DAY,
      );
      state = r.state;
      total += r.awardedEp;
    }
    expect(total).toBe(LISTEN_XP_DAILY_CAP);
    expect(state.listenXpToday).toBe(LISTEN_XP_DAILY_CAP);
  });

  it('listening EP flows into lifetimeEp exactly like clicks and time', () => {
    const r = applyEngagementReport(
      emptyState(),
      {
        // 90s is the max a single report can claim (MAX_ACTIVE_SECONDS_PER_REPORT),
        // which is under one full TIME_XP_WINDOW_SECONDS — so this report's
        // time contribution is legitimately 0; the point of this test is
        // that clicks + listening still flow through untouched alongside it.
        newClicks: 2, activeSeconds: 90, seq: 1,
        listens: [{ key, started: true, progressSeconds: 30, durationSeconds: 30 }],
      },
      DAY,
    );
    expect(r.awardedEp).toBe(2 + 0 + LISTEN_PLAY_XP + LISTEN_COMPLETE_XP);
    expect(r.state.lifetimeEp).toBe(r.awardedEp);
  });
});

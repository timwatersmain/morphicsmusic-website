// Pure engagement-EP computation. No D1, no KV, no fetch, no Date.now() side
// effects — the caller (functions/api/community/engagement.ts) gathers the
// stored per-day state, the client's report, and today's date key, and
// passes them in here. Mirrors ep.ts's shape deliberately: weights/caps as
// named constants in ONE place, pure functions, D1 access lives elsewhere.
//
// THREAT MODEL this module exists to defeat: the owner asked for "1 XP per
// unique click" and "5 XP per 10 minutes on site" with no other guardrail.
// As specified that is farmable in under a minute — a script that clicks in
// a loop, or a tab left open overnight. Every cap/gate below exists because
// of that, not because the base rates needed changing:
//   - clicks are deduped to "distinct interactive element, once per day"
//     (see the client's element-key logic in engagement-tracker.js) and
//     capped at CLICK_XP_DAILY_CAP regardless of how many are reported;
//   - time only accrues while the client says the tab was VISIBLE and there
//     was real interaction within the last few minutes (also enforced
//     client-side — see engagement-tracker.js's IDLE_THRESHOLD_MS — and
//     sanity-clamped again here per report so one spoofed report can't claim
//     an implausible chunk of time);
//   - listening XP requires genuine forward progress through the preview,
//     not just an `ended` event (trivially reachable by seeking) — see
//     applyListenEntry's LISTEN_COMPLETION_FRACTION check — and the same
//     track can only pay out once per day for each of the play/complete
//     awards;
//   - every counter is a per-fan, per-day server-side value the client can
//     only nudge forward by reporting *what happened*, never by reporting an
//     XP amount directly. The server derives the award every time.

// ── Clicks ───────────────────────────────────────────────────────────────
export const CLICK_XP_PER_ELEMENT = 1;
export const CLICK_XP_DAILY_CAP = 25;
// A single report claiming more brand-new unique elements than this is not
// plausible per-minute human interaction — clamp rather than trust it.
export const MAX_NEW_CLICKS_PER_REPORT = CLICK_XP_DAILY_CAP;

// ── Time on site ─────────────────────────────────────────────────────────
export const TIME_XP_PER_WINDOW = 5;
export const TIME_XP_WINDOW_SECONDS = 600; // 10 minutes
export const TIME_XP_DAILY_CAP = 30; // an hour of genuine, active, visible use
// The client heartbeats at most once a minute (see engagement-tracker.js's
// HEARTBEAT_INTERVAL_MS); this is comfortably above that to tolerate jitter
// and a backgrounded-tab flush, but far below "left it running overnight".
export const MAX_ACTIVE_SECONDS_PER_REPORT = 90;

// ── Listening ────────────────────────────────────────────────────────────
// Reading of the owner's ask: a completed listen is worth 6 EP TOTAL, not 9
// — 3 on genuine playback start, another 3 on genuine completion. Starting
// and abandoning is 3; hearing it through is 6.
export const LISTEN_PLAY_XP = 3;
export const LISTEN_COMPLETE_XP = 3;
export const LISTEN_XP_DAILY_CAP = 30; // same order of magnitude as the other two caps
// "Start to finish" means accumulated FORWARD progress reached this fraction
// of the preview's own duration — these are short previews, not full
// tracks, so this is calibrated against whatever duration the client
// reports for THIS preview, never a fixed full-track length. Deliberately
// short of 1.0: timeupdate granularity means currentTime rarely lands
// exactly on duration even for a fully-heard preview.
export const LISTEN_COMPLETION_FRACTION = 0.9;
// Sanity clamp on client-reported progress/duration seconds — bounds a
// fabricated value without needing to know the real preview length here.
export const MAX_LISTEN_SECONDS = 600;
// A report claiming updates for more distinct tracks than this in one
// heartbeat is not plausible (a fan has one preview playing at a time) —
// clamp rather than trust it.
export const MAX_LISTEN_ENTRIES_PER_REPORT = 5;
// Bounds engagement_listened_today's JSON size against an abuse attempt that
// claims many distinct fake track keys — legitimate use never approaches
// this (the whole catalogue is far smaller). Once hit, further NEW keys
// that day are silently ignored (not recorded, not awarded); keys already
// being tracked keep working normally.
export const MAX_TRACKED_LISTEN_KEYS_PER_DAY = 100;

/** UTC calendar day key ('YYYY-MM-DD') for `nowMs` — the unit "per day" resets on. */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface ListenFlags {
  played: boolean;
  completed: boolean;
}

export interface EngagementState {
  /** UTC day the four *Today fields below apply to; null before the first-ever report. */
  day: string | null;
  /** Unique elements counted today — also the day's click XP, 1:1. 0..CLICK_XP_DAILY_CAP. */
  clicksToday: number;
  /** Seconds of visible+active time accrued today. Time XP is derived from this, never stored. */
  activeSecondsToday: number;
  /** Listening XP accrued today (play + complete awards, capped). 0..LISTEN_XP_DAILY_CAP. */
  listenXpToday: number;
  /** Track key -> which of the two per-track awards it already paid out today. */
  listened: Record<string, ListenFlags>;
  /** Last accepted client report id (Date.now() at send time) — a replay has seq <= this. */
  lastSeq: number;
  /** Lifetime total engagement EP — fed into ep.ts's computeEp as `engagementActions`. */
  lifetimeEp: number;
}

export interface ListenReportEntry {
  key: string;
  /** Whether the client observed genuine playback start for this key since its last report. */
  started: boolean;
  /** Accumulated genuine forward-progress seconds for this key (never counts backward/seek jumps). */
  progressSeconds: number;
  /** This preview's own duration in seconds, as reported by the client. */
  durationSeconds: number;
}

export interface EngagementReport {
  /** Count of newly-seen unique interactive elements since the client's last report. */
  newClicks: number;
  /** Seconds of visible+active time since the client's last report. */
  activeSeconds: number;
  listens: ListenReportEntry[];
  /** Client-generated monotonic report id (Date.now()). */
  seq: number;
}

export interface EngagementResult {
  state: EngagementState;
  /** EP actually added to lifetimeEp by this call. 0 for a replay/no-op report. */
  awardedEp: number;
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function timeXpFromSeconds(seconds: number): number {
  return Math.min(TIME_XP_DAILY_CAP, Math.floor(Math.max(0, seconds) / TIME_XP_WINDOW_SECONDS) * TIME_XP_PER_WINDOW);
}

/**
 * Apply one listen-report entry against the day's `listened` map. Returns a
 * NEW map (never mutates its input) plus the EP earned by this entry alone
 * (0, LISTEN_PLAY_XP, LISTEN_COMPLETE_XP, or both). Each of the two awards
 * pays out at most once per track key per day — that dedup lives entirely in
 * the `listened` map, independent of the aggregate LISTEN_XP_DAILY_CAP
 * applied by the caller.
 */
function applyListenEntry(
  listened: Record<string, ListenFlags>, entry: ListenReportEntry,
): { listened: Record<string, ListenFlags>; awarded: number } {
  const key = String(entry.key || '').slice(0, 128);
  if (!key) return { listened, awarded: 0 };

  const existing = listened[key];
  if (!existing && Object.keys(listened).length >= MAX_TRACKED_LISTEN_KEYS_PER_DAY) {
    // Storage-bound abuse guard — see MAX_TRACKED_LISTEN_KEYS_PER_DAY's doc
    // comment. Not an award decision: a legitimate fan never gets near this.
    return { listened, awarded: 0 };
  }
  const flags = existing || { played: false, completed: false };

  const duration = clamp(entry.durationSeconds, 0, MAX_LISTEN_SECONDS);
  const progress = clamp(entry.progressSeconds, 0, MAX_LISTEN_SECONDS);
  const genuinelyCompleted = duration > 0 && progress >= duration * LISTEN_COMPLETION_FRACTION;

  let awarded = 0;
  const next: ListenFlags = { ...flags };
  if (entry.started && !flags.played) { next.played = true; awarded += LISTEN_PLAY_XP; }
  if (genuinelyCompleted && !flags.completed) { next.completed = true; awarded += LISTEN_COMPLETE_XP; }

  if (awarded === 0) return { listened, awarded: 0 };
  return { listened: { ...listened, [key]: next }, awarded };
}

/**
 * The one function that decides how much EP a report is worth. Idempotent
 * against replay (same `seq` twice awards nothing the second time) and
 * against day rollover (crossing midnight UTC resets the day's counters
 * before the report is applied, never loses `lastSeq`/`lifetimeEp`).
 */
export function applyEngagementReport(
  state: EngagementState, report: EngagementReport, todayKey: string,
): EngagementResult {
  let { day, clicksToday, activeSecondsToday, listenXpToday, listened, lastSeq } = state;
  if (day !== todayKey) {
    day = todayKey;
    clicksToday = 0;
    activeSecondsToday = 0;
    listenXpToday = 0;
    listened = {};
    // lastSeq is NOT reset: it's a client-generated timestamp (Date.now()),
    // monotonically increasing across a day boundary regardless — resetting
    // it would let a replayed report from just before midnight UTC sneak
    // back in as "new" right after.
  }

  const seq = Number(report.seq) || 0;
  if (seq <= lastSeq) {
    // Replay, duplicate, or out-of-order report. Persist any day rollover
    // that happened above, but award nothing.
    return {
      state: { day, clicksToday, activeSecondsToday, listenXpToday, listened, lastSeq, lifetimeEp: state.lifetimeEp },
      awardedEp: 0,
    };
  }

  const newClicks = Math.floor(clamp(report.newClicks, 0, MAX_NEW_CLICKS_PER_REPORT));
  const activeSeconds = Math.floor(clamp(report.activeSeconds, 0, MAX_ACTIVE_SECONDS_PER_REPORT));

  const newClicksToday = Math.min(CLICK_XP_DAILY_CAP, clicksToday + newClicks);
  const newActiveSecondsToday = activeSecondsToday + activeSeconds;
  const clickDelta = newClicksToday - clicksToday;
  const timeDelta = timeXpFromSeconds(newActiveSecondsToday) - timeXpFromSeconds(activeSecondsToday);

  let nextListened = listened;
  let listenAwardedRaw = 0;
  for (const entry of (report.listens || []).slice(0, MAX_LISTEN_ENTRIES_PER_REPORT)) {
    const applied = applyListenEntry(nextListened, entry);
    nextListened = applied.listened;
    listenAwardedRaw += applied.awarded;
  }
  const newListenXpToday = Math.min(LISTEN_XP_DAILY_CAP, listenXpToday + listenAwardedRaw);
  const listenDelta = newListenXpToday - listenXpToday;

  const awardedEp = clickDelta + timeDelta + listenDelta;

  return {
    state: {
      day,
      clicksToday: newClicksToday,
      activeSecondsToday: newActiveSecondsToday,
      listenXpToday: newListenXpToday,
      listened: nextListened,
      lastSeq: seq,
      lifetimeEp: state.lifetimeEp + awardedEp,
    },
    awardedEp,
  };
}

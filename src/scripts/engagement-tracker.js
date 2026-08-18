// Site-wide engagement tracker. Reports "what happened" — unique interactive
// elements clicked, seconds of genuinely active visible-tab time, and
// preview-listen progress — to POST /api/community/engagement, which is the
// only place that turns any of it into EP (see
// functions/_lib/community/engagement.ts). This script never computes or
// sends an XP amount.
//
// SIGNED-OUT VISITORS MUST COST NOTHING: this script never calls
// /api/auth/me itself. It only starts once it hears a definitive
// 'signed-in' signal — either the localStorage cache TopNav.astro already
// maintains (warm start, zero network) or the 'morphics:auth-state' event
// TopNav dispatches once its own check resolves (see TopNav.astro's paint()).
// Until then, no listeners are attached, no timers run, no storage is
// touched.
//
// Cheap by construction: no mousemove/scroll listeners (click + keydown are
// enough to prove "real interaction happened recently"), one setInterval for
// accrual and one for the heartbeat, and every in-memory collection is
// bounded (see MAX_TRACKED_ELEMENTS / MAX_TRACKED_LISTEN_KEYS) so a
// long-lived tab cannot grow this script's memory without bound.

const HEARTBEAT_INTERVAL_MS = 60000; // matches the server's "no more than once a minute" expectation
const ACCRUAL_TICK_MS = 15000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // no accrual once this long since real interaction
// Comfortably above CLICK_XP_DAILY_CAP (engagement.ts) so real unique
// interaction is never truncated before the SERVER cap kicks in, but still
// bounded so an all-day session can't grow this set forever.
const MAX_TRACKED_ELEMENTS = 64;
const MAX_PATH_DEPTH = 4;
// Mirrors engagement.ts's MAX_LISTEN_ENTRIES_PER_REPORT / MAX_TRACKED_LISTEN_KEYS_PER_DAY.
const MAX_LISTEN_ENTRIES_PER_REPORT = 5;
// A timeupdate-to-timeupdate jump bigger than this is a seek, not real
// listening — timeupdate fires roughly every 250ms during real playback.
const MAX_LISTEN_PROGRESS_JUMP_SECONDS = 2;

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [data-engagement-track]';

const AUTH_CACHE_KEY = 'morphics_auth_cache_v1'; // must match TopNav.astro's CACHE_KEY

let signedIn = false;
let started = false;

const clickedThisSession = new Set();
let pendingNewClicks = 0;
let pendingActiveSeconds = 0;
let lastInteractionTs = 0;
let lastSentAt = 0;

// key -> { forwardSeconds, lastTime, duration }
const listenProgress = new Map();
// key -> { started, progressSeconds, durationSeconds } — queued for the next heartbeat.
const pendingListens = new Map();

/**
 * A stable-ish identifier for an interactive element, in priority order:
 * an explicit [data-engagement-id] (authors can opt an element into a fixed
 * id), then a real DOM id, then a bounded tag+nth-of-type ancestor path.
 * The path fallback is deliberately depth-capped: it doesn't survive every
 * possible re-render, but the cost of that is at most one extra "unique"
 * click counted, which the server caps at CLICK_XP_DAILY_CAP anyway — a far
 * cheaper trade-off than tracking real DOM node identity.
 */
function elementKey(el) {
  if (el.dataset && el.dataset.engagementId) return `d:${el.dataset.engagementId}`;
  if (el.id) return `i:${el.id}`;
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < MAX_PATH_DEPTH; depth++) {
    const parent = node.parentElement;
    let idx = 1;
    if (parent) {
      for (const sib of parent.children) {
        if (sib === node) break;
        if (sib.tagName === node.tagName) idx++;
      }
    }
    parts.unshift(`${node.tagName}:${idx}`);
    node = parent;
  }
  return `p:${parts.join('>')}`;
}

function onClick(e) {
  lastInteractionTs = Date.now();
  const target = e.target && e.target.closest ? e.target.closest(INTERACTIVE_SELECTOR) : null;
  if (!target) return;
  if (clickedThisSession.size >= MAX_TRACKED_ELEMENTS) return;
  const key = elementKey(target);
  if (clickedThisSession.has(key)) return;
  clickedThisSession.add(key);
  pendingNewClicks++;
}

function onKeydown() {
  lastInteractionTs = Date.now();
}

function accrueTick() {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastInteractionTs > IDLE_THRESHOLD_MS) return;
  pendingActiveSeconds += ACCRUAL_TICK_MS / 1000;
}

function queueListen(key, patch) {
  const existing = pendingListens.get(key) || { started: false, progressSeconds: 0, durationSeconds: 0 };
  const p = listenProgress.get(key);
  pendingListens.set(key, {
    started: existing.started || !!(patch && patch.started),
    progressSeconds: p ? p.forwardSeconds : existing.progressSeconds,
    durationSeconds: p ? p.duration : existing.durationSeconds,
  });
}

function onPreviewStart(e) {
  const key = e.detail && e.detail.key;
  if (!key) return;
  listenProgress.set(key, { forwardSeconds: 0, lastTime: 0, duration: 0 });
  queueListen(key, { started: true });
}

function onPreviewProgress(e) {
  const detail = e.detail || {};
  const key = detail.key;
  if (!key) return;
  let p = listenProgress.get(key);
  if (!p) { p = { forwardSeconds: 0, lastTime: 0, duration: 0 }; listenProgress.set(key, p); }
  const duration = Number.isFinite(detail.duration) ? detail.duration : 0;
  const t = Number.isFinite(detail.currentTime) ? detail.currentTime : 0;
  p.duration = duration;
  const delta = t - p.lastTime;
  if (delta > 0 && delta < MAX_LISTEN_PROGRESS_JUMP_SECONDS) p.forwardSeconds += delta;
  p.lastTime = t;
  queueListen(key, {});
}

function sendHeartbeat() {
  if (!signedIn) return;
  if (Date.now() - lastSentAt < HEARTBEAT_INTERVAL_MS) return;

  const listens = [];
  for (const [key, v] of pendingListens) {
    listens.push({
      key,
      started: v.started,
      progress_seconds: Math.round(v.progressSeconds),
      duration_seconds: Math.round(v.durationSeconds),
    });
    if (listens.length >= MAX_LISTEN_ENTRIES_PER_REPORT) break;
  }

  if (pendingNewClicks === 0 && pendingActiveSeconds === 0 && listens.length === 0) return;

  const payload = {
    new_clicks: pendingNewClicks,
    active_seconds: Math.round(pendingActiveSeconds),
    seq: Date.now(),
    listens,
  };

  // Optimistic reset: the server independently caps and dedupes everything
  // here, so under-reporting on a failed request just means slightly slower
  // accrual next time, never a correctness problem.
  pendingNewClicks = 0;
  pendingActiveSeconds = 0;
  pendingListens.clear();
  lastSentAt = Date.now();

  fetch('/api/community/engagement', {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function start() {
  if (started) return;
  started = true;
  signedIn = true;
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('morphics:preview-start', onPreviewStart);
  document.addEventListener('morphics:preview-progress', onPreviewProgress);
  setInterval(accrueTick, ACCRUAL_TICK_MS);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendHeartbeat();
  });
  window.addEventListener('pagehide', sendHeartbeat);
}

// Warm start: read TopNav's own cache — zero network, zero new storage.
try {
  const cached = localStorage.getItem(AUTH_CACHE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    if (parsed && parsed.state === 'signed-in') start();
  }
} catch { /* Safari private mode etc. — just wait for the live event below */ }

// Live signal: the ONLY other source of truth this script uses. Never calls
// /api/auth/me itself.
document.addEventListener('morphics:auth-state', (e) => {
  if (e.detail && e.detail.state === 'signed-in') start();
});

// website/src/scripts/release-countdown.js
import { goLiveUtcMs, isReleased } from '../../functions/_lib/release-gate.mjs';

// Each countdown element carries data-release-date (YYYY-MM-DD) and wraps a
// .countdown-label span. Its sibling .release-add-btn is enabled at go-live.
function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

// Every wire() call registers a setInterval; previously these ran forever
// (the module's top-level `document.querySelectorAll(...).forEach(wire)`
// only ever ran once, on a real page load, so the timers just died with the
// page). Under the client router the calling page re-invokes
// initReleaseCountdowns() on every arrival (see music.astro /
// store/music/[slug].astro), so without tracking + clearing the previous
// batch each call would pile up one more live setInterval per visit —
// ticking against detached elements from every earlier visit, forever.
let activeTimers = [];

function wire(el) {
  const date = el.dataset.releaseDate || '';
  const label = el.querySelector('.countdown-label');
  const btn = el.parentElement?.querySelector('.release-add-btn');
  const liveAt = goLiveUtcMs(date);
  if (!Number.isFinite(liveAt)) { el.style.display = 'none'; return; }

  function tick() {
    if (isReleased(date)) {
      el.style.display = 'none';
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.liveLabel || 'Add to cart'; }
      clearInterval(timer);
      activeTimers = activeTimers.filter((t) => t !== timer);
      return;
    }
    // A pre-orderable release is already on sale, so "Releases in" would be
    // the wrong verb here — what the buyer is waiting on is delivery, not
    // availability. The element carries data-preorder when that is the case.
    if (label) {
      label.textContent = el.dataset.preorder
        ? `Unlocks in ${fmt(liveAt - Date.now())}`
        : `Releases in ${fmt(liveAt - Date.now())}`;
    }
  }
  const timer = setInterval(tick, 1000);
  activeTimers.push(timer);
  tick();
}

// Stops every countdown timer this module currently has running. Call
// before re-initialising (belt and braces) and on the way out of a page
// that has countdowns, so navigating away never leaves one ticking.
export function disposeReleaseCountdowns() {
  activeTimers.forEach(clearInterval);
  activeTimers = [];
}

// Safe to call repeatedly — disposes any previous batch first, then wires
// whatever .release-countdown elements exist in the current DOM (a fresh
// set on every navigation under the client router).
export function initReleaseCountdowns(root = document) {
  disposeReleaseCountdowns();
  root.querySelectorAll('.release-countdown').forEach(wire);
}

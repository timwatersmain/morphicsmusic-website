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
      return;
    }
    if (label) label.textContent = `Releases in ${fmt(liveAt - Date.now())}`;
  }
  const timer = setInterval(tick, 1000);
  tick();
}

document.querySelectorAll('.release-countdown').forEach(wire);

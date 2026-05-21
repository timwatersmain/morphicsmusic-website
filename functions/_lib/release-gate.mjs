// website/functions/_lib/release-gate.mjs
// Single source of truth for store release timing. A release goes live at
// 00:00 America/New_York on its release_date (DST-correct). Shared by the
// frontend countdown, checkout, and download.

function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// UTC ms for midnight ET on a YYYY-MM-DD date. NaN for blank/invalid.
export function goLiveUtcMs(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return NaN;
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const off = tzOffsetMs(new Date(guess), 'America/New_York'); // negative for ET
  return guess - off;
}

// True once the release is live. Blank/invalid date → not released.
export function isReleased(dateStr, nowMs = Date.now()) {
  const live = goLiveUtcMs(dateStr);
  return Number.isFinite(live) && nowMs >= live;
}

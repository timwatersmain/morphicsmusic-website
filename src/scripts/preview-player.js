// Shared preview player for the Morphics store + the persistent bottom player
// bar (see components/PlayerBar.astro). One <audio> element, one track at a
// time. Any element with [data-preview-key] is a play/pause toggle for that
// preview MP3 (served by /api/preview); optional [data-preview-title] /
// [data-preview-sub] / [data-preview-art] populate the bar.
//
// The bar shows a real waveform: a deterministic placeholder renders instantly,
// then the actual file is fetched + decoded in the background and the bars are
// replaced with true amplitude peaks (cached per key). The waveform doubles as
// a click/drag seek bar.

import catalog from '../data/music-catalog.json';
import previewsData from '../data/previews.json';
import {
  buildQueue,
  nextInQueue,
  previousInQueue,
  resolvePrevious,
  createForwardProgressTracker,
} from './preview-queue.js';

let audio = null;
let currentKey = null;
let currentBtn = null;
let currentCart = null; // cart payload for the release the playing track belongs to
let rafId = null;

// ---------- autoplay queue ----------
// Catalogue-order queue (see preview-queue.js) so "next" is consistent no
// matter which page playback started from. Built once, lazily, since it's
// pure data derived from the two JSON imports above.
let queueCache = null;
function getQueue() {
  if (!queueCache) queueCache = buildQueue(catalog, previewsData);
  return queueCache;
}

// Only a genuinely-heard track (see forwardTracker below) is allowed to
// chain into the next one. A user pressing pause or close sets this false,
// which must stop the chain dead — it never resurrects a session the
// listener ended. Re-armed on every fresh, user-or-chain-initiated start.
let autoplayEnabled = true;
const forwardTracker = createForwardProgressTracker();

const RES = 480; // waveform resolution (peaks per track)
const peakCache = new Map(); // key -> Float32Array[RES] of normalized peaks
let currentPeaks = null;
let decodeCtx = null;

const PLAYED = '#7dffb3'; // brand secondary green
const UNPLAYED = 'rgba(255, 255, 255, 0.16)';

const $ = (id) => document.getElementById(id);

/* ---------- volume (persisted, works before <audio> exists) ---------- */

const VOL_KEY = 'mx-pb-volume';
const MUTE_KEY = 'mx-pb-muted';
let volLevel = (() => {
  const v = parseFloat(localStorage.getItem(VOL_KEY));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
})();
let volMuted = localStorage.getItem(MUTE_KEY) === '1';

function applyVolume() {
  if (audio) { audio.volume = volLevel; audio.muted = volMuted; }
  const slider = $('pb-vol');
  if (slider) slider.value = String(volMuted ? 0 : volLevel);
  const icon = iconEl($('pb-mute'));
  if (icon) {
    icon.textContent = (volMuted || volLevel === 0)
      ? 'volume_off'
      : volLevel < 0.5 ? 'volume_down' : 'volume_up';
  }
}

/* ---------- audio element ---------- */

function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.volume = volLevel;
  audio.muted = volMuted;
  audio.addEventListener('ended', () => {
    bothIcons('play_arrow');
    stopRaf();
    drawWave();
    // Same "actually heard it" standard the engagement-XP work uses (see
    // functions/_lib/community/engagement.ts + preview-queue.js's doc
    // comment) — a scrub-to-the-end still fires `ended` but never
    // accumulated genuine forward progress, so it can't trigger a chain.
    if (autoplayEnabled && forwardTracker.isGenuineComplete()) playNext();
  });
  audio.addEventListener('pause', () => { if (audio.ended) return; bothIcons('play_arrow'); stopRaf(); drawWave(); });
  audio.addEventListener('play', () => { bothIcons('pause'); startRaf(); });
  audio.addEventListener('playing', () => { bothIcons('pause'); startRaf(); });
  audio.addEventListener('waiting', () => { bothIcons('progress_activity'); });
  audio.addEventListener('loadedmetadata', () => { updateTimes(); drawWave(); });
  audio.addEventListener('durationchange', () => { updateTimes(); drawWave(); });
  audio.addEventListener('timeupdate', () => { updateTimes(); forwardTracker.update(audio.currentTime, audio.duration); });
  audio.addEventListener('error', () => { bothIcons('play_arrow'); stopRaf(); });
  return audio;
}

/* ---------- icon swapping (clicked button + bar toggle) ---------- */

function iconEl(btn) {
  if (!btn) return null;
  return btn.querySelector('.material-symbols-outlined') || btn;
}

function setIcon(btn, name) {
  const el = iconEl(btn);
  if (!el) return;
  el.textContent = name;
  if (btn) btn.classList.toggle('preview-playing', name === 'pause' || name === 'progress_activity');
}

function setBarIcon(name) {
  const el = $('pb-toggle');
  if (!el) return;
  (el.querySelector('.material-symbols-outlined') || el).textContent =
    name === 'progress_activity' ? 'sync' : name;
  el.classList.toggle('is-loading', name === 'progress_activity');
}

function bothIcons(name) { setIcon(currentBtn, name); setBarIcon(name); }

/* ---------- bar chrome ---------- */

function showBar() {
  const bar = $('player-bar');
  if (!bar) return;
  bar.classList.remove('is-hidden');
  bar.setAttribute('aria-hidden', 'false');
}

function hideBar() {
  const bar = $('player-bar');
  if (!bar) return;
  bar.classList.add('is-hidden');
  bar.setAttribute('aria-hidden', 'true');
}

function setHref(el, href) {
  if (!el) return;
  if (href) el.setAttribute('href', href); else el.removeAttribute('href');
}

function setMeta(meta) {
  meta = meta || {};
  const t = $('pb-title'), s = $('pb-sub'), img = $('pb-art');
  if (t) t.textContent = meta.title || 'Preview';
  if (s) s.textContent = meta.sub || 'PREVIEW';
  if (img) {
    if (meta.art) { img.src = meta.art; img.style.visibility = 'visible'; }
    else { img.removeAttribute('src'); img.style.visibility = 'hidden'; }
  }
  // Art + release name link to the release page; the title links to the
  // specific track (anchored to its row on the release page).
  const releaseUrl = meta.slug ? `/store/music/${meta.slug}` : null;
  const trackUrl = releaseUrl && meta.trackNum ? `${releaseUrl}#track-${meta.trackNum}` : releaseUrl;
  setHref($('pb-art-link'), releaseUrl);
  setHref(s, releaseUrl);
  setHref(t, trackUrl);
  setCart(meta.cart);
}

function setCart(cart) {
  currentCart = cart && cart.slug && cart.buyable ? cart : null;
  const btn = $('pb-cart');
  if (!btn) return;
  btn.classList.remove('is-added');
  if (!currentCart) { btn.hidden = true; return; }
  btn.hidden = false;
  const label = $('pb-cart-label');
  if (label) {
    const dollars = Math.round((currentCart.cents || 0) / 100);
    label.textContent = dollars > 0 ? `Add · $${dollars}` : 'Add';
  }
}

function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = String(Math.floor(t % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function updateTimes() {
  const cur = $('pb-cur'), dur = $('pb-dur');
  if (cur) cur.textContent = fmt(audio ? audio.currentTime : 0);
  if (dur) dur.textContent = fmt(audio ? audio.duration : 0);
  // Observability hook only — dispatched on every call site this already
  // had (timeupdate/loadedmetadata/durationchange), never changes playback.
  // Listened to by engagement-tracker.js to derive genuine listen progress
  // (see functions/_lib/community/engagement.ts) without that script
  // needing access to the module-private `audio`/`currentKey` state here.
  if (currentKey) {
    document.dispatchEvent(new CustomEvent('morphics:preview-progress', {
      detail: { key: currentKey, currentTime: audio ? audio.currentTime : 0, duration: audio ? audio.duration : 0 },
    }));
  }
}

/* ---------- waveform ---------- */

// Deterministic placeholder peaks so each track has a stable, musical-looking
// shape before its real waveform is decoded.
function seededPeaks(key) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  const peaks = new Float32Array(RES);
  for (let i = 0; i < RES; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h = h >>> 0;
    const r = h / 4294967295;
    const env = 0.45 + 0.55 * Math.abs(Math.sin((i / RES) * Math.PI * 7 + key.length));
    peaks[i] = 0.12 + 0.88 * Math.pow(r, 1.6) * env;
  }
  return peaks;
}

function getDecodeCtx() {
  if (decodeCtx) return decodeCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  decodeCtx = new AC();
  return decodeCtx;
}

function loadRealPeaks(key) {
  if (peakCache.has(key)) {
    if (currentKey === key) { currentPeaks = peakCache.get(key); drawWave(); }
    return;
  }
  const ctx = getDecodeCtx();
  if (!ctx) return;
  fetch(`/api/preview?key=${encodeURIComponent(key)}`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
    .then((buf) => ctx.decodeAudioData(buf))
    .then((audioBuf) => {
      const ch = audioBuf.getChannelData(0);
      const block = Math.max(1, Math.floor(ch.length / RES));
      const stride = Math.max(1, Math.floor(block / 50)); // subsample for speed
      const peaks = new Float32Array(RES);
      let max = 0;
      for (let i = 0; i < RES; i++) {
        let m = 0;
        const start = i * block;
        for (let j = 0; j < block; j += stride) {
          const v = Math.abs(ch[start + j] || 0);
          if (v > m) m = v;
        }
        peaks[i] = m;
        if (m > max) max = m;
      }
      if (max > 0) for (let i = 0; i < RES; i++) peaks[i] = Math.max(0.04, peaks[i] / max);
      peakCache.set(key, peaks);
      if (currentKey === key) { currentPeaks = peaks; drawWave(); }
    })
    .catch(() => { /* keep placeholder waveform */ });
}

function drawWave() {
  const canvas = $('pb-wave');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const peaks = currentPeaks || seededPeaks(currentKey || 'x');
  const barW = 2, step = 4;
  const bars = Math.max(1, Math.floor(cssW / step));
  const dur = audio && isFinite(audio.duration) ? audio.duration : 0;
  const prog = dur ? audio.currentTime / dur : 0;
  const mid = cssH / 2;
  for (let i = 0; i < bars; i++) {
    const p = peaks[Math.floor((i / bars) * peaks.length)] || 0.05;
    const bh = Math.max(2, p * (cssH - 4));
    const frac = (i + 0.5) / bars;
    ctx.fillStyle = frac <= prog ? PLAYED : UNPLAYED;
    ctx.fillRect(i * step, mid - bh / 2, barW, bh);
  }
}

function startRaf() {
  if (rafId) return;
  const loop = () => { drawWave(); rafId = requestAnimationFrame(loop); };
  rafId = requestAnimationFrame(loop);
}
function stopRaf() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

/* ---------- transport ---------- */

// Shared body for "start playing this key from zero", used by both a manual
// toggle() on a new key and an autoplay advance to the next queue entry.
// `btn` is the DOM play/pause toggle that triggered this, or null when the
// start came from the queue (no originating button on the current page).
// Returns the underlying <audio>.play() promise so callers can react to a
// browser autoplay block without this function throwing.
function startKey(key, btn, meta) {
  if (currentBtn && currentBtn !== btn) setIcon(currentBtn, 'play_arrow');
  currentKey = key;
  currentBtn = btn;
  updateSkipButtons();
  forwardTracker.reset();
  // Observability hook only, same reasoning as updateTimes' dispatch above —
  // fires once per genuine new-track start (this function only runs when
  // the key actually changed), never on a plain pause/resume toggle. Firing
  // it here means a queue-driven advance sends the exact same signal a
  // manual play does, so the engagement-XP hooks award it identically.
  document.dispatchEvent(new CustomEvent('morphics:preview-start', { detail: { key } }));
  currentPeaks = peakCache.get(key) || null;
  setMeta(meta);
  showBar();
  const a = ensureAudio();
  a.src = `/api/preview?key=${encodeURIComponent(key)}`;
  bothIcons('progress_activity');
  updateTimes();
  drawWave();
  loadRealPeaks(key);
  // A fresh start (manual or chained) always re-arms the chain; only an
  // explicit pause/close should cancel it.
  autoplayEnabled = true;
  return a.play();
}

function toggle(key, btn, meta) {
  const a = ensureAudio();
  if (currentKey === key) {
    if (a.paused) { autoplayEnabled = true; a.play().catch(() => {}); } else { autoplayEnabled = false; a.pause(); }
    return;
  }
  startKey(key, btn, meta).catch(() => bothIcons('play_arrow'));
}

// Advance to the next track in catalogue order (see preview-queue.js).
// Unplayable tracks/releases were already excluded when the queue was
// built, so "next" here is always either a playable entry or the end.
// Used both by autoplay chaining (gated on a genuine listen, see the `ended`
// handler above) and the bar's Next button (ungated — a deliberate press is
// its own intent, no listen requirement).
function playNext() {
  const next = nextInQueue(getQueue(), currentKey);
  if (!next) return; // end of the catalogue — stop, never loop back to the start
  // Browsers (Safari/iOS strictest of all) can reject play() even when it's
  // chained off a completed, user-initiated playback — handle that
  // gracefully: leave the bar showing the next track, paused, rather than
  // throwing or silently doing nothing visible.
  startKey(next.key, null, next).catch(() => bothIcons('play_arrow'));
}

// Previous button: the standard media-player convention (see resolvePrevious
// in preview-queue.js) — early into a track, step back a track; once you're
// meaningfully into it, restart it instead. Either way this is a deliberate
// press, so it re-arms the autoplay chain exactly like Next does.
function playPrev() {
  const a = ensureAudio();
  const resolved = resolvePrevious(getQueue(), currentKey, a.currentTime || 0);
  if (resolved.action === 'restart') {
    a.currentTime = 0;
    autoplayEnabled = true; // deliberate press — same re-arm as a track change
    drawWave();
    updateTimes();
    if (a.paused) a.play().catch(() => {});
    return;
  }
  startKey(resolved.entry.key, null, resolved.entry).catch(() => bothIcons('play_arrow'));
}

// Disable Next/Previous at the ends of the queue rather than letting them
// silently no-op — a dead control that looks alive is worse than one that
// looks unavailable. Re-evaluated on every startKey() (i.e. every track
// change), not on a timer, since eligibility only ever depends on where the
// current key sits in the queue.
function updateSkipButtons() {
  const queue = getQueue();
  const prevBtn = $('pb-prev');
  const nextBtn = $('pb-next');
  if (prevBtn) prevBtn.disabled = !previousInQueue(queue, currentKey);
  if (nextBtn) nextBtn.disabled = !nextInQueue(queue, currentKey);
}

/* ---------- wiring ---------- */

function wireBar() {
  const toggleBtn = $('pb-toggle');
  if (toggleBtn && !toggleBtn.__wired) {
    toggleBtn.__wired = true;
    toggleBtn.addEventListener('click', () => {
      if (!audio || !currentKey) return;
      if (audio.paused) { autoplayEnabled = true; audio.play().catch(() => {}); }
      else { autoplayEnabled = false; audio.pause(); } // manual pause stops the autoplay chain
    });
  }

  const prevBtn = $('pb-prev');
  if (prevBtn && !prevBtn.__wired) {
    prevBtn.__wired = true;
    prevBtn.addEventListener('click', () => { if (!currentKey) return; playPrev(); });
  }

  const nextBtn = $('pb-next');
  if (nextBtn && !nextBtn.__wired) {
    nextBtn.__wired = true;
    nextBtn.addEventListener('click', () => { if (!currentKey) return; playNext(); });
  }
  updateSkipButtons(); // initial state: both disabled until a track is playing

  const cartBtn = $('pb-cart');
  if (cartBtn && !cartBtn.__wired) {
    cartBtn.__wired = true;
    cartBtn.addEventListener('click', () => {
      const c = currentCart;
      if (!c || !window.morphicsCart) return;
      const count = Number(c.count) || 1;
      window.morphicsCart.add({
        type: 'music',
        sku: `music:${c.slug}`,
        title: c.title,
        subtitle: `${String(c.type || '').toUpperCase()} · ${count} track${count === 1 ? '' : 's'} · digital`,
        image: c.art,
        unit_amount: Number(c.cents) || 0,
        qty: 1,
        metadata: { release_slug: c.slug },
      });
      cartBtn.classList.add('is-added');
      const label = $('pb-cart-label');
      const prev = label && label.textContent;
      if (label) label.textContent = 'Added ✓';
      setTimeout(() => {
        cartBtn.classList.remove('is-added');
        if (label && prev) label.textContent = prev;
      }, 1600);
    });
  }

  const closeBtn = $('pb-close');
  if (closeBtn && !closeBtn.__wired) {
    closeBtn.__wired = true;
    closeBtn.addEventListener('click', () => {
      autoplayEnabled = false; // closing ends the listening session — never resurrect it
      if (audio) { audio.pause(); audio.currentTime = 0; }
      setIcon(currentBtn, 'play_arrow');
      hideBar();
    });
  }

  const volSlider = $('pb-vol');
  if (volSlider && !volSlider.__wired) {
    volSlider.__wired = true;
    volSlider.addEventListener('input', () => {
      volLevel = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
      volMuted = volLevel === 0;
      localStorage.setItem(VOL_KEY, String(volLevel));
      localStorage.setItem(MUTE_KEY, volMuted ? '1' : '0');
      applyVolume();
    });
  }

  const muteBtn = $('pb-mute');
  if (muteBtn && !muteBtn.__wired) {
    muteBtn.__wired = true;
    muteBtn.addEventListener('click', () => {
      // Unmuting at 0 restores a sensible level.
      if (!volMuted && volLevel === 0) volLevel = 1;
      volMuted = !volMuted;
      localStorage.setItem(MUTE_KEY, volMuted ? '1' : '0');
      localStorage.setItem(VOL_KEY, String(volLevel));
      applyVolume();
    });
  }
  applyVolume();

  const wrap = $('pb-wave-wrap');
  if (wrap && !wrap.__wired) {
    wrap.__wired = true;
    let dragging = false;
    const seek = (clientX) => {
      if (!audio || !isFinite(audio.duration) || !audio.duration) return;
      const r = wrap.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      audio.currentTime = frac * audio.duration;
      drawWave();
      updateTimes();
    };
    wrap.addEventListener('pointerdown', (e) => { dragging = true; wrap.setPointerCapture(e.pointerId); seek(e.clientX); });
    wrap.addEventListener('pointermove', (e) => { if (dragging) seek(e.clientX); });
    wrap.addEventListener('pointerup', () => { dragging = false; });
    wrap.addEventListener('pointercancel', () => { dragging = false; });
  }

  window.addEventListener('resize', drawWave, { passive: true });
}

window.morphicsPreview = { toggle };

// Delegated clicks so dynamically-rendered buttons work too.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preview-key]');
  if (!btn) return;
  e.preventDefault();
  const key = btn.getAttribute('data-preview-key');
  if (!key) return;
  const art = btn.getAttribute('data-preview-art');
  const cartSlug = btn.getAttribute('data-cart-slug');
  toggle(key, btn, {
    title: btn.getAttribute('data-preview-title'),
    sub: btn.getAttribute('data-preview-sub') || 'PREVIEW',
    art,
    slug: cartSlug,
    trackNum: btn.getAttribute('data-track-num'),
    cart: cartSlug ? {
      slug: cartSlug,
      title: btn.getAttribute('data-cart-title'),
      type: btn.getAttribute('data-cart-type'),
      count: btn.getAttribute('data-cart-count'),
      cents: btn.getAttribute('data-cart-cents'),
      buyable: btn.getAttribute('data-cart-buyable') === '1',
      art,
    } : null,
  });
});

// Keyboard support for non-button play targets (e.g. track rows).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest('[data-preview-key][role="button"]');
  if (!el) return;
  e.preventDefault();
  el.click();
});

wireBar();

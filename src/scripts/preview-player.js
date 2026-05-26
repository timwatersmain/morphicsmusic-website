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

let audio = null;
let currentKey = null;
let currentBtn = null;
let currentCart = null; // cart payload for the release the playing track belongs to
let rafId = null;

const RES = 480; // waveform resolution (peaks per track)
const peakCache = new Map(); // key -> Float32Array[RES] of normalized peaks
let currentPeaks = null;
let decodeCtx = null;

const PLAYED = '#7dffb3'; // brand secondary green
const UNPLAYED = 'rgba(255, 255, 255, 0.16)';

const $ = (id) => document.getElementById(id);

/* ---------- audio element ---------- */

function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.addEventListener('ended', () => { bothIcons('play_arrow'); stopRaf(); drawWave(); });
  audio.addEventListener('pause', () => { if (audio.ended) return; bothIcons('play_arrow'); stopRaf(); drawWave(); });
  audio.addEventListener('play', () => { bothIcons('pause'); startRaf(); });
  audio.addEventListener('playing', () => { bothIcons('pause'); startRaf(); });
  audio.addEventListener('waiting', () => { bothIcons('progress_activity'); });
  audio.addEventListener('loadedmetadata', () => { updateTimes(); drawWave(); });
  audio.addEventListener('durationchange', () => { updateTimes(); drawWave(); });
  audio.addEventListener('timeupdate', updateTimes);
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

function toggle(key, btn, meta) {
  const a = ensureAudio();
  if (currentKey === key) {
    if (a.paused) a.play().catch(() => {}); else a.pause();
    return;
  }
  if (currentBtn && currentBtn !== btn) setIcon(currentBtn, 'play_arrow');
  currentKey = key;
  currentBtn = btn;
  currentPeaks = peakCache.get(key) || null;
  setMeta(meta);
  showBar();
  a.src = `/api/preview?key=${encodeURIComponent(key)}`;
  bothIcons('progress_activity');
  updateTimes();
  drawWave();
  loadRealPeaks(key);
  a.play().catch(() => bothIcons('play_arrow'));
}

/* ---------- wiring ---------- */

function wireBar() {
  const toggleBtn = $('pb-toggle');
  if (toggleBtn && !toggleBtn.__wired) {
    toggleBtn.__wired = true;
    toggleBtn.addEventListener('click', () => {
      if (!audio || !currentKey) return;
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    });
  }

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
      if (audio) { audio.pause(); audio.currentTime = 0; }
      setIcon(currentBtn, 'play_arrow');
      hideBar();
    });
  }

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

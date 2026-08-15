// Page-title morph: the outgoing title comes apart into a particle field and
// reassembles as the incoming one.
//
// The CSS view transition could only ever crossfade two pictures of two
// different words — the browser cannot interpolate an S into a T. This does the
// morph the rest of the site already does: sample both words into point clouds,
// pair the points, and travel between them through a formless middle using the
// same behaviour library as the scramble grid (behaviours.js, tuned for a
// 120-unit artboard, including the modes that deliberately tear the form apart).
//
// Navigation stays multi-page. The outgoing page records its title in
// sessionStorage; the incoming page reads it and plays old -> new. Nothing here
// depends on a client-side router.
import { assign } from './spelling/pairing.js';
import { displace, leadFor } from './spelling/behaviours.js';

const KEY = 'morphics:title-from';
const ART = 120;          // behaviours.js coordinate space
const TARGET_POINTS = 2600;
const MORPH_MS = 900;
const HANDOFF_MS = 160;   // canvas fades out as the real <h1> fades in

// Modes that pull the form apart on the way across rather than sliding it.
// These are the ones the grid engine deliberately EXCLUDES, because there they
// would read as debris across a field of small letters. On one large word they
// are the whole point.
const FORMLESS = ['boil', 'tendril', 'split', 'seam', 'braid', 'cascade', 'unwind', 'vortex'];

const titleEl = () => document.querySelector('main h1:not([data-no-vt])');
const titleText = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

// --- rasterise a word into points -----------------------------------------

// Draw the word with the <h1>'s OWN computed font, so the particles land on the
// real letterforms rather than an approximation of them.
function pointsForWord(word, style, boxW, boxH, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(boxW * dpr));
  c.height = Math.max(1, Math.ceil(boxH * dpr));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.scale(dpr, dpr);
  g.fillStyle = '#fff';
  g.textBaseline = 'alphabetic';
  g.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if ('letterSpacing' in g) g.letterSpacing = style.letterSpacing;
  g.fillText(word, 0, parseFloat(style.fontSize) * 0.82);

  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  // Stride chosen so a long word and a short one end up with comparable point
  // counts — a fixed stride would give STORE half the particles of VISUALS and
  // the pairing would then have to duplicate or drop points.
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 90) ink++;
  const stride = Math.max(1, Math.round(Math.sqrt(ink / TARGET_POINTS)));

  const pts = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (data[(y * width + x) * 4 + 3] > 90) {
        pts.push({ x: x / dpr, y: y / dpr });
      }
    }
  }
  return pts;
}

// behaviours.js is written for a form that FILLS a 120x120 artboard — its
// displacement magnitudes are relative to that, measured from CENTER and scaled
// by /44 and /120. A page title is wide and short, so mapping it uniformly
// leaves a thin band across the middle of the artboard and every behaviour then
// throws points far outside the word: the first attempt came out as a diagonal
// streak rather than a morph.
//
// So the mapping is deliberately NON-uniform — the title's own box is stretched
// to fill the artboard on both axes. Displacement then scales with the word's
// width and height separately, which keeps the cloud in the title's own
// neighbourhood while still coming fully apart.
const toArt = (p, f) => ({
  x: ((p.x - f.x) / f.w) * ART,
  y: ((p.y - f.y) / f.h) * ART,
});
const fromArt = (p, f) => ({
  x: f.x + (p.x / ART) * f.w,
  y: f.y + (p.y / ART) * f.h,
});

function frameOf(...sets) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const set of sets) {
    for (const p of set) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  return { x: x0, y: y0, w: (x1 - x0) || 1, h: (y1 - y0) || 1 };
}

// Equalise the two clouds: assign() pairs one-to-one, so both sides must be the
// same length. The shorter one repeats points (a letterform gaining particles
// reads fine; losing them leaves holes).
function equalise(a, b) {
  const n = Math.max(a.length, b.length);
  const grow = (src) => {
    if (!src.length) return [];
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = src[i % src.length];
    return out;
  };
  return [grow(a), grow(b)];
}

// --- the morph -------------------------------------------------------------

export function runTitleMorph(fromWord) {
  const h1 = titleEl();
  if (!h1) return finish(null, null);

  const to = titleText(h1);
  if (!to || !fromWord || fromWord === to) return finish(h1, null);

  const rect = h1.getBoundingClientRect();
  if (!rect.width || !rect.height) return finish(h1, null);

  const style = getComputedStyle(h1);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Generous box: the outgoing word may be wider than the incoming one, and a
  // clipped rasterisation loses its tail.
  const boxW = Math.max(rect.width * 2.2, 400);
  const boxH = rect.height * 1.6;

  const src = pointsForWord(fromWord, style, boxW, boxH, dpr);
  const dst = pointsForWord(to, style, boxW, boxH, dpr);
  if (!src.length || !dst.length) return finish(h1, null);

  // Both words were rasterised into the SAME canvas space, so their union box
  // is directly comparable: SOCIAL really is wider than STORE and the morph
  // shows that.
  const frame = frameOf(src, dst);
  const [a0, b0] = equalise(src.map((p) => toArt(p, frame)), dst.map((p) => toArt(p, frame)));
  const pair = assign(a0, b0);

  // The canvas covers the union box plus padding, because the formless middle
  // deliberately throws particles outside the letterforms and a tight canvas
  // would clip them.
  const padX = frame.w * 0.28;
  const padY = frame.h * 0.9;
  const cw = frame.w + padX * 2;
  const ch = frame.h + padY * 2;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute',
    // rect is the <h1> box; the rasterisation used the same origin, so the
    // frame offset carries straight over.
    left: `${rect.left + window.scrollX + frame.x - padX}px`,
    top: `${rect.top + window.scrollY + frame.y - padY}px`,
    width: `${cw}px`,
    height: `${ch}px`,
    pointerEvents: 'none',
    zIndex: '5',
  });
  canvas.width = Math.ceil(cw * dpr);
  canvas.height = Math.ceil(ch * dpr);
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const colour = style.color;
  // Radius covers the gaps between sampled points so the settled word reads
  // solid rather than dotted.
  const R = Math.max(1.2, stridePixel(src, dst) * dpr * 0.85);

  const mode = FORMLESS[(Math.random() * FORMLESS.length) | 0];
  const seeds = new Float32Array(a0.length);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();

  const t0 = performance.now();
  let raf = 0;

  const frameFn = (now) => {
    const raw = Math.min(1, (now - t0) / MORPH_MS);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = colour;
    ctx.globalAlpha = raw < 0.9 ? 1 : 1 - (raw - 0.9) / 0.1;
    ctx.beginPath();
    for (let i = 0; i < a0.length; i++) {
      const A = a0[i], B = pair[i];
      const lead = leadFor(mode, B, i, a0.length, seeds[i]);
      const tt = lead >= 1 ? 0 : Math.min(1, Math.max(0, (raw - lead) / (1 - lead)));
      const d = displace(mode, A, B, tt, i, seeds[i], now);
      // Back to canvas space: undo the artboard normalisation, then offset by
      // the padding the canvas adds around the union box.
      const s = fromArt(d, frame);
      const px = (s.x - frame.x + padX) * dpr;
      const py = (s.y - frame.y + padY) * dpr;
      ctx.moveTo(px + R, py);
      ctx.arc(px, py, R, 0, Math.PI * 2);
    }
    ctx.fill();

    if (raw < 1) {
      raf = requestAnimationFrame(frameFn);
    } else {
      finish(h1, canvas);
    }
  };
  raf = requestAnimationFrame(frameFn);

  // Never leave the title invisible if anything goes wrong mid-flight.
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(raf);
    finish(h1, canvas);
  }, { once: true });
}

// Approximate sampling stride in CSS px, used to size the particles.
function stridePixel(src, dst) {
  const n = Math.max(src.length, dst.length);
  return n > 1800 ? 2 : n > 900 ? 3 : 4;
}

function finish(h1, canvas) {
  document.documentElement.classList.remove('title-morphing');
  if (h1) {
    h1.style.transition = `opacity ${HANDOFF_MS}ms linear`;
    h1.style.opacity = '1';
  }
  if (canvas) {
    canvas.style.transition = `opacity ${HANDOFF_MS}ms linear`;
    canvas.style.opacity = '0';
    setTimeout(() => canvas.remove(), HANDOFF_MS + 60);
  }
}

// --- wiring ----------------------------------------------------------------

export function initTitleMorph() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Record this page's title for whichever page comes next. pagehide covers
  // link clicks, back/forward and the ENTER zoom's scripted navigation alike.
  window.addEventListener('pagehide', () => {
    const t = titleText(titleEl());
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  });

  if (reduce.matches) {
    document.documentElement.classList.remove('title-morphing');
    return;
  }

  const from = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);

  // Fonts must be settled first: rasterising against a fallback face would
  // sample the wrong letterforms and the morph would land off the real title.
  const start = () => runTitleMorph(from);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start).catch(start);
  else start();
}

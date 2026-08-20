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
const MORPH_MS = 620;   // snappier than the 900 it shipped at
const HANDOFF_MS = 160;   // canvas fades out as the real <h1> fades in

// The rotation, chosen by ear rather than from reading the source, using a
// preview page that has since been removed (src/pages/lab/title-morph.astro —
// recoverable from git if these need re-auditioning).
// Tim kept: direct, wave, ripple, magnet, snake, peel, knit, furl, tendril.
// Explicitly rejected: vortex, unwind, split, braid, seam — the hardest-tearing
// ones, which scatter so far that the word stops reading as a word. The
// remaining behaviours (boil, cascade, swirl, implode, spin, orbit, shear,
// fold, inhale, lathe, quench) are simply not endorsed; add them only after
// auditioning them in the lab.
export const TITLE_MODES = [
  'direct', 'wave', 'ripple', 'magnet', 'snake', 'peel', 'knit', 'furl',
  'tendril',
];

const titleEl = () => document.querySelector('main h1:not([data-no-vt])');
const titleText = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

// --- rasterise a word into points -----------------------------------------

// Draw the word with the <h1>'s OWN computed font, so the particles land on the
// real letterforms rather than an approximation of them.
function pointsForWord(word, style, boxW, boxH, dpr, target = TARGET_POINTS) {
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
  const stride = Math.max(1, Math.round(Math.sqrt(ink / target)));

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

// Morph one word into another over the given element's box. Takes an explicit
// mode and duration so it can be driven deliberately rather than only by the
// page bootstrap; that is how the rotation below was auditioned.
export function morphWord(h1, fromWord, toWord, opts = {}) {
  const ms = opts.ms ?? MORPH_MS;
  const mode = opts.mode || TITLE_MODES[(Math.random() * TITLE_MODES.length) | 0];
  const onDone = opts.onDone;
  // Where the particle canvas is attached. Defaults to <body> in page
  // coordinates, which is right for a normal page title. A caller whose title
  // lives in a sticky or scrolling container must pass that container instead,
  // or the canvas is positioned in the wrong space and drifts away from the
  // word as the page scrolls — and <body> carries overflow-x: hidden, which
  // computes overflow-y to auto and can clip an absolutely positioned child.
  const mount = opts.mount || document.body;

  if (!h1) return finishEl(null, null);
  const to = toWord;
  if (!to || !fromWord || fromWord === to) return finishEl(h1, null);

  const rect = h1.getBoundingClientRect();
  if (!rect.width || !rect.height) return finishEl(h1, null);

  const style = getComputedStyle(h1);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Generous box: the outgoing word may be wider than the incoming one, and a
  // clipped rasterisation loses its tail.
  const boxW = Math.max(rect.width * 2.2, 400);
  const boxH = rect.height * 1.6;

  // Point budget. The title's 2600 is right for one enormous word and ruinous
  // for the eighty small runs text-morph.js drives at once — eighty clouds of
  // 2600 is a quarter of a million circles per frame. Callers pass what the
  // run is worth; the default keeps the title exactly as it was.
  const target = opts.points || TARGET_POINTS;
  const src = pointsForWord(fromWord, style, boxW, boxH, dpr, target);
  const dst = pointsForWord(to, style, boxW, boxH, dpr, target);
  if (!src.length || !dst.length) return finishEl(h1, null);

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

  // Origin of the coordinate space the canvas is positioned in.
  let originX = rect.left + window.scrollX;
  let originY = rect.top + window.scrollY;
  if (mount !== document.body) {
    const base = mount.getBoundingClientRect();
    originX = rect.left - base.left;
    originY = rect.top - base.top;
  }

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'absolute',
    // rect is the <h1> box; the rasterisation used the same origin, so the
    // frame offset carries straight over.
    left: `${originX + frame.x - padX}px`,
    top: `${originY + frame.y - padY}px`,
    width: `${cw}px`,
    height: `${ch}px`,
    pointerEvents: 'none',
    zIndex: '5',
  });
  canvas.width = Math.ceil(cw * dpr);
  canvas.height = Math.ceil(ch * dpr);
  mount.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const colour = style.color;
  // Radius covers the gaps between sampled points so the settled word reads
  // solid rather than dotted.
  const R = Math.max(1.2, stridePixel(src, dst) * dpr * 0.85);

  const seeds = new Float32Array(a0.length);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();

  const t0 = performance.now();
  let raf = 0;
  // This morph's own completion guard. Three things race to end it — the last
  // frame, the deadline timer, and pagehide — and exactly one may win, per
  // morph rather than per page.
  let done = false;
  const settle = () => { if (done) return; done = true; finishEl(h1, canvas); };

  const frameFn = (now) => {
    const raw = Math.min(1, (now - t0) / ms);
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
      settle();
      if (onDone) onDone();
    }
  };
  raf = requestAnimationFrame(frameFn);

  // A deadline, because requestAnimationFrame is not guaranteed to keep
  // ticking: iOS Safari pauses it while the user scrolls, which stalls the
  // morph and — since the real <h1> is hidden until the morph lands — left the
  // title invisible until scrolling stopped. Timers keep running, so this
  // guarantees the handoff regardless of what the render loop is doing.
  setTimeout(() => { cancelAnimationFrame(raf); settle(); }, ms + 500);

  // Never leave the title invisible if anything goes wrong mid-flight.
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(raf);
    settle();
  }, { once: true });
}

// The page bootstrap: morph the title this page inherited into the one it has.
export function runTitleMorph(fromWord) {
  const h1 = titleEl();
  if (!h1) return finish(null, null);
  return safely(() => morphWord(h1, fromWord, titleText(h1)), h1);
}

// Approximate sampling stride in CSS px, used to size the particles.
function stridePixel(src, dst) {
  const n = Math.max(src.length, dst.length);
  return n > 1800 ? 2 : n > 900 ? 3 : 4;
}

// The handoff itself, with NO once-guard: reveal the element, fade the canvas
// out from under it, drop the canvas.
//
// Split out from finish() because morphWord is now run CONCURRENTLY — text-morph
// drives up to twelve at once. A single module-level flag was correct while the
// only caller was the one title: the first morph to land set it and every other
// morph's cleanup silently became a no-op, so eleven canvases stayed on the page
// forever. Each morph now guards its own completion (see `settle` below) and the
// module flag is left to the bail paths, which really are once-per-navigation.
function finishEl(el, canvas) {
  document.documentElement.classList.remove('title-morphing');
  if (el) {
    el.style.transition = `opacity ${HANDOFF_MS}ms linear`;
    el.style.opacity = '1';
  }
  if (canvas) {
    canvas.style.transition = `opacity ${HANDOFF_MS}ms linear`;
    canvas.style.opacity = '0';
    setTimeout(() => canvas.remove(), HANDOFF_MS + 60);
  }
}

// Bail paths only: runTitleMorph with no <h1>, safely()'s catch, and the
// fonts-not-ready branch. One per navigation by nature, and reset in run().
let finished = false;
function finish(h1, canvas) {
  if (finished) return;
  finished = true;
  finishEl(h1, canvas);
}

// --- wiring ----------------------------------------------------------------

// Every entry point is wrapped: an exception anywhere in here must still end
// with a visible title, because the <h1> is hidden until the morph hands back.
function safely(fn, h1) {
  try { return fn(); } catch (e) { finish(h1 || titleEl(), null); }
}

export function initTitleMorph() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Record this page's title for whichever page comes next.
  //
  // pagehide covers a REAL navigation (link clicks that leave the client
  // router — e.g. the ENTER zoom, which sets window.location.href directly —
  // back/forward across a hard reload, closing the tab). It never fires for
  // an in-app swap, because the document never unloads for one.
  //
  // astro:before-swap is the equivalent moment for that case: it fires while
  // the OUTGOING page's DOM (this <h1>) is still on screen, right before the
  // incoming page's content replaces it. Both listeners are bound once, here,
  // at module scope — this function itself only runs once per session (see
  // the astro:page-load wiring below for why that's fine): document-level
  // listeners aren't torn down by a swap, so one binding covers every
  // navigation for the life of the tab.
  const recordOutgoing = () => {
    const t = titleText(titleEl());
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  };
  window.addEventListener('pagehide', recordOutgoing);
  document.addEventListener('astro:before-swap', recordOutgoing);

  // The part that actually reveals/morphs THIS page's title has to run again
  // on every arrival, not just the first — astro:page-load fires for both.
  // finished is reset here (not just inside morphWord) so a page that takes
  // the "skip the morph" branch (go(false), when fonts aren't ready in time)
  // still calls finish() on a fresh navigation instead of being silently
  // no-op'd by the previous page's already-true flag, which would leave the
  // <h1> hidden forever.
  const run = () => {
    finished = false;

    if (reduce.matches) {
      document.documentElement.classList.remove('title-morphing');
      return;
    }

    const from = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);

    // Fonts must be settled first: rasterising against a fallback face would
    // sample the wrong letterforms and the morph would land off the real title.
    //
    // But that wait is BOUNDED, because the <h1> is hidden until the morph runs
    // and document.fonts.ready can take well over a second — measured at ~1.5s in
    // WebKit — which is a second of blank page title. If the fonts are not ready
    // in time we skip the morph and just show the title: a missing flourish is a
    // fine trade for never showing an empty heading.
    let started = false;
    const go = (morph) => {
      if (started) return;
      started = true;
      if (morph) safely(() => runTitleMorph(from));
      else finish(titleEl(), null);
    };
    const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(() => go(true), () => go(true));
    setTimeout(() => go(false), 450);
  };

  // astro:page-load fires for the first real load too, so this one listener
  // is the entire wiring — no separate immediate call needed.
  document.addEventListener('astro:page-load', run);
}

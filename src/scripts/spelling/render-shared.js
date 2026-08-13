// Render-pipeline pieces shared between the v1 single-mass engine (engine.js)
// and the v2 scramble grid (grid-engine.js). Extracted verbatim from engine.js
// so there is exactly one copy of each — do not fork these per engine.
//
// Everything here is part of the calibrated pipeline described in
// design_handoff_spelling/README.md ("Calibrated constants"). Do not change
// the sprite gradient stops, the feather, or the frame-loop cap/skip logic.

// One pre-rendered blob, blitted per particle — a hard core with a short tail,
// so blur+contrast thresholds right at the true stroke edge. A long gradient
// tail sums to full white far past the core under additive blending, so the
// threshold lands outside the intended edge and every stroke renders fat.
export function makeSprite(D) {
  const pad = Math.max(4, Math.round(D / 2));
  const s = document.createElement('canvas');
  s.width = s.height = pad * 2;
  const g2 = s.getContext('2d');
  const g = g2.createRadialGradient(pad, pad, 0, pad, pad, pad);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.86, 'rgba(255,255,255,1)');
  g.addColorStop(0.94, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  g2.fillStyle = g;
  g2.fillRect(0, 0, pad * 2, pad * 2);
  return { sprite: s, spriteD: pad * 2 };
}

// Resolve the goo filter's feGaussianBlur from the canvas's own document (not
// a bare global document.getElementById), so the same filter id can be reused
// by independent engine instances mounted in different documents/tests.
export function resolveGooBlur(canvas, filterId) {
  const doc = canvas && canvas.ownerDocument;
  if (!doc) return null;
  const filter = doc.getElementById(filterId);
  const blur = filter && filter.querySelector('feGaussianBlur');
  return blur || null;
}

// The shared rAF scheduling wrapper: caps the sim near 48fps
// (`if (now - last < 20) return`) — the form is fluid, not twitchy, and this
// halves the filter cost — and skips entirely while `document.hidden`.
// Returns {start, stop}; start() arms exactly one rAF chain, stop() cancels
// it. Calling start() while already running is a no-op.
// minFrameMs caps the sim. v1 uses 20 (~48fps) because a single slow fluid
// mass does not need more and it halves the filter cost. The GRID must pass 0:
// a 20ms gate against a 16.7ms display clock renders/skips/renders, producing
// alternating 17ms and 33ms frames — judder that reads as a low frame rate
// however cheap the frame actually is.
export function createFrameLoop(renderFrame, minFrameMs = 20) {
  let raf = null;
  let lastF = 0;
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    if (minFrameMs > 0 && lastF && now - lastF < minFrameMs) return;
    lastF = now;
    renderFrame(now);
  };
  return {
    start() {
      if (raf === null) raf = requestAnimationFrame(frame);
    },
    stop() {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
      lastF = 0;
    },
  };
}

// A sprite rasterised ONCE at a fixed resolution, to be drawn scaled to its
// true diameter at blit time. makeSprite sizes the bitmap to the requested
// diameter and floors it at 4px, which is correct for v1 (one large glyph,
// discs ~30px) but wrong for the grid, where the true disc is ~4px: the floor
// silently doubles every stroke and stops thickness scaling with glyph size.
export function makeFixedSprite(res = 48) {
  const s = document.createElement('canvas');
  s.width = s.height = res;
  const g2 = s.getContext('2d');
  const r = res / 2;
  const g = g2.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.86, 'rgba(255,255,255,1)');
  g.addColorStop(0.94, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  g2.fillStyle = g;
  g2.fillRect(0, 0, res, res);
  return s;
}

// A sprite rasterised at its EXACT drawn diameter, so the hot loop can blit it
// unscaled. drawImage with explicit dw/dh resamples on every one of tens of
// thousands of calls per frame; drawing at natural size skips that entirely.
export function makeExactSprite(D) {
  const size = Math.max(3, Math.ceil(D) + 2);
  const s = document.createElement('canvas');
  s.width = s.height = size;
  const g2 = s.getContext('2d');
  const c = size / 2, r = D / 2;
  const g = g2.createRadialGradient(c, c, 0, c, c, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.86, 'rgba(255,255,255,1)');
  g.addColorStop(0.94, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  g2.fillStyle = g;
  g2.fillRect(0, 0, size, size);
  return { sprite: s, spriteD: size };
}

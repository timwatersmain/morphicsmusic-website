// Client-side renderer for the vendored pixel-sprite creature system (see
// ./vendor/README.txt for the sprite/animation/XP contract this draws
// against). Kept separate from ./creature-avatar.js: that module builds the
// static HTML (the circular frame + a <canvas> placeholder), this module
// finds those placeholders after they're in the DOM and actually animates
// them — the same split community pages already use for other async data
// (markup first, JS fills it in on load).
//
// Sizing: 32x32 logical pixels drawn at an INTEGER scale with
// nearest-neighbour sampling only (image-rendering: pixelated) — the
// vendored README is explicit that anything else destroys pixel art. Two
// scales are used on this site:
//   scale 1 (32px canvas)  — the 40px fan-wall/list avatar. 40 is not an
//     integer multiple of 32; rather than blur the art to fill the full
//     40px circle, this renders at native 1x (crisp) and centres it inside
//     the 40px frame with a few px of padding. See creature-avatar.js.
//   scale 3 (96px canvas)  — the ~96px profile-page avatar. 96 = 32 * 3
//     exactly, so this fills the frame edge to edge with no padding at all.

import { frame, sequence } from './vendor/recipes.js';
import { paletteOf, COLORWAYS } from './vendor/colorways.js';
import { SPRITE_DATA_URL } from './data-url.generated.js';

const COLOURWAY_BY_ID = Object.fromEntries(COLORWAYS.map(c => [c.id, c]));

let spritesPromise = null;
/** Map<ref, sprite> for the whole vendored set, fetched once and cached. */
function loadSprites() {
  if (!spritesPromise) {
    spritesPromise = fetch(SPRITE_DATA_URL)
      .then(r => { if (!r.ok) throw new Error(`sprite data fetch failed: ${r.status}`); return r.json(); })
      .then(list => new Map(list.map(s => [s.ref, s])));
  }
  return spritesPromise;
}

const REDUCED_MOTION = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false, addEventListener() {} };

/** Draw one 32x32 grid onto a canvas at an integer `scale`, nearest-neighbour. */
function paintGrid(canvas, grid, palette, scale) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Paint into a 1px-per-cell offscreen buffer first, then let drawImage do
  // the integer upscale — this is what actually guarantees nearest-neighbour
  // (imageSmoothingEnabled only disables the browser's own interpolation; it
  // does not by itself make fillRect-per-pixel any faster or simpler than
  // just letting the canvas API do the scale in one call).
  const off = paintGrid._off || (paintGrid._off = document.createElement('canvas'));
  off.width = 32; off.height = 32;
  const octx = off.getContext('2d');
  const img = octx.createImageData(32, 32);
  for (let r = 0; r < 32; r++) {
    for (let c = 0; c < 32; c++) {
      const key = grid[r][c];
      const hex = key === '.' ? null : palette[key];
      const i = (r * 32 + c) * 4;
      if (!hex) { img.data[i + 3] = 0; continue; }
      img.data[i] = parseInt(hex.slice(1, 3), 16);
      img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.drawImage(off, 0, 0, 32, 32, 0, 0, 32 * scale, 32 * scale);
}

/**
 * Animate (or, under prefers-reduced-motion, statically render frame 0 of)
 * one `<canvas data-creature="...">` element. `dataset.creature` is a JSON
 * string: { ref, stage, colourway, xp, fps, loop } — everything needed to
 * call recipes.js's frame()/sequence() without a second network round trip
 * per creature (see creature-avatar.js, which embeds fps/loop/stage
 * directly from the server payload's sprite lookup... actually those come
 * from the sprite object itself once loaded below).
 */
async function animateOne(canvas) {
  let spec;
  try { spec = JSON.parse(canvas.dataset.creature || '{}'); } catch { return; }
  if (!spec.ref) return;

  const sprites = await loadSprites();
  const sprite = sprites.get(spec.ref);
  if (!sprite) return; // stale ref (shouldn't happen — see sprites.ts) — leave the canvas blank rather than throw

  const scale = Number(canvas.dataset.scale) || 1;
  canvas.width = 32 * scale;
  canvas.height = 32 * scale;

  const colourway = COLOURWAY_BY_ID[spec.colourway] || COLOURWAY_BY_ID.cyan;
  const palette = paletteOf(colourway);
  const xp = Math.max(0, Math.min(100, Number(spec.xp) || 0));
  const order = sequence(sprite.loop);

  const draw = i => paintGrid(canvas, frame(sprite, xp, order[i % order.length]), palette, scale);

  draw(0);
  if (REDUCED_MOTION.matches) return; // static frame 0 only — see the module doc comment

  const fps = Math.max(1, Number(sprite.fps) || 4);
  const intervalMs = 1000 / fps;
  let i = 0;
  let stopped = false;
  const stop = () => { stopped = true; };
  // Stop the loop if the canvas is ever removed from the document (e.g. a
  // fan-wall page re-render) rather than animating a detached node forever.
  const observer = new MutationObserver(() => { if (!canvas.isConnected) { stop(); observer.disconnect(); } });
  observer.observe(document.body, { childList: true, subtree: true });

  const tick = () => {
    if (stopped) return;
    i += 1;
    draw(i);
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
}

/**
 * Find every `[data-creature]` canvas under `root` (default: the whole
 * document) and start it animating. Safe to call repeatedly — e.g. after
 * appending a new page of fan-wall rows — since each canvas is only ever
 * wired up once (guarded by a data attribute) and reduced-motion / missing
 * sprite data degrade to a static frame 0 or a blank disc rather than
 * throwing.
 */
export function initCreatureCanvases(root = document) {
  const canvases = root.querySelectorAll('canvas[data-creature]:not([data-creature-init])');
  canvases.forEach(canvas => {
    canvas.setAttribute('data-creature-init', '1');
    animateOne(canvas);
  });
}

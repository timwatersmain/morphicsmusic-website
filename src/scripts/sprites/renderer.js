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

import { frame, sequence, bbox, toGrid } from './vendor/recipes.js';
import { paletteOf, COLORWAYS } from './vendor/colorways.js';
import { SPRITE_DATA_URL } from './data-url.generated.js';
import { NATIVE_COLOURWAY } from './native-palette.js';

const COLOURWAY_BY_ID = Object.fromEntries(COLORWAYS.map(c => [c.id, c]));

// The author's own rules say sprite art is only "roughly centred with room
// to move" in its 32x32 grid — the recipes rely on that slack to translate
// the creature around for animation. Drawing the grid centred (as before)
// therefore left the creature itself off-centre in the circular avatar by
// however much its ink happened to be offset within the grid.
//
// The fix: centre the INK's bounding box instead of the grid, but derive
// that offset from the sprite's BASE grid ONLY, once, and reuse it as a
// constant for every animation frame and every XP level of that sprite.
// Recentring per frame would cancel out the recipe's deliberate motion;
// recentring per XP level would make the creature appear to slide as it
// grows (XP resizes/fractures the ink — see vendor/recipes.js's applyXp).
// Anchoring on the untouched base keeps the offset a fixed per-sprite
// constant that animation and growth then happen around.
const baseCentreOffsetCache = new Map(); // ref -> { dx, dy }
// Exported for tests only — production code always reaches this through the
// cache above, via animateOne/drawStaticOne.
export function baseCentreOffset(sprite) {
  let off = baseCentreOffsetCache.get(sprite.ref);
  if (off) return off;
  const b = bbox(toGrid(sprite.base));
  if (b.r1 < 0) {
    // No ink at all (shouldn't happen for a real sprite) — nothing to centre.
    off = { dx: 0, dy: 0 };
  } else {
    // Cell (r, c) occupies the unit pixel square [c, c+1) x [r, r+1), so the
    // ink's true pixel-space centre is (c0+c1+1)/2, not (c0+c1)/2 — the
    // extra +1 accounts for cell c1's own width. The frame's centre is at
    // half the 32px grid, i.e. 16. Round to land on an integer pixel offset:
    // this is nearest-neighbour pixel art at integer scale, and a
    // fractional offset would blur/shimmer it. An odd remainder (bbox width
    // or height even vs the +1 correction) rounds via Math.round, which
    // breaks exact .5 ties up (toward the bottom/right) — a one-pixel bias
    // that's imperceptible and, unlike alternating or truncating, keeps the
    // offset a pure, order-independent function of the base grid.
    off = {
      dx: Math.round(16 - (b.c0 + b.c1 + 1) / 2),
      dy: Math.round(16 - (b.r0 + b.r1 + 1) / 2),
    };
  }
  baseCentreOffsetCache.set(sprite.ref, off);
  return off;
}

/**
 * The palette to paint `sprite` with, given a render spec's `colourwayId`.
 * NATIVE_COLOURWAY means "use the sprite's own authored palette" (see
 * vendor/README.txt's SPRITE FORMAT: every sprite carries its own
 * `palette`) instead of recolouring with one of the 12 named colourways.
 * Pulled out as a pure function — no canvas/DOM — so it is unit-testable on
 * its own; animateOne/drawStaticOne are the only callers.
 */
export function paletteForSpec(colourwayId, sprite) {
  if (colourwayId === NATIVE_COLOURWAY) return sprite.palette;
  const colourway = COLOURWAY_BY_ID[colourwayId] || COLOURWAY_BY_ID.cyan;
  return paletteOf(colourway);
}

let spritesPromise = null;
/**
 * Map<ref, sprite> for the whole vendored set, fetched once and cached.
 * Exported so the admin sprite picker (/community/me) can group the full
 * 401-sprite catalogue by stage without a second copy of this fetch/cache
 * — the client already has this whole dataset for rendering, and pulling
 * the same data server-side would mean shipping the ~613KB asset (or a
 * second generated index) through a Workers function for no reason.
 */
export function loadSprites() {
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

/**
 * Draw one 32x32 grid onto a canvas at an integer `scale`, nearest-neighbour,
 * offset by `centre` (a { dx, dy } from baseCentreOffset) so the sprite's ink
 * — not its raw grid — lands centred in the frame. `centre` is in 32-grid
 * pixel units; it gets multiplied by `scale` for the destination draw so the
 * shift stays an integer destination pixel at any scale.
 */
function paintGrid(canvas, grid, palette, scale, centre) {
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
  const dx = (centre && centre.dx) || 0;
  const dy = (centre && centre.dy) || 0;
  // Pixels that shift past the canvas edge are simply not drawn (drawImage
  // clips to the canvas) — fine here since sprite art never touches the
  // grid edge (see vendor/README.txt's art rules), so a centring shift of a
  // few px never clips real ink.
  ctx.drawImage(off, 0, 0, 32, 32, dx * scale, dy * scale, 32 * scale, 32 * scale);
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

  const palette = paletteForSpec(spec.colourway, sprite);
  const xp = Math.max(0, Math.min(100, Number(spec.xp) || 0));
  const order = sequence(sprite.loop);

  const centre = baseCentreOffset(sprite);
  const draw = i => paintGrid(canvas, frame(sprite, xp, order[i % order.length]), palette, scale, centre);

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

/**
 * Same JSON-spec parse + sprite lookup as animateOne, but for the admin
 * sprite picker/collection grid (see initCreatureCanvasesLazy below and
 * creature-avatar.js's spriteTileHtml, the only builder of the specs this
 * reads) — no fps loop, no MutationObserver.
 *
 * PREVIEW-ONLY OVERRIDES, hardcoded rather than read from spec: a
 * collection view is for judging each creature's authored final form, not
 * the viewer's own progress or colour choice, so this always paints at XP
 * 100 (full growth) in the sprite's OWN native palette (sprite.palette) —
 * regardless of any xp/colourway spec.colourway might carry. This is
 * DELIBERATELY separate from animateOne/paletteForSpec, which drive the
 * fan's actual equipped avatar (fan wall, /community/me hero, public
 * profiles) off their real stage, real XP and chosen colourway (or native,
 * if THEY picked it). Do not unify these two paths — that would either
 * make the picker reflect the viewer again, or make the equipped avatar
 * always render full-grown/native, both wrong.
 */
/**
 * The (grid, palette) pair a picker tile paints with for a given sprite —
 * always full growth in the sprite's own native palette. Pulled out as a
 * pure function (no canvas/DOM), same reasoning as paletteForSpec, so the
 * "always XP 100, always native" preview rule is unit-testable without a
 * canvas.
 */
export function pickerPreviewFor(sprite) {
  return { grid: frame(sprite, 100, 0), palette: sprite.palette };
}

async function drawStaticOne(canvas) {
  let spec;
  try { spec = JSON.parse(canvas.dataset.creature || '{}'); } catch { return; }
  if (!spec.ref) return;

  const sprites = await loadSprites();
  const sprite = sprites.get(spec.ref);
  if (!sprite) return; // stale ref — leave the canvas blank rather than throw

  const scale = Number(canvas.dataset.scale) || 1;
  canvas.width = 32 * scale;
  canvas.height = 32 * scale;

  // Picker previews come from pickerPreviewFor (full growth, native palette),
  // but still need the per-sprite centring offset — otherwise every tile in a
  // 401-sprite grid sits slightly off-centre in its circle.
  const { grid, palette } = pickerPreviewFor(sprite);
  paintGrid(canvas, grid, palette, scale, baseCentreOffset(sprite));
}

/**
 * For a picker/grid of MANY creatures (e.g. the admin sprite picker on
 * /community/me, which browses all 401 sprites) — each canvas is drawn
 * once, statically, and only once it actually scrolls into view. Mounting
 * 401 `<canvas data-creature>` placeholders is cheap; painting all 401
 * (createImageData + a full sprite fetch/lookup each) at once is what
 * janks the page, so that work is deferred to an IntersectionObserver
 * instead of running eagerly like initCreatureCanvases does for the one or
 * two creatures a normal page shows.
 */
export function initCreatureCanvasesLazy(root = document) {
  const canvases = root.querySelectorAll('canvas[data-creature]:not([data-creature-init])');
  if (!canvases.length) return;
  if (typeof IntersectionObserver !== 'function') {
    // No IO support: fall back to drawing everything immediately rather
    // than showing permanently-blank tiles.
    canvases.forEach(c => { c.setAttribute('data-creature-init', '1'); drawStaticOne(c); });
    return;
  }
  const io = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      io.unobserve(canvas);
      canvas.setAttribute('data-creature-init', '1');
      drawStaticOne(canvas);
    }
  }, { rootMargin: '200px' });
  canvases.forEach(c => io.observe(c));
}

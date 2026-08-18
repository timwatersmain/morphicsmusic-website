// Builds the HTML for a fan's creature avatar — the pixel-sprite render that
// REPLACES the glyph medallion (avatar.js's avatarHtml) as the primary
// avatar wherever one appears: the fan wall, /community/me, and public
// profiles. Keeps the exact same circular-frame wrapper avatar.js uses (see
// its `avatarHtml`) so the rest of each page's layout/CSS needs no changes.
//
// This only builds a placeholder `<canvas data-creature="...">` — the actual
// pixel drawing and animation happens in ./renderer.js, once the element is
// in the DOM (see that module's initCreatureCanvases). Splitting it this way
// mirrors how these pages already handle async data: markup first, a
// separate script fills it in.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * @param {{ stage: string, sprite_ref: string|null, colourway: string|null, stage_xp: number } | null} creature
 * @param {number} sizePx - the circular frame's diameter, e.g. 40 (fan wall) or 96 (profile).
 */
export function creatureAvatarHtml(creature, sizePx) {
  const border = 'border-primary/60';

  if (!creature || !creature.sprite_ref) {
    // No sprite assigned yet (a legacy profile that hasn't had its one-time
    // backfill run — see repo.ts's ensureSpriteAssignment) — an empty disc
    // rather than nothing, so layout never jumps once it does load.
    return `<div class="relative inline-block">` +
      `<div class="rounded-full overflow-hidden border-2 ${border} bg-surface-container-lowest" ` +
      `style="width:${sizePx}px;height:${sizePx}px"></div></div>`;
  }

  // Integer scale only — nearest-neighbour art at any other scale smears.
  // scale 1 (32px raster) for the compact sizes, scale 3 (96px raster, an
  // EXACT multiple of 32) for the larger profile size; anything else falls
  // back to whichever of those two is closer, so a future size choice never
  // accidentally lands on a non-integer scale.
  const scale = sizePx >= 64 ? 3 : 1;
  const artPx = 32 * scale;

  const spec = esc(JSON.stringify({
    ref: creature.sprite_ref,
    colourway: creature.colourway || 'cyan',
    xp: typeof creature.stage_xp === 'number' ? creature.stage_xp : 0,
  }));

  // artPx may be smaller than sizePx (the 40px/scale-1 case: 32px art
  // centred in a 40px frame) — grid place-items:center handles that
  // centring without any extra math.
  return `<div class="relative inline-block">` +
    `<div class="rounded-full overflow-hidden border-2 ${border} grid place-items-center bg-surface-container-lowest" ` +
    `style="width:${sizePx}px;height:${sizePx}px">` +
    `<canvas data-creature="${spec}" data-scale="${scale}" width="${artPx}" height="${artPx}" ` +
    `style="width:${artPx}px;height:${artPx}px;image-rendering:pixelated" aria-hidden="true"></canvas>` +
    `</div></div>`;
}

/**
 * One tile in the admin sprite picker (/community/me): a static preview of
 * a single sprite ref, at a small fixed size, ALWAYS full-grown (XP 100)
 * and in its own native palette — a collection view is for judging each
 * creature's authored final form, not the viewer's own progress or colour
 * choice. Those two overrides are applied by renderer.js's drawStaticOne
 * (the function initCreatureCanvasesLazy uses to paint these tiles), not
 * here — this just builds the spec; no `colourway` param is threaded
 * through anymore because the preview never varies by viewer colourway.
 * Deliberately NOT built from a PublicCreature — the picker browses sprites
 * that are not necessarily this fan's own stage sprites, so there is no
 * `stage` to thread through either.
 *
 * @param {string} ref
 * @param {number} sizePx - always scale-1 (native 32px art), since the
 *   picker's whole point is showing many sprites at once in a compact grid.
 * @param {boolean} selected - true for the currently-equipped override.
 */
export function spriteTileHtml(ref, sizePx, selected) {
  const spec = esc(JSON.stringify({ ref }));
  const ring = selected ? 'border-secondary ring-2 ring-secondary/60' : 'border-white/10';
  return `<div class="rounded-full overflow-hidden border-2 ${ring} grid place-items-center bg-surface-container-lowest" ` +
    `style="width:${sizePx}px;height:${sizePx}px">` +
    `<canvas data-creature="${spec}" data-scale="1" width="32" height="32" ` +
    `style="width:${sizePx}px;height:${sizePx}px;image-rendering:pixelated" aria-hidden="true"></canvas>` +
    `</div>`;
}

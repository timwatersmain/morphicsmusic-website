// Renders a fan avatar from its RECIPE (style + colourway [+ artwork_key]),
// not from a picture. A catalogue row only ever describes tiers 1-4 as:
//   tier 1  glyph_solid    a dark disc in the colourway's tone
//   tier 2  glyph_inverted a solid colourway disc
//   tier 3  duotone        photo recoloured to one colourway hue
//   tier 4  glyph_overlay  duotone artwork tinted by the colourway
// These style names predate this cleanup (see avatar_catalogue's `style`
// column, untouched here) — tiers 1/2/4 used to also draw a per-fan letter
// from the Morphian alphabet on top, derived server-side from each fan's
// username. The pixel-sprite creature (src/scripts/sprites/) now owns the
// avatar slot everywhere a fan is shown, so nothing ever sends a letter to
// draw here any more — the glyph-drawing code (and the server-side letter
// derivation it depended on) has been removed rather than kept for a value
// that never arrives.
//
// The three community pages (index/me/profile) used to each hand-roll an
// equivalent medallionHtml(); a component once documented that copy as
// "reviewed and accepted" debt because the old avatars were plain images.
// Now that rendering has real per-tier logic, that duplication is a real
// liability, so this module is the ONE place it lives — every page's
// client script imports avatarHtml() from here instead of keeping its own
// copy. (The old AvatarMedallion.astro component that predated this module
// has been deleted — nothing imported it once this shared renderer landed.)
//
// `art_path` is a documented NOT-NULL sentinel ('(procedural)') for tiers
// 1-2, since that column can't be dropped. We therefore always branch on
// `style` first; art_path is only ever treated as a URL when `style` is
// null/undefined — the 21 pre-existing release/special avatars, which keep
// rendering exactly as they always have.

import { COLOURWAYS } from '../../functions/_lib/community/colourways';

const HEX_BY_KEY = Object.fromEntries(COLOURWAYS.map(c => [c.key, c.hex]));

// The ladder's own fixed "dark" tone — what tier 1's disc sits on. Not a
// colourway (fans never pick it), so it is the one hex allowed to live here
// rather than in colourways.ts. Matches --color-surface-container-high in
// the live @theme block in global.css.
const DARK = '#2A2A2A';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Only ever a same-origin path or an https URL — never allow a data: or
// javascript: value from the API into an <img src>.
const safeImg = s => {
  const v = String(s ?? '');
  return /^(https?:|\/)/.test(v) ? v : '';
};

// The disc content for a tier 1-4 recipe row, or null for a legacy
// (style-less) row so the caller falls back to plain art_path rendering.
// Tiers 1/2/4 used to also draw a per-fan letter here (see this file's
// header comment) — that drawing code is gone along with the server-side
// derivation that fed it, so these discs are now background/artwork only.
function tierDiscInner(avatar, sizePx) {
  const hex = HEX_BY_KEY[avatar.colourway] || DARK;
  const img = safeImg(avatar.art_path);

  switch (avatar.style) {
    case 'glyph_solid': // tier 1
      return `<div class="w-full h-full" style="background:${DARK}"></div>`;

    case 'glyph_inverted': // tier 2
      return `<div class="w-full h-full" style="background:${hex}"></div>`;

    case 'duotone': // tier 3 — a real duotone (mix-blend-mode), not a hue-rotate approximation
    case 'glyph_overlay': // tier 4 — same duotone treatment, larger disc in practice
      return `<div class="w-full h-full" style="background:${hex}">` +
        (img ? `<img src="${esc(img)}" alt="" width="${sizePx}" height="${sizePx}" loading="lazy" decoding="async" ` +
          `class="w-full h-full object-cover" style="mix-blend-mode:luminosity;opacity:.95" />` : '') +
        `</div>`;

    default:
      return null;
  }
}

/**
 * Render a fan avatar disc as an HTML string.
 *
 * @param {{ name?: string, art_path?: string|null, style?: string|null, colourway?: string|null } | null} avatar
 * @param {number} sizePx - disc diameter in pixels.
 * @param {{ locked?: boolean, rarity?: number }} [opts]
 */
export function avatarHtml(avatar, sizePx, opts = {}) {
  const { locked = false, rarity } = opts;
  const name = (avatar && avatar.name) || '';
  const border = locked ? 'border-white/10' : 'border-primary/60';
  // One dim treatment (CSS filter on the whole disc) covers both the legacy
  // <img> path and the CSS/SVG-drawn recipe discs, instead of needing a
  // separate "locked" branch per style.
  const dim = locked ? 'grayscale opacity-30' : '';

  const recipeInner = avatar && avatar.style ? tierDiscInner(avatar, sizePx) : null;
  let inner;
  if (recipeInner) {
    inner = recipeInner;
  } else {
    const legacyImg = safeImg(avatar && avatar.art_path);
    inner = legacyImg
      ? `<img src="${esc(legacyImg)}" alt="${esc(name)}" width="${sizePx}" height="${sizePx}" loading="lazy" decoding="async" class="w-full h-full object-cover" />`
      : `<div class="w-full h-full bg-surface-container-high"></div>`;
  }

  const lockBadge = locked
    ? `<span class="material-symbols-outlined absolute inset-0 grid place-items-center text-white/50 text-[18px]">lock</span>`
    : '';
  const rarityBadge = (!locked && typeof rarity === 'number' && rarity > 0 && rarity <= 0.1)
    ? `<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 font-mono text-[8px] uppercase tracking-widest bg-secondary text-on-secondary px-1">${esc(Math.max(1, Math.round(rarity * 100)))}%</span>`
    : '';

  return `<div class="relative inline-block">` +
    `<div class="rounded-full overflow-hidden border-2 ${border} transition-colors ${dim}" style="width:${sizePx}px;height:${sizePx}px">${inner}</div>` +
    `${lockBadge}${rarityBadge}</div>`;
}

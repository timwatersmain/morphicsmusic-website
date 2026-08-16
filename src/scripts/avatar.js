// Renders a fan avatar from its RECIPE (style + colourway [+ artwork_key]),
// not from a picture. A catalogue row only ever describes tiers 1-4 as:
//   tier 1  glyph_solid    coloured glyph on a dark disc
//   tier 2  glyph_inverted dark glyph on a solid colourway disc
//   tier 3  duotone        photo recoloured to one colourway hue
//   tier 4  glyph_overlay  duotone artwork + white/outlined glyph on top
// The glyph letter is derived server-side from each fan's private username
// (see functions/_lib/community/glyph.ts) and sent as a single character on
// every avatar object — never the username itself. This renderer stays
// dumb about that: it just draws whatever letter the caller passes in, so
// every fan wearing "tier 1 / cyan" sees their own letter.
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
import { glyphLetterFor } from '../../functions/_lib/community/glyph';

export { glyphLetterFor };

const HEX_BY_KEY = Object.fromEntries(COLOURWAYS.map(c => [c.key, c.hex]));

// The ladder's own fixed "dark" tone — what tier 1's disc sits on and what
// tier 2's glyph is drawn in. Not a colourway (fans never pick it), so it is
// the one hex allowed to live here rather than in colourways.ts. Matches
// --color-surface-container-high in the live @theme block in global.css.
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

// One glyph rendering technique everywhere (tiers 1, 2 and 4), rather than
// picking a different one per tier. SVG <text> was chosen over an HTML span
// with -webkit-text-stroke: the stroke needs to sit strictly BEHIND the fill
// (paint-order="stroke fill") so a thin outline reads as a hairline at 40px
// instead of eating into the letterform — text-stroke straddles the fill
// edge on both sides and visibly thickens/blurs the glyph at small sizes,
// and it is Safari-only without a duplicated non-prefixed fallback anyway.
function glyphSvg(letter, { fill, stroke, sizePx, scale }) {
  const fontSize = Math.round(sizePx * scale);
  // paint-order="stroke fill" paints the fill OVER the inner half of the
  // stroke, so only the outer ~half of stroke-width actually shows as a
  // ring — a 0.06 multiplier measured that way to ~1px at 40px, and
  // anti-aliasing ate it entirely (verified: it was indistinguishable from
  // the plain AA edge in a screenshot). 0.14 with a 2px floor keeps a
  // visible outline surviving at 40px without visibly fattening the
  // letterform at 84px+.
  const strokeAttrs = stroke
    ? ` stroke="${stroke}" stroke-width="${Math.max(2, Math.round(fontSize * 0.14))}" paint-order="stroke fill" stroke-linejoin="round"`
    : '';
  return `<svg viewBox="0 0 ${sizePx} ${sizePx}" width="100%" height="100%" aria-hidden="true" focusable="false">` +
    `<text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-family="Morphian" font-size="${fontSize}"` +
    ` fill="${fill}"${strokeAttrs}>${esc(letter)}</text></svg>`;
}

// The disc content for a tier 1-4 recipe row, or null for a legacy
// (style-less) row so the caller falls back to plain art_path rendering.
function tierDiscInner(avatar, glyphLetter, sizePx) {
  const hex = HEX_BY_KEY[avatar.colourway] || DARK;
  const img = safeImg(avatar.art_path);

  switch (avatar.style) {
    case 'glyph_solid': // tier 1
      return `<div class="w-full h-full grid place-items-center" style="background:${DARK}">` +
        `${glyphSvg(glyphLetter, { fill: hex, sizePx, scale: 0.6 })}</div>`;

    case 'glyph_inverted': // tier 2
      return `<div class="w-full h-full grid place-items-center" style="background:${hex}">` +
        `${glyphSvg(glyphLetter, { fill: DARK, sizePx, scale: 0.6 })}</div>`;

    case 'duotone': // tier 3 — a real duotone (mix-blend-mode), not a hue-rotate approximation
      return `<div class="w-full h-full" style="background:${hex}">` +
        (img ? `<img src="${esc(img)}" alt="" width="${sizePx}" height="${sizePx}" loading="lazy" decoding="async" ` +
          `class="w-full h-full object-cover" style="mix-blend-mode:luminosity;opacity:.95" />` : '') +
        `</div>`;

    case 'glyph_overlay': // tier 4 — duotone artwork with the glyph on top, larger than tiers 1-2
      return `<div class="relative w-full h-full" style="background:${hex}">` +
        (img ? `<img src="${esc(img)}" alt="" width="${sizePx}" height="${sizePx}" loading="lazy" decoding="async" ` +
          `class="w-full h-full object-cover" style="mix-blend-mode:luminosity;opacity:.95" />` : '') +
        `<div class="absolute inset-0 grid place-items-center">` +
        `${glyphSvg(glyphLetter, { fill: '#FFFFFF', stroke: '#000000', sizePx, scale: 0.72 })}</div></div>`;

    default:
      return null;
  }
}

/**
 * Render a fan avatar disc as an HTML string.
 *
 * @param {{ name?: string, art_path?: string|null, style?: string|null, colourway?: string|null } | null} avatar
 * @param {string} glyphLetter - the server-sent `avatar.glyph` field; ignored for legacy (style-less) rows.
 * @param {number} sizePx - disc diameter in pixels.
 * @param {{ locked?: boolean, rarity?: number }} [opts]
 */
export function avatarHtml(avatar, glyphLetter, sizePx, opts = {}) {
  const { locked = false, rarity } = opts;
  const name = (avatar && avatar.name) || '';
  const border = locked ? 'border-white/10' : 'border-primary/60';
  // One dim treatment (CSS filter on the whole disc) covers both the legacy
  // <img> path and the CSS/SVG-drawn recipe discs, instead of needing a
  // separate "locked" branch per style.
  const dim = locked ? 'grayscale opacity-30' : '';

  const recipeInner = avatar && avatar.style ? tierDiscInner(avatar, glyphLetter, sizePx) : null;
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

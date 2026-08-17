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
import { GLYPH_OFFSETS } from './avatar-glyph-offsets.generated';

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
// The outline used to scale with font size (0.14 * fontSize, 2px floor) —
// that was ~4px raw (≈2px visible, see below) at a 40px avatar's fontSize,
// but ~8px raw (≈4px visible) at 84px, which read as heavy and closed up
// the glyph's counters. An outline is a legibility device: it needs to
// separate the mark from a busy photo behind it, which is a property of
// RENDERED pixels, not of the glyph's size. So it is now a size-INDEPENDENT
// constant, clamped only so it can't vanish on a vanishingly small disc or
// swallow one entirely.
//
// paint-order="stroke fill" paints the fill over the inner half of the
// stroke, so only the outer ~half of stroke-width actually shows as a ring
// — a raw width of 4 renders as a ~2px visible separation, which is what
// the original 40px case measured as the minimum that survives
// anti-aliasing (see the incident this replaced: 0.06x measured to ~1px
// and disappeared entirely). SVG stroke-width is in the viewBox's user
// units, which the browser maps to the element's CSS pixel box (viewBox is
// `0 0 sizePx sizePx` at width/height 100%) and then rasterises at the
// display's native resolution — so this number is already a CSS-pixel
// width and reads crisp on a 2x/3x display without any extra DPR math.
const STROKE_RAW_PX = 4; // ≈2px visible ring after paint-order halving
function strokeWidthFor(sizePx) {
  return Math.max(1, Math.min(STROKE_RAW_PX, sizePx * 0.25));
}

function glyphSvg(letter, { fill, stroke, sizePx, scale }) {
  const fontSize = Math.round(sizePx * scale);
  const strokeAttrs = stroke
    ? ` stroke="${stroke}" stroke-width="${strokeWidthFor(sizePx)}" paint-order="stroke fill" stroke-linejoin="round"`
    : '';
  // Per-letter ink-centring (see avatar-glyph-offsets.generated.js for the
  // full derivation and why it's split like this). Both numbers are
  // fractions of fontSize, so the correction scales correctly whether this
  // is a 40px tier-1 glyph (scale 0.6) or an 84px tier-4 overlay glyph
  // (scale 0.72) — it always tracks the ACTUAL rendered font size, never
  // the disc size.
  //
  // Horizontal: text-anchor="middle" (kept — it's well-behaved on this
  // axis) plus a small dx delta correcting advance-box-centre vs
  // ink-centre.
  //
  // Vertical: dominant-baseline="middle" is deliberately NOT used, even
  // though this specific font/engine combination centres reasonably well
  // with it. "middle" is one of the least consistently implemented SVG/CSS
  // text properties — during this fix, testing it against a font that
  // FAILED to load (a bug in the verification harness, not this file)
  // showed it can resolve per glyph-identity rather than actual ink, up to
  // several px off at 84px, entirely independent of the font's own
  // outlines. Rather than depend on however any given engine happens to
  // resolve "middle" for Morphian specifically, y is computed directly
  // from the font's own metrics against the default (alphabetic) baseline
  // — a precisely specified SVG behaviour with no engine judgment call
  // left in it.
  const off = GLYPH_OFFSETS[letter] || { dx: 0, dy: 0 };
  const dx = (off.dx * fontSize).toFixed(2);
  const y = (sizePx / 2 + off.dy * fontSize).toFixed(2);
  return `<svg viewBox="0 0 ${sizePx} ${sizePx}" width="100%" height="100%" aria-hidden="true" focusable="false">` +
    `<text x="50%" y="${y}" dx="${dx}" text-anchor="middle" font-family="Morphian" font-size="${fontSize}"` +
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

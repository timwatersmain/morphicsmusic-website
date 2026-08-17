// avatar.js is the one place the four-tier avatar disc is rendered — the
// three community pages all call avatarHtml() instead of keeping their own
// copy. These tests exercise the pure string output directly, without a
// browser, since the function has no DOM/network dependency of its own.

import { describe, it, expect } from 'vitest';
import { avatarHtml, glyphLetterFor } from '../../src/scripts/avatar.js';
import { colourwayHex } from '../../functions/_lib/community/colourways';

describe('avatarHtml — tier recipes', () => {
  it('tier 1 (glyph_solid) paints the colourway hex as the glyph fill on a dark disc', () => {
    const html = avatarHtml({ style: 'glyph_solid', colourway: 'cyan', name: 'Signal — Cyan' }, 's', 40);
    expect(html).toContain(colourwayHex('cyan'));
    expect(html).toContain('font-family="Morphian"');
    expect(html).toContain('>s</text>');
    // No stroke on tiers 1-2.
    expect(html).not.toContain('paint-order');
  });

  it('tier 2 (glyph_inverted) fills the whole disc with the colourway and the glyph is dark', () => {
    const html = avatarHtml({ style: 'glyph_inverted', colourway: 'mint', name: 'Verified — Mint' }, 'm', 40);
    expect(html).toContain(`background:${colourwayHex('mint')}`);
    expect(html).not.toContain('paint-order');
  });

  it('tier 3 (duotone) uses mix-blend-mode:luminosity over a colourway background, not a hue-rotate filter', () => {
    const html = avatarHtml({
      style: 'duotone', colourway: 'teal', art_path: '/images/visuals/dscf3589-960.webp', name: 'Duotone',
    }, 'a', 84);
    expect(html).toContain(`background:${colourwayHex('teal')}`);
    expect(html).toContain('mix-blend-mode:luminosity');
    expect(html).not.toContain('hue-rotate');
    expect(html).toContain('src="/images/visuals/dscf3589-960.webp"');
  });

  it('tier 4 (glyph_overlay) layers a stroked white glyph over the duotone artwork', () => {
    const html = avatarHtml({
      style: 'glyph_overlay', colourway: 'green', art_path: '/images/visuals/timeline-02-960.webp', name: 'Overlay',
    }, 't', 84);
    expect(html).toContain('mix-blend-mode:luminosity');
    expect(html).toContain('fill="#FFFFFF"');
    expect(html).toContain('stroke="#000000"');
    expect(html).toContain('paint-order="stroke fill"');
  });

  it('the tier 4 glyph is larger (relative to disc size) than tier 1/2', () => {
    const t1 = avatarHtml({ style: 'glyph_solid', colourway: 'cyan' }, 's', 100);
    const t4 = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/images/visuals/dscf3589-960.webp' }, 's', 100);
    const fontSize = html => Number(html.match(/font-size="(\d+)"/)[1]);
    expect(fontSize(t4)).toBeGreaterThan(fontSize(t1));
  });

  it('never treats art_path as a URL when style is set, even the (procedural) sentinel', () => {
    const html = avatarHtml({ style: 'glyph_solid', colourway: 'cyan', art_path: '(procedural)' }, 's', 40);
    expect(html).not.toContain('(procedural)');
    expect(html).not.toContain('<img');
  });
});

describe('avatarHtml — legacy (release/special) avatars', () => {
  it('renders art_path as a plain image when style is null', () => {
    const html = avatarHtml({ style: null, art_path: '/images/avatars/some-release.webp', name: 'Some Release' }, 'x', 64);
    expect(html).toContain('<img src="/images/avatars/some-release.webp"');
  });

  it('renders art_path as a plain image when style is undefined (older API shapes)', () => {
    const html = avatarHtml({ art_path: '/images/avatars/some-release.webp', name: 'Some Release' }, 'x', 64);
    expect(html).toContain('<img src="/images/avatars/some-release.webp"');
  });

  it('falls back to an empty disc when there is no art and no style', () => {
    const html = avatarHtml({ name: 'Nothing' }, 'x', 64);
    expect(html).not.toContain('<img');
    expect(html).toContain('bg-surface-container-high');
  });

  it('rejects a non-http(s)/relative art_path (e.g. javascript:) rather than rendering it', () => {
    const html = avatarHtml({ art_path: 'javascript:alert(1)', name: 'Evil' }, 'x', 64);
    expect(html).not.toContain('javascript:');
  });
});

describe('avatarHtml — locking, rarity and escaping', () => {
  it('dims a locked disc with a single filter class regardless of style', () => {
    const legacy = avatarHtml({ art_path: '/x.webp', name: 'X' }, 'x', 40, { locked: true });
    const recipe = avatarHtml({ style: 'duotone', colourway: 'cyan', art_path: '/x.webp' }, 'x', 40, { locked: true });
    expect(legacy).toContain('grayscale opacity-30');
    expect(recipe).toContain('grayscale opacity-30');
    expect(legacy).toContain('material-symbols-outlined');
  });

  it('shows a rarity badge only when unlocked and rare', () => {
    const rare = avatarHtml({ art_path: '/x.webp' }, 'x', 40, { rarity: 0.05 });
    const common = avatarHtml({ art_path: '/x.webp' }, 'x', 40, { rarity: 0.5 });
    const lockedRare = avatarHtml({ art_path: '/x.webp' }, 'x', 40, { rarity: 0.05, locked: true });
    expect(rare).toContain('5%');
    expect(common).not.toContain('font-mono text-[8px]');
    expect(lockedRare).not.toContain('font-mono text-[8px]');
  });

  it('escapes a hostile glyph letter and avatar name', () => {
    const html = avatarHtml({ style: 'glyph_solid', colourway: 'cyan', name: '<script>' }, '<x>', 40, { locked: true });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<x>');
  });

  it('sizes the disc to the requested pixel size', () => {
    const html = avatarHtml({ art_path: '/x.webp' }, 'x', 84);
    expect(html).toContain('width:84px;height:84px');
  });
});

describe('glyphLetterFor is re-exported for callers to derive a fan\'s letter from their handle', () => {
  it('is the same function as the server-side module', () => {
    expect(glyphLetterFor('skratchwax')).toBe('s');
  });
});

describe('glyph_overlay stroke width is constant in rendered pixels, not proportional to disc size', () => {
  // Regression for the "too-thick outline at 84px" fix. The OLD formula
  // (0.14 * fontSize, 2px floor) gave stroke-width 4 at a 40px avatar's
  // fontSize but 8 at 84px — doubling with size, which is exactly the bug:
  // a legibility device that gets heavier as the avatar gets bigger, when
  // it should stay ~constant so it neither vanishes nor dominates.
  const strokeWidth = (html) => Number(html.match(/stroke-width="([\d.]+)"/)[1]);

  it('is identical at 40px and 84px (both land in the normal, non-clamped range)', () => {
    const at40 = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/x.webp' }, 'm', 40);
    const at84 = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/x.webp' }, 'm', 84);
    expect(strokeWidth(at40)).toBe(strokeWidth(at84));
  });

  it('is thinner at 84px than the old size-proportional formula would have produced (8)', () => {
    const at84 = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/x.webp' }, 'm', 84);
    expect(strokeWidth(at84)).toBeLessThan(8);
  });

  it('matches the old formula\'s value at 40px (4) — the 40px legibility case this was built around is unchanged', () => {
    const at40 = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/x.webp' }, 'm', 40);
    expect(strokeWidth(at40)).toBe(4);
  });

  it('never vanishes to 0 or dominates the disc on an extreme (very small) size', () => {
    const tiny = avatarHtml({ style: 'glyph_overlay', colourway: 'cyan', art_path: '/x.webp' }, 'm', 8);
    const w = strokeWidth(tiny);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(8 * 0.25);
  });

  it('tiers 1-2 (glyph_solid/glyph_inverted) have no stroke at all — unaffected by this fix', () => {
    const solid = avatarHtml({ style: 'glyph_solid', colourway: 'cyan' }, 'm', 84);
    const inverted = avatarHtml({ style: 'glyph_inverted', colourway: 'mint' }, 'm', 84);
    expect(solid).not.toContain('stroke-width');
    expect(inverted).not.toContain('stroke-width');
  });
});

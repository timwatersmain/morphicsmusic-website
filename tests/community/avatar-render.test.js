// avatar.js is the one place the four-tier avatar disc is rendered — the
// three community pages and AvatarMedallion.astro all call avatarHtml()
// instead of keeping their own copy. These tests exercise the pure string
// output directly, without a browser, since the function has no DOM/network
// dependency of its own.

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

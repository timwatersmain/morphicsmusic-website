// avatar.js is the one place the four-tier avatar disc is rendered — the
// community pages that still show a catalogue tile (me's picker, profile's
// shelf) call avatarHtml() instead of keeping their own copy. These tests
// exercise the pure string output directly, without a browser, since the
// function has no DOM/network dependency of its own.
//
// Tiers 1/2/4 used to also draw a per-fan Morphian letter on the disc —
// that rendering path (and the server-side derivation that fed it) has been
// removed along with the KV lookups that computed it, since the pixel-sprite
// creature now owns every fan's visible avatar slot. These discs are
// background/artwork only now; there is no letter left to test.

import { describe, it, expect } from 'vitest';
import { avatarHtml } from '../../src/scripts/avatar.js';
import { colourwayHex } from '../../functions/_lib/community/colourways';

describe('avatarHtml — tier recipes', () => {
  it('tier 1 (glyph_solid) is a fixed dark disc', () => {
    const html = avatarHtml({ style: 'glyph_solid', colourway: 'cyan', name: 'Signal — Cyan' }, 40);
    expect(html).toContain('background:#2A2A2A');
    expect(html).not.toContain('font-family="Morphian"');
  });

  it('tier 2 (glyph_inverted) fills the whole disc with the colourway', () => {
    const html = avatarHtml({ style: 'glyph_inverted', colourway: 'mint', name: 'Verified — Mint' }, 40);
    expect(html).toContain(`background:${colourwayHex('mint')}`);
  });

  it('tier 3 (duotone) uses mix-blend-mode:luminosity over a colourway background, not a hue-rotate filter', () => {
    const html = avatarHtml({
      style: 'duotone', colourway: 'teal', art_path: '/images/visuals/dscf3589-960.webp', name: 'Duotone',
    }, 84);
    expect(html).toContain(`background:${colourwayHex('teal')}`);
    expect(html).toContain('mix-blend-mode:luminosity');
    expect(html).not.toContain('hue-rotate');
    expect(html).toContain('src="/images/visuals/dscf3589-960.webp"');
  });

  it('tier 4 (glyph_overlay) gets the same duotone artwork treatment as tier 3, with no glyph overlay', () => {
    const html = avatarHtml({
      style: 'glyph_overlay', colourway: 'green', art_path: '/images/visuals/timeline-02-960.webp', name: 'Overlay',
    }, 84);
    expect(html).toContain('mix-blend-mode:luminosity');
    expect(html).not.toContain('font-family="Morphian"');
    expect(html).not.toContain('stroke=');
  });

  it('never treats art_path as a URL when style is set, even the (procedural) sentinel', () => {
    const html = avatarHtml({ style: 'glyph_solid', colourway: 'cyan', art_path: '(procedural)' }, 40);
    expect(html).not.toContain('(procedural)');
    expect(html).not.toContain('<img');
  });
});

describe('avatarHtml — legacy (release/special) avatars', () => {
  it('renders art_path as a plain image when style is null', () => {
    const html = avatarHtml({ style: null, art_path: '/images/avatars/some-release.webp', name: 'Some Release' }, 64);
    expect(html).toContain('<img src="/images/avatars/some-release.webp"');
  });

  it('renders art_path as a plain image when style is undefined (older API shapes)', () => {
    const html = avatarHtml({ art_path: '/images/avatars/some-release.webp', name: 'Some Release' }, 64);
    expect(html).toContain('<img src="/images/avatars/some-release.webp"');
  });

  it('falls back to an empty disc when there is no art and no style', () => {
    const html = avatarHtml({ name: 'Nothing' }, 64);
    expect(html).not.toContain('<img');
    expect(html).toContain('bg-surface-container-high');
  });

  it('rejects a non-http(s)/relative art_path (e.g. javascript:) rather than rendering it', () => {
    const html = avatarHtml({ art_path: 'javascript:alert(1)', name: 'Evil' }, 64);
    expect(html).not.toContain('javascript:');
  });
});

describe('avatarHtml — locking, rarity and escaping', () => {
  it('dims a locked disc with a single filter class regardless of style', () => {
    const legacy = avatarHtml({ art_path: '/x.webp', name: 'X' }, 40, { locked: true });
    const recipe = avatarHtml({ style: 'duotone', colourway: 'cyan', art_path: '/x.webp' }, 40, { locked: true });
    expect(legacy).toContain('grayscale opacity-30');
    expect(recipe).toContain('grayscale opacity-30');
    expect(legacy).toContain('material-symbols-outlined');
  });

  it('shows a rarity badge only when unlocked and rare', () => {
    const rare = avatarHtml({ art_path: '/x.webp' }, 40, { rarity: 0.05 });
    const common = avatarHtml({ art_path: '/x.webp' }, 40, { rarity: 0.5 });
    const lockedRare = avatarHtml({ art_path: '/x.webp' }, 40, { rarity: 0.05, locked: true });
    expect(rare).toContain('5%');
    expect(common).not.toContain('font-mono text-[8px]');
    expect(lockedRare).not.toContain('font-mono text-[8px]');
  });

  it('escapes a hostile avatar name', () => {
    const html = avatarHtml({ style: null, art_path: '/x.webp', name: '<script>' }, 40, { locked: true });
    expect(html).not.toContain('<script>');
  });

  it('sizes the disc to the requested pixel size', () => {
    const html = avatarHtml({ art_path: '/x.webp' }, 84);
    expect(html).toContain('width:84px;height:84px');
  });
});

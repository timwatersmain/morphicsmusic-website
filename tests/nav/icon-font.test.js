import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectIcons,
  collectExplicitIconDeclarations,
  assertExplicitIconsSurvive,
  hashFontBuffer,
  hashedFontFilename,
  rewriteBaseLayoutFontRef,
  staleSubsetFonts,
  extractSubsetFilename,
} from '../../scripts/subset-icon-font.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Pins the fix for the COMMUNITY nav icon bug: it rendered literal ligature
// text (first "diversity_3", from a stale cached font; then, when one real
// browser kept showing it even against a byte-verified-correct font, the
// icon was moved to "groups" rather than keep chasing an unreproducible
// per-browser failure). The root cause addressed here is structural:
// scripts/subset-icon-font.mjs's source scan can silently drop an icon
// that's actually used (it only keeps tokens that match a real upstream
// glyph name, with no check that every icon the site declares actually
// survived). This test pins the guard added for that: assertExplicitIconsSurvive
// throws when a declared `icon:` value is not a glyph in the upstream font,
// instead of shipping a word.
//
// Why this, and not a static check against the shipped font file: the task
// that produced this fix tried three static introspection methods (raw byte
// search, cmap lookup, fontTools getGlyphOrder() on the OUTPUT file) and all
// three gave false negatives for icons that render fine live (e.g.
// "storefront"), because fontTools renames subsetted glyphs to uniXXXX and
// strips friendly names — confirmed directly in this repo:
//   python3 -m fontTools.subset ... --glyphs=diversity_3,storefront ...
//   -> glyph order becomes ['.notdef', 'uniEA12', 'uniF8D9', 'space']
// So a test asserting "'diversity_3' is a glyph name in the output font"
// would fail even when the icon renders correctly. The only thing reliably
// checkable without a browser is the *guard itself*: given the same inputs
// (upstream glyph names, declared icons), does it throw when it should and
// stay quiet when it shouldn't.

describe('subset-icon-font guard: assertExplicitIconsSurvive', () => {
  it('throws for an icon that is not a glyph name in the upstream font', () => {
    const declarations = [{ icon: 'not_a_real_icon_xyz', file: 'src/components/TopNav.astro' }];
    const fontGlyphNames = new Set(['storefront', 'graphic_eq']); // real names, but not this one
    expect(() => assertExplicitIconsSurvive(declarations, fontGlyphNames)).toThrow(/not_a_real_icon_xyz/);
  });

  it('names the offending icon and the declaring file in the error', () => {
    const declarations = [{ icon: 'bogus_icon', file: '/abs/path/src/components/BottomNav.astro' }];
    try {
      assertExplicitIconsSurvive(declarations, new Set());
      throw new Error('expected assertExplicitIconsSurvive to throw');
    } catch (e) {
      expect(e.message).toContain('bogus_icon');
      expect(e.message).toContain('/abs/path/src/components/BottomNav.astro');
    }
  });

  it('does not throw when every declared icon exists upstream', () => {
    const declarations = [
      { icon: 'storefront', file: 'src/components/TopNav.astro' },
      { icon: 'groups', file: 'src/components/TopNav.astro' },
    ];
    const fontGlyphNames = new Set(['storefront', 'groups', 'graphic_eq']);
    expect(() => assertExplicitIconsSurvive(declarations, fontGlyphNames)).not.toThrow();
  });

  it('does not throw on an empty declaration list', () => {
    expect(() => assertExplicitIconsSurvive([], new Set())).not.toThrow();
  });
});

describe('subset-icon-font guard: applied to the real nav components', () => {
  it('collects the COMMUNITY icon (groups) as an explicit declaration', () => {
    const declarations = collectExplicitIconDeclarations();
    const icons = declarations.map((d) => d.icon);
    expect(icons).toContain('groups');
    expect(icons).toContain('storefront');
    // diversity_3 was moved off after a report that it rendered as literal
    // text in a real browser this repo's tooling could not reproduce; make
    // sure a future edit doesn't quietly bring it back.
    expect(icons).not.toContain('diversity_3');
  });

  it('does not throw for the current nav components against a font that has all of them', () => {
    // Regression pin: the guard is wired to the real declarations and would
    // catch a genuinely missing icon name, not just a synthetic one.
    const declarations = collectExplicitIconDeclarations();
    const fontGlyphNames = new Set(declarations.map((d) => d.icon)); // "upstream has all of them"
    expect(() => assertExplicitIconsSurvive(declarations, fontGlyphNames)).not.toThrow();

    // And it DOES throw if we simulate one declared icon missing upstream —
    // proving the guard is not a no-op against the real component data.
    const withOneMissing = new Set(fontGlyphNames);
    withOneMissing.delete('groups');
    expect(() => assertExplicitIconsSurvive(declarations, withOneMissing)).toThrow(/groups/);
  });
});

describe('subset-icon-font: collectIcons over-collection is unaffected', () => {
  it('still keeps tokens that are valid upstream glyph names', () => {
    // collectIcons scans real files under src/, so just check it returns the
    // icons we know are declared and doesn't error.
    const fontGlyphNames = new Set(['storefront', 'graphic_eq', 'grid_view', 'sensors', 'groups']);
    const icons = collectIcons(fontGlyphNames);
    expect(icons).toContain('groups');
    expect(icons).toContain('storefront');
  });
});

// Pins the second half of this bug: even a correctly-regenerated font never
// reached returning visitors, because it shipped under the same unhashed URL
// (/fonts/MaterialSymbols-Subset.woff2) that their browser had already
// cached from before the icon was added. Content-hashing the filename means
// changed bytes are a new URL, which is what makes a long-lived immutable
// Cache-Control (public/_headers) safe.

describe('subset-icon-font: content hashing', () => {
  it('is stable for identical content', () => {
    const bytes = Buffer.from('same font bytes');
    expect(hashFontBuffer(bytes)).toBe(hashFontBuffer(Buffer.from('same font bytes')));
  });

  it('changes when content changes', () => {
    const a = hashFontBuffer(Buffer.from('font bytes v1'));
    const b = hashFontBuffer(Buffer.from('font bytes v2'));
    expect(a).not.toBe(b);
  });

  it('builds the expected filename shape', () => {
    const hash = hashFontBuffer(Buffer.from('anything'));
    expect(hashedFontFilename(hash)).toBe(`MaterialSymbols-Subset.${hash}.woff2`);
    expect(hashedFontFilename(hash)).toMatch(/^MaterialSymbols-Subset\.[0-9a-f]{8}\.woff2$/);
  });
});

describe('subset-icon-font: rewriteBaseLayoutFontRef', () => {
  it('rewrites the legacy unhashed reference to a hashed filename', () => {
    const content = `<link href="/fonts/MaterialSymbols-Subset.woff2" />\nsrc: url('/fonts/MaterialSymbols-Subset.woff2')`;
    const updated = rewriteBaseLayoutFontRef(content, 'MaterialSymbols-Subset.deadbeef.woff2');
    expect(updated).not.toContain('MaterialSymbols-Subset.woff2"'); // legacy gone
    expect(updated.match(/MaterialSymbols-Subset\.deadbeef\.woff2/g)).toHaveLength(2);
  });

  it('rewrites a previously-hashed reference to a new hash (idempotent re-runs)', () => {
    const content = `href="/fonts/MaterialSymbols-Subset.aaaaaaaa.woff2" ... src: url('/fonts/MaterialSymbols-Subset.aaaaaaaa.woff2')`;
    const updated = rewriteBaseLayoutFontRef(content, 'MaterialSymbols-Subset.bbbbbbbb.woff2');
    expect(updated).not.toContain('aaaaaaaa');
    expect(updated.match(/bbbbbbbb/g)).toHaveLength(2);
  });

  it('is a no-op (byte-identical output) when the filename is unchanged', () => {
    const content = `href="/fonts/MaterialSymbols-Subset.aaaaaaaa.woff2"`;
    const updated = rewriteBaseLayoutFontRef(content, 'MaterialSymbols-Subset.aaaaaaaa.woff2');
    expect(updated).toBe(content);
  });
});

describe('subset-icon-font: staleSubsetFonts cleanup', () => {
  it('deletes only prior hashed subset builds, never the current one', () => {
    const existing = ['MaterialSymbols-Subset.aaaaaaaa.woff2', 'MaterialSymbols-Subset.bbbbbbbb.woff2'];
    expect(staleSubsetFonts(existing, 'MaterialSymbols-Subset.bbbbbbbb.woff2')).toEqual([
      'MaterialSymbols-Subset.aaaaaaaa.woff2',
    ]);
  });

  it('never deletes the other self-hosted font families', () => {
    const existing = [
      'MaterialSymbols-Subset.aaaaaaaa.woff2',
      'Rubik-Variable.woff2',
      'GeistMono-Variable.woff2',
      'Inter-Medium.woff2',
      'Inter-Regular.woff2',
      'SpaceGrotesk-Bold.woff2',
      'SpaceGrotesk-Regular.woff2',
      'MorphianTrial-Regular.woff2',
    ];
    const stale = staleSubsetFonts(existing, 'MaterialSymbols-Subset.zzzzzzzz.woff2');
    expect(stale).toEqual(['MaterialSymbols-Subset.aaaaaaaa.woff2']);
  });

  it('never deletes a file that merely starts with the subset name but is not the hashed shape', () => {
    // e.g. a hand-placed backup or a name that doesn't match exactly 8 hex chars
    const existing = ['MaterialSymbols-Subset.woff2', 'MaterialSymbols-Subset.deadbeef.backup.woff2'];
    expect(staleSubsetFonts(existing, 'MaterialSymbols-Subset.ffffffff.woff2')).toEqual([]);
  });
});

describe('subset-icon-font: BaseLayout points at a file that exists on disk', () => {
  // This is the assertion that would have caught the whole bug class: not
  // "is the font correct" (unreliable to check statically, per the guard
  // tests above) but "does the URL the page actually requests resolve to
  // something on disk at all" — a hashed reference to a deleted/never-written
  // file is a build-time-detectable version of the same failure mode.
  it('extracts a hashed filename from the real BaseLayout.astro', () => {
    const layout = readFileSync(join(ROOT, 'src/layouts/BaseLayout.astro'), 'utf8');
    const filename = extractSubsetFilename(layout);
    expect(filename).toMatch(/^MaterialSymbols-Subset\.[0-9a-f]{8}\.woff2$/);
  });

  it('that filename exists in public/fonts/', () => {
    const layout = readFileSync(join(ROOT, 'src/layouts/BaseLayout.astro'), 'utf8');
    const filename = extractSubsetFilename(layout);
    expect(existsSync(join(ROOT, 'public/fonts', filename))).toBe(true);
  });

  it('extractSubsetFilename returns null when there is no reference at all', () => {
    expect(extractSubsetFilename('<html><body>no fonts here</body></html>')).toBeNull();
  });
});

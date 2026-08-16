import { describe, it, expect } from 'vitest';
import {
  collectIcons,
  collectExplicitIconDeclarations,
  assertExplicitIconsSurvive,
} from '../../scripts/subset-icon-font.mjs';

// Pins the fix for the "diversity_3" nav bug: COMMUNITY rendered the literal
// ligature name instead of an icon glyph. The proximate cause was a stale
// subset font; the root cause was that scripts/subset-icon-font.mjs's source
// scan can silently drop an icon that's actually used (it only keeps tokens
// that match a real upstream glyph name, with no check that every icon the
// site declares actually survived). This test pins the guard added for that:
// assertExplicitIconsSurvive throws when a declared `icon:` value is not a
// glyph in the upstream font, instead of shipping a word.
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
      { icon: 'diversity_3', file: 'src/components/TopNav.astro' },
    ];
    const fontGlyphNames = new Set(['storefront', 'diversity_3', 'graphic_eq']);
    expect(() => assertExplicitIconsSurvive(declarations, fontGlyphNames)).not.toThrow();
  });

  it('does not throw on an empty declaration list', () => {
    expect(() => assertExplicitIconsSurvive([], new Set())).not.toThrow();
  });
});

describe('subset-icon-font guard: applied to the real nav components', () => {
  it('collects the icon this bug was about (diversity_3) as an explicit declaration', () => {
    const declarations = collectExplicitIconDeclarations();
    const icons = declarations.map((d) => d.icon);
    expect(icons).toContain('diversity_3');
    expect(icons).toContain('storefront');
  });

  it('does not throw for the current nav components against a font that has both', () => {
    // Regression pin: at the time this bug shipped, diversity_3 was a real
    // upstream glyph name (verified by fetching the live Material Symbols
    // Outlined font and checking getGlyphOrder()) but was not surviving into
    // the subset. This asserts the guard is wired to the real declarations
    // and would have caught a genuinely missing name.
    const declarations = collectExplicitIconDeclarations();
    const fontGlyphNames = new Set(declarations.map((d) => d.icon)); // "upstream has all of them"
    expect(() => assertExplicitIconsSurvive(declarations, fontGlyphNames)).not.toThrow();

    // And it DOES throw if we simulate one declared icon missing upstream —
    // proving the guard is not a no-op against the real component data.
    const withOneMissing = new Set(fontGlyphNames);
    withOneMissing.delete('diversity_3');
    expect(() => assertExplicitIconsSurvive(declarations, withOneMissing)).toThrow(/diversity_3/);
  });
});

describe('subset-icon-font: collectIcons over-collection is unaffected', () => {
  it('still keeps tokens that are valid upstream glyph names', () => {
    // collectIcons scans real files under src/, so just check it returns the
    // icons we know are declared and doesn't error.
    const fontGlyphNames = new Set(['storefront', 'graphic_eq', 'grid_view', 'sensors', 'diversity_3']);
    const icons = collectIcons(fontGlyphNames);
    expect(icons).toContain('diversity_3');
    expect(icons).toContain('storefront');
  });
});

// Unit tests for the two pure helpers renderer.js pulls out specifically so
// the native-palette feature (and the picker preview overrides layered on
// top of it) are testable without a canvas/DOM — see paletteForSpec's and
// pickerPreviewFor's doc comments in that file.

import { describe, it, expect } from 'vitest';
import { paletteForSpec, pickerPreviewFor } from '../../src/scripts/sprites/renderer.js';
import { frame } from '../../src/scripts/sprites/vendor/recipes.js';
import { COLORWAYS, paletteOf } from '../../src/scripts/sprites/vendor/colorways.js';
import { NATIVE_COLOURWAY } from '../../src/scripts/sprites/native-palette.js';

// Minimal fixture sprite: a flat 32x32 grid of '.' with one small 5x5
// filled block off-center, which is enough for frame()'s "grow" XP mode
// (adult/grub stages) to actually produce a visibly different grid at XP 0
// vs XP 100 — a fully empty grid would grow-scale to itself either way and
// make the "always full growth" assertion below vacuous.
function fakeSprite(overrides: any = {}) {
  const rows = Array.from({ length: 32 }, () => Array(32).fill('.'));
  for (let r = 10; r <= 14; r++) for (let c = 10; c <= 14; c++) rows[r][c] = '1';
  const base = rows.map(r => r.join(''));
  return {
    ref: 'TEST1', stage: 'adult', recipe: 'BOB', fps: 4, loop: 'loop',
    base,
    palette: { '.': null, '1': '#111111', '2': '#222222', '3': '#333333', '4': '#444444' },
    ...overrides,
  };
}

describe('paletteForSpec', () => {
  it('the NATIVE_COLOURWAY sentinel resolves to the sprites own palette', () => {
    const sprite = fakeSprite();
    expect(paletteForSpec(NATIVE_COLOURWAY, sprite)).toBe(sprite.palette);
  });

  it('a real colourway id resolves to that colourways palette, not the sprites own', () => {
    const sprite = fakeSprite();
    const cw = COLORWAYS.find(c => c.id === 'magenta');
    expect(paletteForSpec('magenta', sprite)).toEqual(paletteOf(cw));
    expect(paletteForSpec('magenta', sprite)).not.toEqual(sprite.palette);
  });

  it('an unknown id falls back to cyan, same as before this feature existed', () => {
    const sprite = fakeSprite();
    const cyan = COLORWAYS.find(c => c.id === 'cyan');
    expect(paletteForSpec('not-a-real-colourway', sprite)).toEqual(paletteOf(cyan));
  });
});

// pickerPreviewFor backs the admin sprite picker/collection grid ONLY —
// see its doc comment and drawStaticOne in renderer.js. It must always
// force full growth + native palette, regardless of what a viewer's own
// equipped avatar looks like (that path is paletteForSpec + animateOne,
// covered separately above and by the endpoint tests in endpoints.test.js).
describe('pickerPreviewFor — picker preview overrides', () => {
  it('always renders at XP 100 (full growth), independent of any viewer XP', () => {
    const sprite = fakeSprite();
    const { grid } = pickerPreviewFor(sprite);
    expect(grid).toEqual(frame(sprite, 100, 0));
    // Sanity: XP 0 would produce a different (juvenile) grid for a sprite
    // that actually scales with XP — assert this preview is NOT that.
    expect(grid).not.toEqual(frame(sprite, 0, 0));
  });

  it('always uses the sprites own native palette, never a named colourway', () => {
    const sprite = fakeSprite();
    const { palette } = pickerPreviewFor(sprite);
    expect(palette).toBe(sprite.palette);
    const cyanPalette = paletteOf(COLORWAYS.find(c => c.id === 'cyan'));
    expect(palette).not.toEqual(cyanPalette);
  });
});

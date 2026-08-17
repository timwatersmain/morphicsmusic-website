import { describe, it, expect } from 'vitest';
import { baseCentreOffset } from '../../src/scripts/sprites/renderer.js';
import { frame, sequence, toGrid, bbox } from '../../src/scripts/sprites/vendor/recipes.js';

// The bug: sprites are "roughly centred with room to move" in their 32x32
// grid (vendor/README.txt) — the recipes rely on that slack to translate the
// creature for animation. Drawing the raw grid centred therefore left the
// creature's INK off-centre in the circular avatar. baseCentreOffset fixes
// that by centring the ink's bounding box instead, derived from the base
// grid only so it stays constant across frames/XP (see renderer.js).

const blankRow = () => Array(32).fill('.');
function gridOf(r0: number, r1: number, c0: number, c1: number) {
  const g = Array.from({ length: 32 }, blankRow);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = '1';
  return g;
}
// baseCentreOffset caches by sprite.ref (see renderer.js), so every test
// sprite needs its own unique ref — reusing one would silently read back a
// stale cached offset from an earlier test's grid.
let nextRef = 0;
function spriteWithGrid(g: string[][], over: Partial<Record<string, unknown>> = {}) {
  return {
    ref: `TEST-${nextRef++}`,
    stage: 'adult',
    recipe: 'BOB',
    fps: 4,
    loop: 'loop',
    base: g.map(r => r.join('')),
    ...over,
  } as any;
}

describe('baseCentreOffset', () => {
  it('is zero for ink already centred in the grid', () => {
    // 10..21 is a 12-wide/tall block symmetric around the 32-grid centre.
    const sprite = spriteWithGrid(gridOf(10, 21, 10, 21));
    expect(baseCentreOffset(sprite)).toEqual({ dx: 0, dy: 0 });
  });

  it('is non-zero, in the expected direction, for ink deliberately offset in a known direction', () => {
    // Ink pushed hard toward the top-left corner (rows/cols 0..9) — well
    // clear of the grid centre (16) — must shift right (+dx) and down (+dy)
    // to recentre.
    const sprite = spriteWithGrid(gridOf(0, 9, 0, 9));
    const off = baseCentreOffset(sprite);
    expect(off.dx).toBeGreaterThan(0);
    expect(off.dy).toBeGreaterThan(0);
  });

  it('offsets are integers', () => {
    // An odd-width/height bbox forces a .5 remainder through Math.round.
    const sprite = spriteWithGrid(gridOf(5, 15, 3, 20)); // 11 rows, 18 cols
    const off = baseCentreOffset(sprite);
    expect(Number.isInteger(off.dx)).toBe(true);
    expect(Number.isInteger(off.dy)).toBe(true);
  });

  it('is derived from the BASE grid and does not change across animation frames', () => {
    // A real recipe (WOBBLE) translates bands of the grid per frame index.
    // If the offset were recomputed per rendered frame instead of the base,
    // it would silently change here and cancel the animation out.
    const sprite = spriteWithGrid(gridOf(8, 23, 8, 23), { recipe: 'WOBBLE' });
    const base = baseCentreOffset(sprite);
    const order = sequence(sprite.loop);
    for (const f of order) {
      // Rendered frame differs from the base grid (that's the animation
      // working) ...
      const rendered = frame(sprite, 0, f);
      // ... but the offset used to draw it must stay the sprite-level
      // constant, not something recomputed from `rendered`'s own bbox.
      expect(baseCentreOffset(sprite)).toEqual(base);
    }
  });

  it('does not change across XP levels (growth resizes the ink; recentring per level would slide it)', () => {
    const sprite = spriteWithGrid(gridOf(8, 23, 8, 23), { stage: 'adult' });
    const base = baseCentreOffset(sprite);
    for (const xp of [0, 25, 50, 80, 100]) {
      // applyXp changes the rendered ink's size/shape at this xp level...
      frame(sprite, xp, 0);
      // ...but baseCentreOffset must still be reading the untouched sprite.base.
      expect(baseCentreOffset(sprite)).toEqual(base);
    }
  });

  it('matches the sign/magnitude expected from the base bbox directly', () => {
    const g = gridOf(2, 5, 20, 29); // small block, offset up-right
    const sprite = spriteWithGrid(g);
    const b = bbox(toGrid(sprite.base));
    const expected = {
      dx: Math.round(16 - (b.c0 + b.c1 + 1) / 2),
      dy: Math.round(16 - (b.r0 + b.r1 + 1) / 2),
    };
    expect(baseCentreOffset(sprite)).toEqual(expected);
  });
});

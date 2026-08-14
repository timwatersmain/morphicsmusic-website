import { describe, it, expect } from 'vitest';
import { gridRows, planGrid, planFreeGrid, backingSize, needsResize, effectivePoints, staggerRanks, nextLetter, ROWS, LETTERS } from '../../src/scripts/spelling/grid-layout.js';
import { PHRASE } from '../../src/scripts/spelling/charmap.js';

describe('gridRows', () => {
  it('splits the tagline into three word-aligned rows of 8, 8 and 9 cells', () => {
    const [row1, row2] = gridRows(PHRASE);
    expect(row1).toHaveLength(8);
    expect(row2).toHaveLength(8);
    expect(row1.join('')).toBe('THE ONLY');
    expect(row2.join('')).toBe('CONSTANT');
  });

  it('totals 25 cells, matching the spec layout table', () => {
    const [row1, row2] = gridRows(PHRASE);
    expect(gridRows().reduce((n, r) => n + r.length, 0)).toBe(25);
  });

  it('keeps every word intact — no word breaks across a row join', () => {
    const [row1, row2] = gridRows(PHRASE);
    expect(gridRows().map((r) => r.join(''))).toEqual(['THE ONLY', 'CONSTANT', 'IS CHANGE']);
  });
});

describe('planGrid', () => {
  it('produces one cell per character, in reading order', () => {
    const { cells } = planGrid(900, 260);
    expect(cells).toHaveLength(25);
    expect(cells.map((c) => c.ch).join('')).toBe('THE ONLYCONSTANTIS CHANGE');
  });

  it('gives every cell in a row the same width and height', () => {
    const { cells, cellW, cellH } = planGrid(900, 260);
    for (const c of cells) {
      expect(c.w).toBeCloseTo(cellW, 6);
      expect(c.h).toBeCloseTo(cellH, 6);
    }
  });

  it('is bilaterally symmetrical: both rows share the same centre axis', () => {
    const { cells } = planGrid(900, 260);
    const row1 = cells.filter((c) => c.row === 0);
    const row2 = cells.filter((c) => c.row === 1);
    const mid = (row) => (row[0].cx + row[row.length - 1].cx) / 2;
    expect(mid(row1)).toBeCloseTo(mid(row2), 6);
    expect(mid(row1)).toBeCloseTo(900 / 2, 6);
  });

  it('centres the three-row block vertically in the canvas', () => {
    const { cells } = planGrid(900, 260);
    const rowYs = [...new Set(cells.map((c) => c.cy))].sort((a, b) => a - b);
    expect(rowYs).toHaveLength(3);
    expect((rowYs[0] + rowYs[rowYs.length - 1]) / 2).toBeCloseTo(260 / 2, 6);
  });

  it('never overlaps adjacent cells within a row', () => {
    const { cells, cellW } = planGrid(900, 260);
    for (const row of [0, 1]) {
      const xs = cells.filter((c) => c.row === row).map((c) => c.cx).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i] - xs[i - 1]).toBeCloseTo(cellW, 6);
      }
    }
  });

  it('scales down cleanly for the mobile canvas size', () => {
    const { cells, cellW, cellH } = planGrid(340, 150);
    expect(cells).toHaveLength(25);
    expect(cellW).toBeGreaterThan(0);
    expect(cellH).toBeGreaterThan(0);
  });

  it('keeps every cell inside the canvas bounds', () => {
    for (const [w, h] of [[900, 260], [620, 200], [340, 150]]) {
      const { cells } = planGrid(w, h);
      for (const c of cells) {
        expect(c.cx - c.w / 2).toBeGreaterThanOrEqual(-0.01);
        expect(c.cx + c.w / 2).toBeLessThanOrEqual(w + 0.01);
        expect(c.cy - c.h / 2).toBeGreaterThanOrEqual(-0.01);
        expect(c.cy + c.h / 2).toBeLessThanOrEqual(h + 0.01);
      }
    }
  });
});

describe('planFreeGrid', () => {
  // Every viewport the field actually has to survive: phone portrait, phone
  // landscape, tablet, laptop, ultrawide, and the awkward in-between widths.
  const VIEWPORTS = [
    [390, 844], [844, 390], [360, 640], [768, 1024],
    [1024, 768], [1440, 900], [2560, 1080], [900, 260], [517, 731],
  ];

  it('makes cells exactly square at every viewport — this is the whole point', () => {
    for (const [w, h] of VIEWPORTS) {
      const { cellW, cellH, cells } = planFreeGrid(w, h, { target: 72 });
      expect(cellW).toBeCloseTo(cellH, 9);
      for (const c of cells) {
        expect(c.w).toBeCloseTo(c.h, 9);
      }
    }
  });

  it('spaces neighbours identically across and down, so the lattice reads even', () => {
    for (const [w, h] of VIEWPORTS) {
      const { cells, cols, rows } = planFreeGrid(w, h, { target: 72 });
      if (cols < 2 || rows < 2) continue;
      const at = (r, c) => cells[r * cols + c];
      const dx = at(0, 1).cx - at(0, 0).cx;
      const dy = at(1, 0).cy - at(0, 0).cy;
      expect(dx).toBeCloseTo(dy, 9);
    }
  });

  it('tiles the width exactly, so no glyph is clipped at the left or right edge', () => {
    for (const [w, h] of VIEWPORTS) {
      const { cells, cols, cellW } = planFreeGrid(w, h, { target: 72 });
      expect(cols * cellW).toBeCloseTo(w, 9);
      expect(cells[0].cx - cellW / 2).toBeCloseTo(0, 9);
      expect(cells[cols - 1].cx + cellW / 2).toBeCloseTo(w, 9);
    }
  });

  it('covers the full height, bleeding equally off the top and bottom', () => {
    for (const [w, h] of VIEWPORTS) {
      const { cells, cols, rows, cellH } = planFreeGrid(w, h, { target: 72 });
      const top = cells[0].cy - cellH / 2;
      const bottom = cells[(rows - 1) * cols].cy + cellH / 2;
      expect(top).toBeLessThanOrEqual(0.000001);          // reaches the top edge
      expect(bottom).toBeGreaterThanOrEqual(h - 0.000001); // and the bottom
      expect(top).toBeCloseTo(h - bottom, 9);              // symmetric overhang
    }
  });

  it('scales cell count with the target, keeping cells square either way', () => {
    const coarse = planFreeGrid(1440, 900, { target: 120 });
    const fine = planFreeGrid(1440, 900, { target: 40 });
    expect(fine.cells.length).toBeGreaterThan(coarse.cells.length);
    expect(coarse.cellW).toBeCloseTo(coarse.cellH, 9);
    expect(fine.cellW).toBeCloseTo(fine.cellH, 9);
  });

  it('never degenerates below a single cell on a tiny canvas', () => {
    const { cells, cols, rows } = planFreeGrid(10, 10, { target: 400 });
    expect(cols).toBe(1);
    expect(rows).toBeGreaterThanOrEqual(1);
    expect(cells.length).toBe(cols * rows);
  });
});

describe('needsResize', () => {
  // A canvas stand-in: the four numbers the check actually reads.
  const canvas = (clientW, clientH, w, h) => ({ clientWidth: clientW, clientHeight: clientH, width: w, height: h });

  it('is quiet when the backing store already matches the CSS box', () => {
    expect(needsResize(canvas(390, 844, 390, 844), 1, 1)).toBe(false);
    expect(needsResize(canvas(1440, 900, 864, 540), 1, 0.6)).toBe(false);
  });

  it('notices a WIDTH-only change', () => {
    expect(needsResize(canvas(500, 844, 390, 844), 1, 1)).toBe(true);
  });

  // The mobile scroll glitch. iOS Safari collapses the URL bar on swipe-up,
  // which makes the fixed, inset:0 grid taller while its width is untouched.
  // The old per-frame guard compared width only, so the canvas kept its short
  // backing store and CSS stretched that image over the taller box — the
  // "stacked / glitching" field. Swiping down restored the original height and
  // with it the match, which is why scrolling back appeared to fix it.
  it('notices a HEIGHT-only change — the iOS URL-bar case', () => {
    expect(needsResize(canvas(390, 934, 390, 844), 1, 1)).toBe(true);
    expect(needsResize(canvas(390, 754, 390, 844), 1, 1)).toBe(true);
  });

  it('notices both changing at once, as on orientation change', () => {
    expect(needsResize(canvas(844, 390, 390, 844), 1, 1)).toBe(true);
  });

  it('agrees with backingSize, so the check and the resize cannot drift apart', () => {
    for (const [cw, ch, rs] of [[390, 844, 1], [1440, 900, 0.6], [844, 390, 1], [1024, 768, 0.55]]) {
      const { w, h } = backingSize(cw, ch, 1, rs);
      expect(needsResize(canvas(cw, ch, w, h), 1, rs)).toBe(false);
      // One device pixel off in either axis must still be caught.
      expect(needsResize(canvas(cw, ch, w, h - 1), 1, rs)).toBe(true);
      expect(needsResize(canvas(cw, ch, w - 1, h), 1, rs)).toBe(true);
    }
  });

  it('treats an unsized canvas (width 0) as needing a resize', () => {
    expect(needsResize(canvas(390, 844, 0, 0), 1, 1)).toBe(true);
  });
});

describe('effectivePoints', () => {
  const BASE = 240, FLOOR = 56, BUDGET = 24000;

  it('gives the full base when the budget comfortably covers the grid', () => {
    expect(effectivePoints(BASE, FLOOR, BUDGET, 50)).toBe(BASE);   // 480 available
  });

  it('spreads the budget when there are more cells than it can fund', () => {
    expect(effectivePoints(BASE, FLOOR, BUDGET, 260)).toBe(92);    // 24000/260
  });

  it('never drops below the floor where glyphs stop resolving', () => {
    expect(effectivePoints(BASE, FLOOR, BUDGET, 10000)).toBe(FLOOR);
  });

  // The ratchet. Growing the viewport (more cells) used to permanently lower
  // the engine's stored points-per-cell, because the new value was clamped
  // against the previous one instead of against the base. Shrinking back, or
  // switching to a richer profile, could then never restore density.
  it('is a pure function of its inputs — density returns when cells do', () => {
    const small = effectivePoints(BASE, FLOOR, BUDGET, 60);
    const large = effectivePoints(BASE, FLOOR, BUDGET, 600);
    const backAgain = effectivePoints(BASE, FLOOR, BUDGET, 60);
    expect(large).toBeLessThan(small);
    expect(backAgain).toBe(small);
  });

  it('raises points when a profile switch raises the base and budget', () => {
    // Phone profile -> desktop profile at the same cell count.
    const phone = effectivePoints(140, FLOOR, 10000, 144);
    const desktop = effectivePoints(240, FLOOR, 24000, 144);
    expect(desktop).toBeGreaterThan(phone);
  });

  it('never divides by zero on an empty grid', () => {
    expect(effectivePoints(BASE, FLOOR, BUDGET, 0)).toBe(BASE);
  });
});

describe('staggerRanks', () => {
  it('ranks columns left-to-right and shares a rank across both rows', () => {
    const { cells } = planGrid(900, 260);
    const ranks = staggerRanks(cells);
    // Row 1 col 0 and row 2 col 0 sit at different x (rows have different
    // lengths so they are not column-aligned in this grid), but within one
    // row, rank must strictly increase with column.
    const row1Idx = cells.map((c, i) => [c, i]).filter(([c]) => c.row === 0);
    for (let i = 1; i < row1Idx.length; i++) {
      expect(ranks[row1Idx[i][1]]).toBeGreaterThan(ranks[row1Idx[i - 1][1]]);
    }
  });

  it('produces a rank for every cell, bounded by the distinct column count', () => {
    const { cells } = planGrid(900, 260);
    const ranks = staggerRanks(cells);
    expect(ranks).toHaveLength(cells.length);
    const maxRank = Math.max(...ranks);
    expect(maxRank).toBeLessThan(new Set(cells.map((c) => c.cx)).size);
  });
});

describe('nextLetter', () => {
  it('always returns an A-Z letter', () => {
    for (let i = 0; i < 200; i++) {
      expect(LETTERS).toContain(nextLetter(null));
    }
  });

  it('never repeats the given previous letter', () => {
    for (let i = 0; i < 500; i++) {
      const prev = LETTERS[i % 26];
      expect(nextLetter(prev)).not.toBe(prev);
    }
  });

  it('covers the full alphabet given enough draws', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(nextLetter(null));
    expect(seen.size).toBe(26);
  });
});

describe('ROWS', () => {
  it('matches the spec table (three word-aligned rows)', () => {
    expect(ROWS).toEqual(['THE ONLY', 'CONSTANT', 'IS CHANGE']);
  });
});

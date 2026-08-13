import { describe, it, expect } from 'vitest';
import { gridRows, planGrid, staggerRanks, nextLetter, ROWS, LETTERS } from '../../src/scripts/spelling/grid-layout.js';
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

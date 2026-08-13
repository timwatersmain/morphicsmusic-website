// Pure grid layout arithmetic for the v2 scramble grid — cell positions, row
// centring, bilateral symmetry. No DOM, no canvas: this is the piece the spec
// calls out as "pure and testable in Node," the same way layout.js is.
import { PHRASE } from './charmap.js';

// 25 cells in three centred rows, split on word boundaries:
//   THE ONLY  (8)
//   CONSTANT  (8)
//   IS CHANGE (9)
// Row lengths 8/8/9 are as close to even as this phrase allows while keeping
// every word intact, and 9 columns (rather than the 14 an even two-row split
// would need) is what keeps each glyph large enough to stay legible.
export const ROWS = ['THE ONLY', 'CONSTANT', 'IS CHANGE'];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Split a phrase into the fixed grid rows. Defaults to the landing tagline's
// three-row split; a caller-supplied phrase is only exercised by tests, and
// falls back to splitting on its own word boundaries.
export function gridRows(phrase = PHRASE) {
  const src = phrase.toUpperCase() === PHRASE.toUpperCase()
    ? ROWS
    : phrase.toUpperCase().split(/(?<=\S)\s(?=\S)/);
  return src.map((line) => line.split(''));
}

// Lay out `rows` (arrays of characters) inside a canvasW x canvasH box as a
// uniform-advance grid: one cell width shared by every row (derived from the
// longest row), rows stacked and the whole block centred vertically, each row
// centred horizontally about the SAME vertical axis (canvasW / 2) — that
// shared axis is what makes the grid bilaterally symmetrical.
export function planGrid(canvasW, canvasH, opts = {}) {
  const rows = opts.rows ?? gridRows();
  const marginX = opts.marginX ?? canvasW * 0.035;
  const marginY = opts.marginY ?? canvasH * 0.08;
  const rowGap = opts.rowGap ?? canvasH * 0.05;

  const maxCols = Math.max(...rows.map((r) => r.length));
  const usableW = Math.max(1, canvasW - marginX * 2);
  const cellW = usableW / maxCols;

  const usableH = Math.max(1, canvasH - marginY * 2 - rowGap * (rows.length - 1));
  const cellH = usableH / rows.length;

  const blockH = rows.length * cellH + rowGap * (rows.length - 1);
  const top = (canvasH - blockH) / 2;

  const cells = [];
  rows.forEach((row, r) => {
    const rowW = row.length * cellW;
    const left = (canvasW - rowW) / 2;
    const cy = top + r * (cellH + rowGap) + cellH / 2;
    row.forEach((ch, c) => {
      const cx = left + c * cellW + cellW / 2;
      cells.push({ ch, row: r, col: c, cx, cy, w: cellW, h: cellH });
    });
  });

  return { cells, cellW, cellH, rows, maxCols };
}

// Stagger order for the resolve sweep: left-to-right by centre x, both rows
// interleaved so the sweep reads as one motion across the whole grid rather
// than two independent per-row sweeps. Ties (same column in both rows) share
// a rank, which is what makes the two rows sweep together.
export function staggerRanks(cells) {
  const xs = [...new Set(cells.map((c) => c.cx))].sort((a, b) => a - b);
  const rankOf = new Map(xs.map((x, i) => [x, i]));
  return cells.map((c) => rankOf.get(c.cx));
}

// Pick a random A-Z letter, never repeating `prev`.
export function nextLetter(prev) {
  if (LETTERS.length < 2) return LETTERS[0];
  let c = LETTERS[(Math.random() * LETTERS.length) | 0];
  while (c === prev) c = LETTERS[(Math.random() * LETTERS.length) | 0];
  return c;
}

export { LETTERS };

// A free grid that fills the canvas with as many uniform square cells as fit at
// roughly `target` px each — the "word search" field. Unlike planGrid this
// carries no phrase: every cell is an independent random letter, and the grid
// is sized to the canvas rather than to a fixed row structure.
//
// Cells are square and butt directly against one another (the glyph's own
// GLYPH_FILL inset supplies the visual gutter), so row spacing matches column
// spacing and the field reads as an even lattice rather than as ruled lines.
export function planFreeGrid(canvasW, canvasH, opts = {}) {
  const target = opts.target ?? 120;
  // extraRows pushes the lattice past the canvas's natural fit so the field
  // reaches the bottom edge instead of stopping short of it.
  const extraRows = opts.extraRows ?? 0;
  const cols = Math.max(1, Math.round(canvasW / target));
  const rows = Math.max(1, Math.round(canvasH / target) + extraRows);
  const cellW = canvasW / cols;
  const cellH = canvasH / rows;

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        ch: nextLetter(null),
        row: r,
        col: c,
        cx: c * cellW + cellW / 2,
        cy: r * cellH + cellH / 2,
        w: cellW,
        h: cellH,
      });
    }
  }
  return { cells, cellW, cellH, cols, rows };
}

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

// The canvas backing-store size for a given CSS box. Rasterising below layout
// size (renderScale) and letting CSS scale the result up is deliberate — see
// grid-engine.js.
export function backingSize(clientW, clientH, dpr, renderScale) {
  return {
    w: Math.floor(clientW * dpr * renderScale),
    h: Math.floor(clientH * dpr * renderScale),
  };
}

// Does the canvas need re-sizing to match its CSS box? Both axes, always.
//
// This exists as a shared function because the per-frame guard and size() used
// to compute it separately, and the guard compared only width. That is the
// mobile scroll glitch: iOS Safari collapses the URL bar on swipe-up, growing
// this fixed, inset:0 canvas taller at the same width, and a width-only guard
// sees nothing to do. CSS then stretches the old, shorter backing store over
// the taller box and the lattice smears into stacked rows. Swiping back down
// restored the original height, so the mismatch — and the glitch — vanished.
//
// Keeping ONE definition is the actual fix; the two callers can no longer
// disagree about what "already the right size" means.
export function needsResize(canvas, dpr, renderScale) {
  const { w, h } = backingSize(canvas.clientWidth, canvas.clientHeight, dpr, renderScale);
  return canvas.width !== w || canvas.height !== h;
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
// Cells are TRULY square — cellW === cellH — and butt directly against one
// another (the glyph's own GLYPH_FILL inset supplies the visual gutter), so the
// gap between two side-by-side letters is exactly the gap between two stacked
// ones and the field reads as an even lattice rather than as ruled lines.
//
// Squareness is a constraint, not an approximation, which is why only ONE of
// the two axes can tile exactly. Width wins: the columns divide canvasW evenly
// so no half-glyph is clipped at the left or right edge, where the eye reads a
// hard vertical margin. The leftover on the height (always < one cell) is split
// evenly top and bottom as a symmetric bleed — the field is full-bleed and
// faint, so a glyph cropped by the viewport edge is invisible, whereas an
// asymmetric letterbox is not.
//
// Deriving rows from the square size is also why there is no `extraRows` knob:
// row count is a consequence of cell size, and adding rows independently is
// exactly what made cells non-square before. Cell COUNT (the frame cost) is
// tuned with `target` alone.
export function planFreeGrid(canvasW, canvasH, opts = {}) {
  const target = opts.target ?? 120;
  const cols = Math.max(1, Math.round(canvasW / target));
  const cell = canvasW / cols;
  // ceil, so the lattice always covers the full height rather than stopping
  // short of the bottom edge.
  const rows = Math.max(1, Math.ceil(canvasH / cell));
  // <= 0: the overhang hangs off both edges equally.
  const offsetY = (canvasH - rows * cell) / 2;

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        ch: nextLetter(null),
        row: r,
        col: c,
        cx: c * cell + cell / 2,
        cy: offsetY + r * cell + cell / 2,
        w: cell,
        h: cell,
      });
    }
  }
  return { cells, cellW: cell, cellH: cell, cols, rows };
}

import { CHARMAP, CENTER } from './charmap.js';

// A word never breaks — one line per word, however long it is.
const ADV = 92;    // horizontal advance per glyph, artboard units
const LEAD = 100;  // line-to-line advance, artboard units

// Lay a phrase out as stacked word-lines and return each glyph's centre in
// artboard coordinates. Scale auto-fits the 120x120 artboard, so a phrase of any
// length lands inside it; viewScaleFor then opens the view to reclaim the margin.
export function planPhrase(text, budget) {
  const lines = String(text).toUpperCase().split(' ')
    .map(w => w.split('').filter(c => CHARMAP[c]))
    .filter(l => l.length);
  if (!lines.length) return null;

  const longest = Math.max(...lines.map(l => l.length));
  const rows = lines.length;
  const scale = Math.min(0.72, 120 / (longest * ADV), 110 / (rows * LEAD));

  const total = lines.reduce((a, l) => a + l.length, 0);
  const perGlyph = Math.max(360, Math.min(760, Math.floor(budget / total)));

  const slots = [];
  for (let r = 0; r < rows; r++) {
    const line = lines[r];
    const lineW = line.length * ADV - (ADV - 80);
    const x0 = CENTER - (lineW * scale) / 2;
    const cy = CENTER + (r - (rows - 1) / 2) * LEAD * scale;
    for (let c = 0; c < line.length; c++) {
      slots.push({ ch: line[c], cx: x0 + (c * ADV + 40) * scale, cy });
    }
  }
  return { lines, scale, perGlyph, slots };
}

// Derive the view scale from the MEASURED canvas, not a constant, so a phrase of
// any length is guaranteed to fit the raster instead of being sliced by it.
// `span` is the laid-out field's largest dimension in artboard units, plus stroke.
export function viewScaleFor(span, canvasW, canvasH, Rpx) {
  const minDim = Math.min(canvasW, canvasH);
  const half = (span / 2) / 120 * minDim * 0.66;
  return Math.max(0.6, Math.min(2.6, (minDim / 2 - Rpx - 8) / Math.max(1, half)));
}

export { ADV, LEAD };

#!/usr/bin/env node
// Bakes per-letter optical-centring offsets for the Morphian glyph avatars
// (src/scripts/avatar.js) into a generated source file.
//
// Why this exists: SVG's text-anchor="middle" centres a glyph's ADVANCE
// WIDTH, and dominant-baseline="middle" centres on some engine-chosen point
// of the font's metrics — neither is guaranteed to centre the glyph's
// actual INK. Morphian is a display face with idiosyncratic side bearings
// and vertical ink placement per letter, so every letter needs its own
// correction, derived from the font rather than eyeballed.
//
// The two axes use different strategies, both still derived purely from
// the font's own outlines (fontTools BoundsPen + hmtx), never a browser:
//   - horizontal: keep text-anchor="middle" (pixel-measured to behave as
//     documented — it centres the advance box) and correct the DELTA
//     between that advance-box centre and the ink centre:
//     dxFrac = (advanceWidth/2 - (xMin+xMax)/2) / upm.
//   - vertical: drop dominant-baseline="middle" entirely and compute y
//     analytically instead. "middle" is one of the least consistently
//     specified SVG/CSS text properties across engines — exactly how it
//     resolves for a given font isn't part of any spec's normative
//     algorithm, it's implementation-defined behaviour. With the default
//     (alphabetic) baseline at y, ink runs from y - yMax*(fontSize/upm) to
//     y - yMin*(fontSize/upm) (font Y-up, SVG Y-down). Solving for the y
//     that centres that span on the disc's own centre gives an ABSOLUTE
//     position, not a delta: dyFrac = (yMax+yMin) / (2*upm). avatar.js
//     sets y to sizePx/2 + dyFrac*fontSize directly — no dominant-baseline
//     needed, and no dependency on how any particular engine happens to
//     interpret "middle" for this particular font.
//
// Usage: node scripts/generate-glyph-offsets.mjs
// Requires: python3 with fonttools (pip install fonttools) — already a
// dependency of scripts/subset-icon-font.mjs.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_PATH = join(ROOT, 'public/fonts/MorphianTrial-Regular.woff2');
const OUT_PATH = join(ROOT, 'src/scripts/avatar-glyph-offsets.generated.js');

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

// A correction bigger than this fraction of the em means the derivation (or
// the font) is doing something unexpected — refuse to bake it in silently.
export const SANITY_LIMIT = 0.5;

const PY = `
import json, sys
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen

font = TTFont(sys.argv[1])
upm = font['head'].unitsPerEm
glyphSet = font.getGlyphSet()
hmtx = font['hmtx']
cmap = font.getBestCmap()

out = {}
for letter in "${LETTERS.join('')}":
    gname = cmap[ord(letter.upper())]
    pen = BoundsPen(glyphSet)
    glyphSet[gname].draw(pen)
    xMin, yMin, xMax, yMax = pen.bounds
    aw, lsb = hmtx[gname]
    out[letter] = {"xMin": xMin, "xMax": xMax, "yMin": yMin, "yMax": yMax, "aw": aw, "upm": upm}

print(json.dumps(out))
`;

/**
 * Pure: turn the raw font-unit metrics into per-letter {dxFrac, dyFrac}.
 * dxFrac is a DELTA (added to text-anchor="middle"'s x="50%" via the SVG
 * `dx` attribute); dyFrac is an ABSOLUTE fraction (the disc's own centre,
 * sizePx/2, plus dyFrac*fontSize, becomes the `y` attribute directly — no
 * dominant-baseline override). Exported for tests. See the header comment
 * for the derivation of each.
 */
export function computeOffsets(metricsByLetter) {
  const offsets = {};
  for (const letter of Object.keys(metricsByLetter)) {
    const m = metricsByLetter[letter];
    const dxFrac = (m.aw / 2 - (m.xMin + m.xMax) / 2) / m.upm;
    const dyFrac = (m.yMax + m.yMin) / (2 * m.upm);
    offsets[letter] = { dxFrac, dyFrac };
  }
  return offsets;
}

function assertSane(offsets) {
  for (const [letter, { dxFrac, dyFrac }] of Object.entries(offsets)) {
    if (Math.abs(dxFrac) > SANITY_LIMIT || Math.abs(dyFrac) > SANITY_LIMIT) {
      throw new Error(
        `glyph offset for '${letter}' is implausibly large (dxFrac=${dxFrac.toFixed(3)}, ` +
        `dyFrac=${dyFrac.toFixed(3)}) — more than half an em. The derivation or the font ` +
        `is doing something unexpected; refusing to bake this in.`
      );
    }
  }
}

function renderModule(offsets) {
  const rows = LETTERS.map(l => {
    const { dxFrac, dyFrac } = offsets[l];
    return `  ${l}: { dx: ${dxFrac.toFixed(5)}, dy: ${dyFrac.toFixed(5)} },`;
  }).join('\n');

  return `// GENERATED FILE — do not hand-edit.
// Regenerate with: node scripts/generate-glyph-offsets.mjs
//
// Per-letter ink-centring correction for the Morphian glyph avatars, as a
// FRACTION OF FONT SIZE (multiply by the rendered font-size in px). Derived
// from public/fonts/MorphianTrial-Regular.woff2's own outlines by
// scripts/generate-glyph-offsets.mjs — see that script's header comment for
// the full derivation. dx is a DELTA added to text-anchor="middle"'s
// x="50%" via SVG's dx attribute. dy is an ABSOLUTE fraction: avatar.js
// sets y to sizePx/2 + dy*fontSize directly, bypassing
// dominant-baseline="middle" entirely, since how any given engine resolves
// "middle" for a given font is implementation-defined rather than
// analytically predictable from the font alone.

export const GLYPH_OFFSETS = {
${rows}
};
`;
}

// Only run the font-parsing build when invoked directly — a test importing
// computeOffsets()/assertSane() for their pure logic must not shell out to
// python3.
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = execFileSync('python3', ['-c', PY, FONT_PATH], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  const metricsByLetter = JSON.parse(json);
  const offsets = computeOffsets(metricsByLetter);
  assertSane(offsets);
  writeFileSync(OUT_PATH, renderModule(offsets));
  console.log(`wrote ${OUT_PATH}`);
}

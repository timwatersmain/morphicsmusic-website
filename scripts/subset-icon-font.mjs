#!/usr/bin/env node
// Rebuild public/fonts/MaterialSymbols-Subset.woff2 from the upstream Google
// variable font, keeping ONLY the icons this site actually renders.
//
// Why self-host at all: the icon font was the last third-party font left, and
// its ligature names ("graphic_eq", "storefront") are real text. Until the font
// arrives they lay out in the fallback serif, so a slow mobile connection shows
// the nav as a run-on line of code for as long as it takes the Google round trip
// to finish. font-display: block only hides that for its ~3s block period; past
// that the fallback wins and the ligature text paints anyway. Serving the font
// from our own origin alongside the CSS removes the round trip entirely.
//
// Why subset: the full variable font is 1.1MB, far too heavy to preload for the
// ~40 glyphs we use. Subsetting takes it to a few KB.
//
// Usage: node scripts/subset-icon-font.mjs
// Requires: python3 with fonttools + brotli (pip install fonttools brotli)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/fonts/MaterialSymbols-Subset.woff2');

// The icon list is DERIVED from src/, never hand-maintained. A hand-written
// list went stale immediately: icons reach the DOM not only as span text but
// through lookup maps (`youtube: 'play_circle'`) and JS template strings, so
// any grep narrow enough to avoid false positives also missed real icons — and
// a missed icon renders as its literal name, which is the exact bug we are
// fixing. Instead: take every identifier-shaped token in src/ and keep the ones
// that are real glyph names in the upstream font. A false positive costs a few
// hundred bytes; a false negative puts words on the page.
function collectIcons(fontGlyphNames) {
  const words = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(astro|js|ts|jsx|tsx|md|json|html)$/.test(e.name)) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)*/g)) words.add(m[0]);
    }
  };
  walk(join(ROOT, 'src'));
  // Single common English words ("image", "group", "check", "tag") are both
  // glyph names and ordinary tokens, so this over-collects slightly. That is
  // the intended direction of the trade.
  return [...words].filter((w) => fontGlyphNames.has(w)).sort();
}

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=block';
// Google serves a different CSS (and font format) per User-Agent; this one gets
// the variable woff2 rather than a legacy static fallback.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error(`missing ${OUT} — run: node scripts/subset-icon-font.mjs`);
    process.exit(1);
  }
  console.log(`${OUT} present, ${(statSync(OUT).size / 1024).toFixed(1)} KB`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'ms-subset-'));
const css = execFileSync('curl', ['-sS', '-A', UA, CSS_URL], { encoding: 'utf8' });
const url = css.match(/https:\/\/fonts\.gstatic\.com[^)]+\.woff2/)?.[0];
if (!url) throw new Error('could not find a woff2 URL in the Google CSS response');

const src = join(tmp, 'full.woff2');
execFileSync('curl', ['-sS', url, '-o', src]);

// Glyph names come from the font itself, so the source scan is matched against
// what this exact version actually ships — a renamed or retired icon shows up
// as "not found" here rather than as words on the page.
const names = execFileSync('python3', ['-c',
  'import sys;from fontTools.ttLib import TTFont;print("\\n".join(TTFont(sys.argv[1]).getGlyphOrder()))',
  src], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const ICONS = collectIcons(new Set(names.split('\n')));
if (!ICONS.length) throw new Error('scanned src/ and matched no icon glyph names — refusing to ship an empty font');

// Ligature substitution needs two things: the component CHARACTERS of every
// name (so "graphic_eq" can be typed at all), and the icon GLYPHS themselves.
//
// --glyphs is what makes this small. Selecting by --text alone keeps 1.1MB,
// because our names between them use most of the alphabet, so layout closure
// decides every ligature in the font is reachable and retains all ~3500 icons.
// Naming the glyphs explicitly and disabling closure drops it to ~10KB.
const text = [...new Set(ICONS.join('').split(''))].sort().join('');
writeFileSync(join(tmp, 'text.txt'), text);

execFileSync('python3', [
  '-m', 'fontTools.subset', src,
  `--text-file=${join(tmp, 'text.txt')}`,
  `--glyphs=${ICONS.join(',')}`,
  '--layout-features=rlig,rclt,liga,calt',
  '--no-layout-closure',
  '--flavor=woff2',
  '--with-zopfli',
  `--output-file=${OUT}`,
], { stdio: 'inherit' });

console.log(`wrote ${OUT} — ${(statSync(OUT).size / 1024).toFixed(1)} KB for ${ICONS.length} icons`);

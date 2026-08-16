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
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_DIR = join(ROOT, 'public/fonts');
const BASE_LAYOUT = join(ROOT, 'src/layouts/BaseLayout.astro');

// The icon list is DERIVED from src/, never hand-maintained. A hand-written
// list went stale immediately: icons reach the DOM not only as span text but
// through lookup maps (`youtube: 'play_circle'`) and JS template strings, so
// any grep narrow enough to avoid false positives also missed real icons — and
// a missed icon renders as its literal name, which is the exact bug we are
// fixing. Instead: take every identifier-shaped token in src/ and keep the ones
// that are real glyph names in the upstream font. A false positive costs a few
// hundred bytes; a false negative puts words on the page.
export function collectIcons(fontGlyphNames) {
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

// The over-collecting scan above trades false positives for false negatives —
// by design, per the comment on collectIcons. But an icon that is EXPLICITLY
// named as an icon (an `icon: 'x'` property, not just some identifier that
// happens to appear in source) is a much stronger signal than an incidental
// token match, and a false negative here is exactly the "diversity_3" bug:
// the name silently fails collectIcons's glyph-name filter (typo, or the icon
// was renamed/retired upstream) and ships as literal text with nobody the
// wiser. Explicit `icon:` declarations are collected separately and checked
// against the upstream glyph set directly, so a miss throws at build time
// instead of shipping a word.
export function collectExplicitIconDeclarations() {
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(astro|js|ts|jsx|tsx)$/.test(e.name)) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/\bicon:\s*['"]([a-z][a-z0-9_]*)['"]/g)) {
        found.push({ icon: m[1], file: full });
      }
    }
  };
  walk(join(ROOT, 'src'));
  return found;
}

// Pure so it's cheap to pin in a test: given the declarations and the
// upstream glyph set, throw on the first one that won't survive the subset.
// A missing glyph here is not a smaller font — it is a word on the page.
export function assertExplicitIconsSurvive(declarations, fontGlyphNames) {
  for (const { icon, file } of declarations) {
    if (!fontGlyphNames.has(icon)) {
      throw new Error(
        `icon '${icon}' (declared in ${file}) is not a glyph name in the ` +
        `upstream Material Symbols Outlined font, so it will render as ` +
        `literal text instead of an icon. It may not exist in that icon set ` +
        `— check https://fonts.google.com/icons for the current name — or it ` +
        `may have been renamed/retired upstream.`
      );
    }
  }
}

// The font was served from a stable, unhashed filename
// (MaterialSymbols-Subset.woff2), referenced twice in BaseLayout.astro (the
// preload and the @font-face src). That is the reason the "diversity_3" bug
// shipped SILENTLY: the script had regenerated the font correctly, but a
// returning visitor's browser was still serving the OLD bytes from cache
// under that same URL, and the old build had no diversity_3 glyph. Hashing
// the filename to its content means a changed font gets a new URL, so a
// long-lived immutable Cache-Control (see public/_headers) is safe: the only
// way to get new bytes is a new filename, and the only way to get a new
// filename is changed content.
export function hashFontBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

export function hashedFontFilename(hash) {
  return `MaterialSymbols-Subset.${hash}.woff2`;
}

// Pure so the "BaseLayout ends up pointing at a file that exists" invariant
// is testable without running the font pipeline. Matches both the legacy
// unhashed reference (pre-fix) and any previously-hashed one, so re-running
// after this fix first ships is also idempotent.
const SUBSET_REF_RE = /\/fonts\/MaterialSymbols-Subset(?:\.[0-9a-f]{8})?\.woff2/g;
export function rewriteBaseLayoutFontRef(content, filename) {
  return content.replace(SUBSET_REF_RE, `/fonts/${filename}`);
}

// Pure: given the filenames currently in public/fonts/ and the one we just
// wrote, return only the STALE HASHED SUBSET builds to delete — never the
// other font families (Rubik, GeistMono, Inter, SpaceGrotesk, MorphianTrial),
// and never a non-subset file, because the pattern requires the exact
// "MaterialSymbols-Subset.<8 hex chars>.woff2" shape.
const HASHED_SUBSET_RE = /^MaterialSymbols-Subset\.[0-9a-f]{8}\.woff2$/;
export function staleSubsetFonts(existingFilenames, keepFilename) {
  return existingFilenames.filter((f) => HASHED_SUBSET_RE.test(f) && f !== keepFilename);
}

// Pure: pull the hashed subset filename BaseLayout.astro currently points
// at, so both --check and a test can assert that file actually exists on
// disk — the assertion that would have caught this whole bug class (a
// reference to a font that isn't the one being served/cached).
export function extractSubsetFilename(baseLayoutContent) {
  const m = baseLayoutContent.match(/MaterialSymbols-Subset(?:\.[0-9a-f]{8})?\.woff2/);
  return m ? m[0] : null;
}

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=block';
// Google serves a different CSS (and font format) per User-Agent; this one gets
// the variable woff2 rather than a legacy static fallback.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Only run the (network-dependent) build when invoked directly — importing
// this module for its pure functions (collectIcons, collectExplicitIconDeclarations,
// assertExplicitIconsSurvive) in a test must not shell out to curl/python3.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) {
    const filename = extractSubsetFilename(readFileSync(BASE_LAYOUT, 'utf8'));
    if (!filename) {
      console.error(`BaseLayout.astro has no MaterialSymbols-Subset reference — run: node scripts/subset-icon-font.mjs`);
      process.exit(1);
    }
    const out = join(FONTS_DIR, filename);
    if (!existsSync(out)) {
      console.error(`BaseLayout.astro points at ${filename}, which is missing from public/fonts/ — run: node scripts/subset-icon-font.mjs`);
      process.exit(1);
    }
    console.log(`${out} present, ${(statSync(out).size / 1024).toFixed(1)} KB`);
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
  const fontGlyphNames = new Set(names.split('\n'));
  const ICONS = collectIcons(fontGlyphNames);
  if (!ICONS.length) throw new Error('scanned src/ and matched no icon glyph names — refusing to ship an empty font');

  // Fail loudly on any explicit icon that won't survive into the subset.
  assertExplicitIconsSurvive(collectExplicitIconDeclarations(), fontGlyphNames);

  // Ligature substitution needs two things: the component CHARACTERS of every
  // name (so "graphic_eq" can be typed at all), and the icon GLYPHS themselves.
  //
  // --glyphs is what makes this small. Selecting by --text alone keeps 1.1MB,
  // because our names between them use most of the alphabet, so layout closure
  // decides every ligature in the font is reachable and retains all ~3500 icons.
  // Naming the glyphs explicitly and disabling closure drops it to ~10KB.
  //
  // This character set is load-bearing in a way that's easy to get wrong: a
  // ligature only composes if EVERY character of its name is in this text
  // set AND the subsetted GSUB table still carries the rule that maps that
  // exact character sequence to the glyph. An icon name built only from
  // plain lowercase letters (e.g. "storefront", "groups") draws from
  // characters every other icon also needs, so its rule is well-exercised.
  // A name carrying an underscore or digit ("diversity_3") is rarer company
  // in that character set and is a structurally riskier ligature to depend
  // on — which is why the COMMUNITY icon was moved off diversity_3 to
  // groups after a report of it rendering as literal text in one real
  // browser (unreproduced in this repo's headless-Chrome verification, but
  // the character-count risk costs nothing to avoid).
  const text = [...new Set(ICONS.join('').split(''))].sort().join('');
  writeFileSync(join(tmp, 'text.txt'), text);

  const subsetTmp = join(tmp, 'subset.woff2');
  execFileSync('python3', [
    '-m', 'fontTools.subset', src,
    `--text-file=${join(tmp, 'text.txt')}`,
    `--glyphs=${ICONS.join(',')}`,
    '--layout-features=rlig,rclt,liga,calt',
    '--no-layout-closure',
    '--flavor=woff2',
    '--with-zopfli',
    `--output-file=${subsetTmp}`,
  ], { stdio: 'inherit' });

  const bytes = readFileSync(subsetTmp);
  const filename = hashedFontFilename(hashFontBuffer(bytes));
  const outPath = join(FONTS_DIR, filename);
  // Idempotent: identical content hashes to the same filename, so if it's
  // already on disk there's nothing new to write.
  if (!existsSync(outPath)) writeFileSync(outPath, bytes);

  // Never touches Rubik/GeistMono/Inter/SpaceGrotesk/MorphianTrial — the
  // pattern only matches this subset's own hashed filenames.
  for (const stale of staleSubsetFonts(readdirSync(FONTS_DIR), filename)) {
    unlinkSync(join(FONTS_DIR, stale));
  }

  const layoutSrc = readFileSync(BASE_LAYOUT, 'utf8');
  const updatedLayout = rewriteBaseLayoutFontRef(layoutSrc, filename);
  // Idempotent: leave BaseLayout.astro's mtime/git status untouched when the
  // filename hasn't changed.
  if (updatedLayout !== layoutSrc) writeFileSync(BASE_LAYOUT, updatedLayout);

  console.log(`wrote public/fonts/${filename} — ${(bytes.length / 1024).toFixed(1)} KB for ${ICONS.length} icons`);
}

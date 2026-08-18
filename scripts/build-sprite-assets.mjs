#!/usr/bin/env node
// Turns the vendored sprite export (src/scripts/sprites/vendor/sprites-kept.json,
// 613KB — see that directory's README.txt for the format) into:
//   1. A content-hashed public asset (public/sprites/sprites.<hash>.json) that
//      community pages fetch client-side. Hashing the filename is the same
//      technique scripts/subset-icon-font.mjs uses for the icon font: a
//      changed file gets a new URL, which is what makes a long-lived
//      immutable Cache-Control (see public/_headers) safe.
//   2. src/scripts/sprites/data-url.generated.js — the current hashed URL,
//      imported by client code so nothing hand-edits a path string.
//   3. functions/_lib/community/sprite-refs.generated.ts — just the `ref`
//      list per stage (no grids/palettes), small enough to bundle directly
//      into the Workers function that assigns each fan their sprites. This
//      keeps sprite ASSIGNMENT (server-side, cheap) separate from sprite
//      RENDERING — the server never needs to fetch the big JSON at all.
//   4. public/sprites/ref/<REF>.json — ONE file per sprite (~1-2KB), so the
//      server can now render a single creature to a PNG (for Discord embeds,
//      see functions/api/community/creature/[handle].ts) by fetching just
//      that sprite. This is what keeps point 3's promise true: rendering one
//      creature must never mean pulling 613KB into a Worker with a 10ms CPU
//      budget. These are NOT content-hashed — they are addressed by ref,
//      which is stable forever (a fan's sprite refs are fixed at profile
//      creation), so the URL must be stable too.
//
// Usage: node scripts/build-sprite-assets.mjs
// No network, no external deps — safe to re-run any time the vendored data
// changes. Not wired into the `prebuild` chain (same as the icon font
// script) since it has nothing to do with the network-dependent catalog
// syncs that chain runs; run it by hand after touching the vendored export.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src/scripts/sprites/vendor/sprites-kept.json');
const SPRITES_DIR = join(ROOT, 'public/sprites');
const DATA_URL_MODULE = join(ROOT, 'src/scripts/sprites/data-url.generated.js');
const REFS_MODULE = join(ROOT, 'functions/_lib/community/sprite-refs.generated.ts');

export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

export function hashedSpriteFilename(hash) {
  return `sprites.${hash}.json`;
}

// Pure: filenames in public/sprites/ that are stale hashed builds, never the
// one we just wrote. Mirrors staleSubsetFonts in subset-icon-font.mjs.
const HASHED_RE = /^sprites\.[0-9a-f]{8}\.json$/;
export function staleSpriteFiles(existingFilenames, keepFilename) {
  return existingFilenames.filter(f => HASHED_RE.test(f) && f !== keepFilename);
}

// Pure: ref (e.g. "A147") per stage, in file order — this is ALL the server
// needs to deterministically assign a fan a sprite per stage (see
// functions/_lib/community/sprites.ts). No grid/palette/recipe data, so this
// stays a few KB even with 401 sprites.
export function refsByStage(sprites) {
  const out = { egg: [], grub: [], pupa: [], adult: [] };
  for (const s of sprites) {
    if (!out[s.stage]) throw new Error(`sprite ${s.ref} has unknown stage "${s.stage}"`);
    out[s.stage].push(s.ref);
  }
  for (const stage of Object.keys(out)) {
    if (!out[stage].length) throw new Error(`no sprites for stage "${stage}" — refusing to build an empty roster`);
  }
  return out;
}

// Pure: the per-sprite payload the PNG renderer needs — the grid, the stage
// (which picks the XP transform), and the sprite's own authored palette (for
// the 'native' colourway). Everything else in the export is either for the
// animation the server never runs, or catalogue metadata.
export function renderPayload(sprite) {
  return {
    ref: sprite.ref,
    stage: sprite.stage,
    base: sprite.base,
    palette: sprite.palette,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = readFileSync(SOURCE);
  const sprites = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(sprites) || !sprites.length) {
    throw new Error(`${SOURCE} did not parse to a non-empty array of sprites`);
  }

  mkdirSync(SPRITES_DIR, { recursive: true });
  const filename = hashedSpriteFilename(hashBuffer(raw));
  const outPath = join(SPRITES_DIR, filename);
  if (!existsSync(outPath)) writeFileSync(outPath, raw);

  for (const stale of staleSpriteFiles(readdirSync(SPRITES_DIR), filename)) {
    unlinkSync(join(SPRITES_DIR, stale));
  }

  const dataUrlSrc = `// GENERATED FILE — do not hand-edit.
// Regenerate with: node scripts/build-sprite-assets.mjs
// The current content-hashed URL for the sprite data asset — see
// scripts/build-sprite-assets.mjs and public/_headers (the immutable cache
// rule is scoped to exactly this hashed filename pattern, on purpose).
export const SPRITE_DATA_URL = '/sprites/${filename}';
`;
  writeFileSync(DATA_URL_MODULE, dataUrlSrc);

  const refs = refsByStage(sprites);
  const refsSrc = `// GENERATED FILE — do not hand-edit.
// Regenerate with: node scripts/build-sprite-assets.mjs
// Ref-only index (no grid/palette data) so sprite ASSIGNMENT can run inside
// the Workers function bundle without fetching the 613KB sprite data asset —
// see functions/_lib/community/sprites.ts. Counts: ${Object.entries(refs).map(([k, v]) => `${k}=${v.length}`).join(', ')}.
export const SPRITE_REFS_BY_STAGE: Record<'egg' | 'grub' | 'pupa' | 'adult', string[]> = ${JSON.stringify(refs, null, 2)};
`;
  writeFileSync(REFS_MODULE, refsSrc);

  const refDir = join(SPRITES_DIR, 'ref');
  mkdirSync(refDir, { recursive: true });
  let refBytes = 0;
  for (const sprite of sprites) {
    // The ref is used directly as a filename, so a ref containing a path
    // separator would write outside refDir. The export is trusted, but a
    // trusted input that becomes a path deserves the check anyway.
    if (!/^[A-Za-z0-9_-]+$/.test(sprite.ref)) {
      throw new Error(`sprite ref ${JSON.stringify(sprite.ref)} is not filename-safe`);
    }
    const body = JSON.stringify(renderPayload(sprite));
    refBytes += body.length;
    writeFileSync(join(refDir, `${sprite.ref}.json`), body);
  }

  console.log(`wrote public/sprites/${filename} (${(raw.length / 1024).toFixed(1)} KB), ` +
    `${sprites.length} per-sprite files in public/sprites/ref/ ` +
    `(${(refBytes / sprites.length / 1024).toFixed(1)} KB avg), ` +
    `${DATA_URL_MODULE.replace(ROOT + '/', '')}, ${REFS_MODULE.replace(ROOT + '/', '')}`);
}

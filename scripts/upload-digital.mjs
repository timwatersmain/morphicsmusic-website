/**
 * upload-digital.mjs
 *
 * Uploads the downloadable products in src/data/digital.json to the R2 bucket
 * the site serves downloads from, at the exact `file.r2_key` each product
 * declares. That key is the allow-list the download function checks, so what
 * is uploaded here and what a buyer is permitted to fetch cannot drift apart.
 *
 * Source files are looked up by filename, in order:
 *   --dir=<path>                     if given
 *   ~/Desktop/Morphian/store/        where the font build delivers
 *   ~/Desktop/Morphics Digital/      general drop folder
 *
 * Auth: requires `wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 *
 * Usage:
 *   node scripts/upload-digital.mjs             # upload everything missing
 *   node scripts/upload-digital.mjs --dry-run   # show what would happen
 *   node scripts/upload-digital.mjs --slug=morphian
 */

import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import os from 'os';

import digital from '../src/data/digital.json' with { type: 'json' };

const argMap = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const BUCKET = argMap.bucket || 'morphicsbrain-media';
const DRY = !!argMap['dry-run'];
const ONLY = argMap.slug || null;

const SEARCH_DIRS = [
  argMap.dir && resolve(String(argMap.dir)),
  join(os.homedir(), 'Desktop', 'Morphian', 'store'),
  join(os.homedir(), 'Desktop', 'Morphics Digital'),
].filter(Boolean);

function findSource(filename) {
  for (const dir of SEARCH_DIRS) {
    const p = join(dir, filename);
    if (existsSync(p)) return p;
  }
  return null;
}

function put(key, path) {
  let attempts = 0;
  const maxAttempts = 3;
  for (;;) {
    try {
      execSync(
        `npx --yes wrangler r2 object put "${BUCKET}/${key}" --file="${path}" --remote`,
        { stdio: 'inherit' },
      );
      return;
    } catch (e) {
      attempts++;
      if (attempts >= maxAttempts) throw e;
      const wait = attempts * 5;
      console.log(`  ✗ failed (attempt ${attempts}/${maxAttempts}) — waiting ${wait}s`);
      execSync(`sleep ${wait}`);
    }
  }
}

let uploaded = 0;
let missing = 0;

for (const product of digital) {
  if (ONLY && product.slug !== ONLY) continue;
  const key = product?.file?.r2_key;
  const filename = product?.file?.filename;
  if (!key || !filename) {
    console.log(`! ${product.slug}: no file.r2_key / file.filename — skipped`);
    continue;
  }

  const src = findSource(filename);
  if (!src) {
    missing++;
    console.log(`! ${product.slug}: ${filename} not found in:`);
    SEARCH_DIRS.forEach(d => console.log(`    ${d}`));
    continue;
  }

  const size = statSync(src).size;
  console.log(`→ ${product.slug}  ${filename}  ${(size / 1024).toFixed(0)} KB`);
  console.log(`  ${BUCKET}/${key}`);
  if (DRY) continue;

  put(key, src);
  uploaded++;
}

console.log(
  DRY
    ? '\nDry run — nothing uploaded.'
    : `\nUploaded ${uploaded} file(s)${missing ? `, ${missing} missing` : ''}.`,
);
if (missing) process.exitCode = 1;

/**
 * upload-masters.mjs
 *
 * Uploads ~/Desktop/Morphics Masters/<Release Title>/* to the Cloudflare R2
 * bucket `morphics-masters` (default name — override with --bucket=...).
 * Also writes src/data/masters-manifest.json so the download function knows
 * what files exist per release without listing R2 at request time.
 *
 * Auth: requires `wrangler login` to have been run, or CLOUDFLARE_API_TOKEN
 * + CLOUDFLARE_ACCOUNT_ID set.
 *
 * Usage:
 *   node scripts/upload-masters.mjs                # upload + manifest
 *   node scripts/upload-masters.mjs --manifest-only
 *   node scripts/upload-masters.mjs --dry-run
 */

import { readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve, extname } from 'path';
import { execSync } from 'child_process';
import os from 'os';

const args = new Set(process.argv.slice(2));
const argMap = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const BUCKET = argMap.bucket || 'morphicsbrain-media';
const KEY_PREFIX = argMap.prefix || 'masters/';
const DRY = !!argMap['dry-run'];
const MANIFEST_ONLY = !!argMap['manifest-only'];

const SITE_PATH = resolve(import.meta.dirname, '..');
const MASTERS = join(os.homedir(), 'Desktop', 'Morphics Masters');
const AUDIO_RX = /\.(flac|wav|aiff|aif|mp3)$/i;

import catalog from '../src/data/music-catalog.json' with { type: 'json' };

function slugifyForKey(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function scan() {
  if (!statSync(MASTERS, { throwIfNoEntry: false })) {
    console.error(`✗ ${MASTERS} not found`);
    process.exit(1);
  }
  const folders = readdirSync(MASTERS).filter(f => {
    const p = join(MASTERS, f);
    return statSync(p).isDirectory() && !f.startsWith('.');
  });
  const map = {};
  for (const folder of folders) {
    // Match folder to release by case-insensitive title match.
    const wanted = folder.toLowerCase().replace(/\s+/g, '');
    const release = catalog.releases.find(
      r => r.title.toLowerCase().replace(/\s+/g, '') === wanted ||
           r.slug.toLowerCase().replace(/-/g, '') === wanted,
    );
    if (!release) {
      console.warn(`  ! folder "${folder}" doesn't match any release — skipping`);
      continue;
    }
    const files = readdirSync(join(MASTERS, folder)).filter(f => AUDIO_RX.test(f)).sort();
    map[release.slug] = files.map(f => ({
      filename: f,
      key: `${KEY_PREFIX}${release.slug}/${slugifyForKey(f)}`,
      size: statSync(join(MASTERS, folder, f)).size,
      ext: extname(f).slice(1).toLowerCase(),
      path: join(MASTERS, folder, f),
    }));
  }
  return map;
}

function upload(key, path) {
  if (DRY) { console.log(`  [dry] would upload ${key}`); return; }
  execSync(
    `npx --yes wrangler r2 object put "${BUCKET}/${key}" --file="${path}" --remote`,
    { stdio: 'inherit' },
  );
}

console.log(`• scanning ${MASTERS}`);
const map = scan();

const releaseSlugs = Object.keys(map);
console.log(`  ${releaseSlugs.length} releases with files`);

if (!MANIFEST_ONLY) {
  for (const slug of releaseSlugs) {
    console.log(`• ${slug} (${map[slug].length} files)`);
    for (const f of map[slug]) upload(f.key, f.path);
  }
}

const manifest = {
  bucket: BUCKET,
  generated_at: new Date().toISOString(),
  releases: Object.fromEntries(
    Object.entries(map).map(([slug, files]) => [
      slug,
      files.map(({ filename, key, size, ext }) => ({ filename, key, size, ext })),
    ]),
  ),
};
const out = join(SITE_PATH, 'src', 'data', 'masters-manifest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ masters-manifest.json — ${releaseSlugs.length} releases`);

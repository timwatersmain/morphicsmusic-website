/**
 * generate-previews.mjs
 *
 * Builds streamable, purchase-free preview MP3s for every master that exists in
 * R2 and writes src/data/previews.json — the allow-list the /api/preview
 * function serves from. Previews are FULL-length 128 kbps MP3 (metadata
 * stripped); the lossless WAV master stays the paid, purchase-gated download.
 *
 * For each entry in masters-manifest.json:
 *   1. fetch the master from R2  (authenticated; pub-*.r2.dev is 401)
 *   2. ffmpeg → 128k CBR MP3, 44.1k, no tags
 *   3. upload to R2 under previews/<slug>/<basename>.mp3  (skip if present)
 *   4. record { track_number, key, filename, size, duration_seconds }
 *
 * Auth: wrangler OAuth (same as upload-masters.mjs). ffmpeg/ffprobe on PATH.
 *
 * Usage:
 *   node scripts/generate-previews.mjs                 # all releases
 *   node scripts/generate-previews.mjs --slug=swamp-logic
 *   node scripts/generate-previews.mjs --force         # re-transcode + re-upload
 *   node scripts/generate-previews.mjs --manifest-only # just rewrite previews.json
 */

import { writeFileSync, mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync, execFileSync } from 'child_process';
import os from 'os';

import manifest from '../src/data/masters-manifest.json' with { type: 'json' };
import catalog from '../src/data/music-catalog.json' with { type: 'json' };

const argMap = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const BUCKET = manifest.bucket || 'morphicsbrain-media';
const PREVIEW_PREFIX = 'previews/';
const ONLY_SLUG = argMap.slug || null;
const FORCE = !!argMap.force;
const MANIFEST_ONLY = !!argMap['manifest-only'];

const SITE_PATH = resolve(import.meta.dirname, '..');
const OUT = join(SITE_PATH, 'src', 'data', 'previews.json');

// Catalog tracks per slug, for title-based matching.
const TRACKS_BY_SLUG = Object.fromEntries(
  catalog.releases.map(r => [r.slug, (r.tracks || []).map(t => ({ n: t.track_number, t: t.title }))]),
);

function norm(s) {
  return String(s)
    .replace(/\.[^.]+$/, '')          // ext
    .toLowerCase()
    .replace(/morphics/g, '')
    .replace(/[^a-z0-9]/g, '')        // separators/punct
    .replace(/^\d+/, '');             // leading track number
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Best-effort: match a master filename to its catalog track number.
// Tries an exact leading "NN" prefix first, then the closest title by edit
// distance (handles alphabetical file order + small title typos like
// "Eaytoy"/"Eartoy"). Returns null when nothing is reasonably close.
function trackNumberFor(slug, filename) {
  const pref = filename.match(/^(\d{1,3})[\s_.-]/);
  const tracks = TRACKS_BY_SLUG[slug] || [];
  // Single-track release: the one preview is unambiguously track 1.
  if (tracks.length === 1) return tracks[0].n;
  const fn = norm(filename);
  let best = null, bestD = Infinity;
  for (const tr of tracks) {
    const d = levenshtein(fn, norm(tr.t));
    if (d < bestD) { bestD = d; best = tr.n; }
  }
  // Accept a fuzzy match within ~25% of the title length (or exact prefix).
  const closeEnough = best != null && bestD <= Math.max(2, Math.ceil(fn.length * 0.25));
  if (pref) return parseInt(pref[1], 10);
  return closeEnough ? best : null;
}

// Existing previews.json (preserve durations when skipping re-transcode).
const PRIOR = (() => {
  try { return existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')).previews || {} : {}; }
  catch { return {}; }
})();
function priorDuration(slug, key) {
  return (PRIOR[slug] || []).find(e => e.key === key)?.duration_seconds ?? null;
}

function previewKeyFor(slug, filename) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${PREVIEW_PREFIX}${slug}/${base}.mp3`;
}

function r2Exists(key) {
  try {
    execSync(
      `npx --yes wrangler r2 object get "${BUCKET}/${key}" --remote --pipe --range="bytes=0-0" > /dev/null 2>&1`,
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

function r2Get(key, dest) {
  execSync(`npx --yes wrangler r2 object get "${BUCKET}/${key}" --remote --pipe > "${dest}"`,
    { stdio: ['ignore', 'ignore', 'inherit'] });
}

function r2Put(key, src) {
  let attempts = 0;
  while (true) {
    try {
      execSync(`npx --yes wrangler r2 object put "${BUCKET}/${key}" --file="${src}" --content-type="audio/mpeg" --remote`,
        { stdio: 'inherit' });
      return;
    } catch (e) {
      if (++attempts >= 3) throw e;
      execSync(`sleep ${attempts * 5}`);
    }
  }
}

function transcode(src, dest) {
  execFileSync('ffmpeg', [
    '-y', '-i', src,
    '-map_metadata', '-1',
    '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100',
    dest,
  ], { stdio: 'ignore' });
}

function durationSeconds(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { encoding: 'utf8' });
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? Math.round(d) : null;
  } catch {
    return null;
  }
}

const AUDIO_RX = /\.(wav|aiff|aif|flac|mp3)$/i;
const tmp = mkdtempSync(join(os.tmpdir(), 'previews-'));
let previews = {};

try {
  const slugs = Object.keys(manifest.releases || {}).filter(s => !ONLY_SLUG || s === ONLY_SLUG);
  for (const slug of slugs) {
    const masters = (manifest.releases[slug] || []).filter(f => AUDIO_RX.test(f.key || ''));
    if (!masters.length) continue;
    console.log(`• ${slug} (${masters.length} tracks)`);
    const entries = [];
    for (const f of masters) {
      const pkey = previewKeyFor(slug, f.filename);
      const tn = trackNumberFor(slug, f.filename);

      if (!MANIFEST_ONLY && (FORCE || !r2Exists(pkey))) {
        const inFile = join(tmp, 'in' + (f.ext ? '.' + f.ext : ''));
        const outFile = join(tmp, 'out.mp3');
        console.log(`    ↓ fetch ${f.key}`);
        r2Get(f.key, inFile);
        console.log(`    ♪ transcode → 128k mp3`);
        transcode(inFile, outFile);
        const dur = durationSeconds(outFile);
        const size = statSync(outFile).size;
        console.log(`    ↑ upload ${pkey} (${(size / 1e6).toFixed(1)}MB, ${dur ?? '?'}s)`);
        r2Put(pkey, outFile);
        entries.push({ track_number: tn, key: pkey, filename: f.filename, size, duration_seconds: dur });
        rmSync(inFile, { force: true });
        rmSync(outFile, { force: true });
      } else {
        console.log(`    ✓ preview exists — skip ${pkey}`);
        entries.push({ track_number: tn, key: pkey, filename: f.filename, duration_seconds: priorDuration(slug, pkey) });
      }
    }
    entries.sort((a, b) => (a.track_number ?? 1e9) - (b.track_number ?? 1e9));
    previews[slug] = entries;
  }

  // When only re-doing one slug (or manifest-only), preserve existing entries.
  if (ONLY_SLUG || MANIFEST_ONLY) {
    try {
      const prev = JSON.parse(execSync(`cat "${OUT}"`, { encoding: 'utf8' }));
      previews = Object.assign({}, prev.previews, previews); // eslint-disable-line
    } catch { /* no prior file */ }
  }

  const out = { bucket: BUCKET, generated_at: new Date().toISOString(), previews };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`✓ previews.json — ${Object.keys(previews).length} releases, ${Object.values(previews).reduce((n, a) => n + a.length, 0)} tracks`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

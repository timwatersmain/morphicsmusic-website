/**
 * sync-music-catalog.mjs
 *
 * Builds src/data/music-catalog.json — the source of truth for the on-site
 * music store. Joins releases + tracks from the MorphicsBrain SQLite DB,
 * applies tiered name-your-price minimums, and (if present) attaches master
 * filenames from ~/Desktop/Morphics Masters/<Release Title>/.
 *
 * Usage: node scripts/sync-music-catalog.mjs
 */

import { writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { releaseSlug, releaseDateFor, minPriceCentsFor } from './catalog-helpers.mjs';

const BRAIN_DB = '/Users/morphics/Desktop/MorphicsBrain/data/morphicsbrain.db';
const SITE_PATH = resolve(import.meta.dirname, '..');
const MASTERS_DIR = join(os.homedir(), 'Desktop', 'Morphics Masters');

function query(sql) {
  try {
    const raw = execSync(`sqlite3 -json "${BRAIN_DB}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' });
    return JSON.parse(raw || '[]');
  } catch {
    return null;
  }
}

// Find the on-disk master folder for a release. Title-match (case-insensitive).
function findMasterFolder(title) {
  if (!existsSync(MASTERS_DIR)) return null;
  const wanted = title.toLowerCase().replace(/\s+/g, '');
  for (const entry of readdirSync(MASTERS_DIR)) {
    const full = join(MASTERS_DIR, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry.toLowerCase().replace(/\s+/g, '') === wanted) return full;
  }
  return null;
}

// Pick the master file for a track inside a release folder.
// Strategy: match filenames containing the track number (e.g. "01 ..." / "1.")
// or fallback to title substring.
function findMasterFile(folder, trackNumber, trackTitle) {
  if (!folder) return null;
  const files = readdirSync(folder).filter(f => /\.(flac|wav|aiff|aif|mp3)$/i.test(f));
  const padded = String(trackNumber).padStart(2, '0');
  const byNum = files.find(f =>
    f.startsWith(`${padded} `) || f.startsWith(`${padded}-`) ||
    f.startsWith(`${padded}_`) || f.startsWith(`${padded}.`) ||
    f.startsWith(`${trackNumber} `) || f.startsWith(`${trackNumber}-`),
  );
  if (byNum) return byNum;
  const lower = trackTitle.toLowerCase();
  return files.find(f => f.toLowerCase().includes(lower)) || null;
}

const releases = query(
  `SELECT id, title, type, release_date, scheduled_release_date, artwork_path, bandcamp_url, genre, description
   FROM releases
   ORDER BY COALESCE(NULLIF(release_date,''), scheduled_release_date) DESC`,
);

// On a build server (Cloudflare Pages, etc.) the brain DB won't exist —
// keep whatever music-catalog.json was last committed and exit cleanly.
if (releases === null) {
  console.log('• brain DB unreachable — leaving src/data/music-catalog.json as committed');
  process.exit(0);
}

const tracks = query(
  `SELECT id, release_id, track_number, title, isrc, duration_seconds
   FROM tracks ORDER BY release_id, track_number`,
) || [];

const tracksByRelease = {};
for (const t of tracks) {
  (tracksByRelease[t.release_id] ||= []).push(t);
}

const catalog = {
  generated_at: new Date().toISOString(),
  releases: releases.map(r => {
    const slug = releaseSlug(r.id, r.title);
    const releaseTracks = tracksByRelease[r.id] || [];
    const masterFolder = findMasterFolder(r.title);

    return {
      id: r.id,
      slug,
      title: r.title.toUpperCase(),
      type: r.type,
      release_date: releaseDateFor(r.release_date, r.scheduled_release_date),
      // artwork_path in the brain DB is a brain-internal reference (an R2 key /
      // pub-*.r2.dev URL, which is 401, or a host filesystem path) — never a
      // web-servable URL. The site always uses the static album-art convention;
      // the publish pipeline materializes <slug>.jpg into public/images/albums/.
      artwork: `/images/albums/${slug}.jpg`,
      genre: r.genre ? r.genre.split(',').map(s => s.trim()) : ['electronic'],
      description: r.description || '',
      bandcamp_url: r.bandcamp_url || null,
      min_price_cents: minPriceCentsFor(r.type, releaseTracks.length),
      track_count: releaseTracks.length,
      has_masters: !!masterFolder,
      tracks: releaseTracks.map(t => ({
        id: t.id,
        track_number: t.track_number,
        title: t.title,
        isrc: t.isrc,
        duration_seconds: t.duration_seconds,
        min_price_cents: 100,
        master_filename: findMasterFile(masterFolder, t.track_number, t.title),
      })),
    };
  }),
};

const out = join(SITE_PATH, 'src', 'data', 'music-catalog.json');
writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');

const total = catalog.releases.length;
const withMasters = catalog.releases.filter(r => r.has_masters).length;
console.log(`✓ music-catalog.json — ${total} releases, ${withMasters} with masters on disk`);

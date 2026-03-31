/**
 * sync-from-brain.mjs
 *
 * Reads data from MorphicsBrain (SQLite DB + data files) and generates
 * the website's JSON data files. Run before build or on a schedule.
 *
 * Usage:
 *   node scripts/sync-from-brain.mjs
 *
 * Or add to package.json:
 *   "presync": "node scripts/sync-from-brain.mjs"
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

// ── Config ──────────────────────────────────────────────────────────
const BRAIN_PATH = resolve('/Users/morphics/Desktop/MorphicsBrain');
const SITE_PATH = resolve(import.meta.dirname, '..');
const DB_PATH = join(BRAIN_PATH, 'data', 'morphicsbrain.db');
const ASSETS_SRC = resolve('/Users/morphics/Desktop/Morphics Web');

// ── Helpers ─────────────────────────────────────────────────────────
function query(sql) {
  try {
    const raw = execSync(`sqlite3 -json "${DB_PATH}" "${sql}"`, { encoding: 'utf-8' });
    return JSON.parse(raw || '[]');
  } catch { return []; }
}

function writeData(filename, data) {
  const path = join(SITE_PATH, 'src', 'data', filename);
  const json = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(path, json);
  console.log(`  ✓ ${filename} (${Array.isArray(data) ? data.length + ' items' : 'object'})`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return null; }
}

// ── Sync: Streaming Platform Links ──────────────────────────────────
function syncPlatformLinks() {
  const rows = query('SELECT name, url FROM streaming_platforms');
  const links = {};
  for (const row of rows) {
    const key = row.name.toLowerCase().replace(/ /g, '_');
    if (row.url) links[key] = row.url;
  }
  return links;
}

// ── Sync: Releases ──────────────────────────────────────────────────
function syncReleases() {
  // Read existing releases as the source of truth for what releases exist
  const existing = readJson(join(SITE_PATH, 'src', 'data', 'releases.json')) || [];
  const platformLinks = syncPlatformLinks();

  // Check for new album art in the Morphics Web folder
  const albumArtDir = join(ASSETS_SRC, 'Album Art copy');
  const existingIds = new Set(existing.map(r => r.id));

  if (existsSync(albumArtDir)) {
    const artFiles = readdirSync(albumArtDir).filter(f => /\.(jpg|png)$/i.test(f));
    for (const file of artFiles) {
      const name = file.replace(/ copy/gi, '').replace(/\.(jpg|png)$/i, '').trim();
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      if (!existingIds.has(id)) {
        console.log(`  ! New album art found: ${name} (${id}) — add manually to releases.json`);
      }
    }
  }

  // Update platform links from DB
  const updated = existing.map(release => ({
    ...release,
    links: {
      bandcamp: release.links?.bandcamp || 'https://morphics.bandcamp.com/',
      ...(platformLinks.spotify && { spotify: platformLinks.spotify }),
      ...(platformLinks.apple_music && { 'apple music': platformLinks.apple_music }),
      ...(platformLinks.soundcloud && { soundcloud: platformLinks.soundcloud }),
    }
  }));

  writeData('releases.json', updated);
  return updated;
}

// ── Sync: Store (mirrors releases as music items) ───────────────────
function syncStore(releases) {
  const storeItems = releases
    .filter(r => r.type !== 'single')
    .map(r => ({
      id: `${r.id}-${r.type}`,
      title: r.title,
      type: 'music',
      category: r.type,
      price: r.type === 'ep' ? '$5.99' : '$9.99',
      image: r.artwork,
      description: `${r.type === 'ep' ? 'EP' : 'Full-length album'} — experimental electronic`,
      url: r.links?.bandcamp || 'https://morphics.bandcamp.com/',
      platform: 'bandcamp',
      tags: [r.type, ...r.genre.slice(0, 2)]
    }));

  writeData('store.json', storeItems);
}

// ── Sync: Signal (from content_history in DB, deduplicated) ─────────
function syncSignal() {
  // Prefer YouTube > Instagram > Bluesky > others for the displayed platform
  const platformPriority = { youtube: 1, instagram: 2, bluesky: 3, tiktok: 4, facebook: 5, twitter: 6 };

  const posts = query(`
    SELECT id, platform, caption, media_url, platform_url, published_at, media_type,
           youtube_title, instagram_post_type
    FROM content_history
    ORDER BY published_at DESC
    LIMIT 50
  `);

  if (posts.length === 0) {
    console.log('  - No content_history posts found, keeping existing signal.json');
    return;
  }

  // Group by caption to deduplicate cross-posts
  const groups = {};
  for (const p of posts) {
    const key = (p.caption || '').trim().toLowerCase();
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }

  // Pick the best platform per group, collect all platforms it was posted to
  const signal = Object.values(groups).map(group => {
    group.sort((a, b) =>
      (platformPriority[a.platform?.toLowerCase()] || 99) -
      (platformPriority[b.platform?.toLowerCase()] || 99)
    );
    const best = group[0];
    const allPlatforms = [...new Set(group.map(p => p.platform?.toLowerCase()).filter(Boolean))];

    return {
      id: best.id || '',
      title: (best.youtube_title || best.caption || '').substring(0, 60).toUpperCase(),
      type: best.media_type || 'visual',
      mediaUrl: best.media_url || '',
      thumbnail: '',
      caption: best.caption || '',
      date: best.published_at?.split('T')[0] || '',
      platform: best.platform?.toLowerCase() || '',
      url: best.platform_url || '#',
      originalPlatforms: allPlatforms
    };
  });

  writeData('signal.json', signal);
}

// ── Sync: Bandcamp Latest ───────────────────────────────────────────
function syncBandcamp() {
  // The fetch-bandcamp script already handles this via the prebuild hook
  // Just verify it exists
  const bcPath = join(SITE_PATH, 'src', 'data', 'bandcamp-latest.json');
  if (existsSync(bcPath)) {
    const bc = readJson(bcPath);
    console.log(`  ✓ bandcamp-latest.json (${bc?.title || 'loaded'})`);
  } else {
    console.log('  - bandcamp-latest.json not found, run: npm run prebuild');
  }
}

// ── Sync: Check for new track files ─────────────────────────────────
function syncTracks() {
  const tracksDir = join(SITE_PATH, 'public', 'assets', 'tracks');
  const tracksJson = join(SITE_PATH, 'public', 'content', 'tracks.json');

  if (!existsSync(tracksDir)) return;

  const existing = readJson(tracksJson) || [];
  const existingFiles = new Set(existing.map(t => t.url.split('/').pop()));
  const diskFiles = readdirSync(tracksDir).filter(f => f.endsWith('.mp3'));

  let updated = false;
  for (const file of diskFiles) {
    if (!existingFiles.has(file)) {
      const id = file.replace('.mp3', '');
      const title = id.replace(/-/g, ' ').toUpperCase();
      existing.push({ id, title, url: `/assets/tracks/${file}`, hidden: false, duration: 0 });
      console.log(`  + New track: ${title}`);
      updated = true;
    }
  }

  // Remove tracks whose files no longer exist
  const diskSet = new Set(diskFiles);
  const filtered = existing.filter(t => {
    const file = t.url.split('/').pop();
    if (!diskSet.has(file)) {
      console.log(`  - Removed track: ${t.title} (file missing)`);
      updated = true;
      return false;
    }
    return true;
  });

  if (updated) {
    writeFileSync(tracksJson, JSON.stringify(filtered, null, 2) + '\n');
    console.log(`  ✓ tracks.json (${filtered.length} tracks)`);
  } else {
    console.log(`  ✓ tracks.json (${existing.length} tracks, up to date)`);
  }
}

// ── Main ────────────────────────────────────────────────────────────
console.log('\n🔄 Syncing from MorphicsBrain...\n');

console.log('Releases:');
const releases = syncReleases();

// Store is manually maintained — skip auto-sync
// To regenerate: uncomment and run `npm run sync`
// console.log('\nStore:');
// syncStore(releases);

console.log('\nTracks:');
syncTracks();

console.log('\nBandcamp:');
syncBandcamp();

console.log('\nSignal:');
syncSignal();

console.log('\n✅ Sync complete.\n');

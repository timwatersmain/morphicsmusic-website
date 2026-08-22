#!/usr/bin/env node
/**
 * Poster frames for every video in src/data/videos.json.
 *
 * Why posters rather than a #t= media fragment (which is what the /social
 * cards use): Pages does not honour Range on these assets — a Range request
 * returns 200 with the whole body and there is no accept-ranges header — so a
 * seek cannot be served from the head of the file. The browser would have to
 * download the entire video to show one frame, and these total 40MB, the
 * largest being 15MB. A ~40KB JPEG is the same picture for 0.3% of the bytes.
 *
 * With a poster in place the markup also drops to preload="none", so a visit
 * to /visuals now fetches zero video bytes until someone actually plays one.
 *
 * Frame choice is `thumbnail`, not a fixed timestamp: it scores the first N
 * frames and picks the most representative, which sidesteps the black or
 * near-black intro these motion pieces tend to open on. A fixed -ss 0.1 gave
 * black frames for exactly that reason.
 *
 * Run after adding or replacing a video:  node scripts/generate-video-posters.mjs
 */
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/images/video-posters');
const raw = JSON.parse(readFileSync(join(ROOT, 'src/data/videos.json'), 'utf8'));
const videos = Array.isArray(raw) ? raw : raw.videos ?? [];

mkdirSync(OUT, { recursive: true });

let made = 0, skipped = 0, missing = [];
for (const v of videos) {
  if (!v.src) continue;
  const src = join(ROOT, 'public', v.src.replace(/^\//, ''));
  if (!existsSync(src)) { missing.push(v.src); continue; }
  const name = basename(v.src, extname(v.src)) + '.jpg';
  const dst = join(OUT, name);
  // Regenerate only when the source is newer, so this is cheap to re-run.
  if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) { skipped++; continue; }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
    '-vf', 'thumbnail=150,scale=720:-2', '-frames:v', '1', '-q:v', '5', dst]);
  made++;
  console.log(`  ${name}  ${(statSync(dst).size / 1024).toFixed(0)} KB`);
}
if (missing.length) {
  console.warn(`\n  WARNING: ${missing.length} video(s) in videos.json have no file on disk:`);
  for (const m of missing) console.warn(`    ${m}`);
}
console.log(`\n${made} poster(s) written, ${skipped} up to date, ${missing.length} missing source.`);

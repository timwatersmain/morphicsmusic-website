/**
 * generate-image-variants.mjs
 *
 * Emits responsive WebP variants next to each source image in public/images/,
 * as <name>-<width>.webp. The site references the variants; the originals stay
 * on disk untouched as the masters (and as the <picture> fallback for browsers
 * without WebP).
 *
 * Why variants are committed rather than built: Cloudflare Pages builds from
 * the repo, and this project's prebuild scripts read from paths that only exist
 * on Tim's machine, so anything the deploy needs has to already be in git —
 * exactly as the source images already are.
 *
 * Idempotent: a variant is rebuilt only when it is missing or older than its
 * source, so re-running after adding one release costs one image, not thirty.
 *
 * Usage: npm run images:optimize [-- --force]
 */
import sharp from 'sharp';
import { readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'public', 'images');
const FORCE = process.argv.includes('--force');
const PRUNE = process.argv.includes('--prune');

// Per-directory target widths, chosen from how the images are actually laid
// out rather than a generic ladder:
//   albums  — a 2/4/6-column grid (~240px cell at 1440px wide, so 480 covers
//             it at 2x) plus the Latest Release hero and the store detail page,
//             which want ~600px logical.
//   visuals — gallery tiles, larger on screen.
//   hero    — full-bleed banner.
const PLAN = {
  albums: [400, 800, 1200],
  visuals: [480, 960, 1600],
  hero: [800, 1600, 2400],
  plugins: [400, 800],
  digital: [400, 800],
  labs: [400, 800],
  signal: [400, 800],
  logos: [400, 800],
};

const SRC_EXT = new Set(['.jpg', '.jpeg', '.png']);
const isVariant = (name) => /-\d+\.webp$/.test(name);

let made = 0, skipped = 0, srcBytes = 0, outBytes = 0, pruned = 0;

for (const [dir, widths] of Object.entries(PLAN)) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  const entries = await readdir(abs);
  const sources = entries.filter((f) => SRC_EXT.has(extname(f).toLowerCase()));

  if (PRUNE) {
    const keep = new Set();
    for (const f of sources) for (const w of widths) keep.add(`${basename(f, extname(f))}-${w}.webp`);
    for (const f of entries.filter(isVariant)) {
      if (!keep.has(f)) { await unlink(join(abs, f)); pruned++; }
    }
  }

  for (const file of sources) {
    const src = join(abs, file);
    const meta = await sharp(src).metadata();
    const srcStat = await stat(src);
    srcBytes += srcStat.size;

    for (const w of widths) {
      // Never upscale: a 500px master gets no 1200px variant.
      if (meta.width && meta.width < w * 0.9) continue;
      const out = join(abs, `${basename(file, extname(file))}-${w}.webp`);
      if (!FORCE && existsSync(out)) {
        const o = await stat(out);
        if (o.mtimeMs >= srcStat.mtimeMs) { skipped++; outBytes += o.size; continue; }
      }
      await sharp(src)
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 82, effort: 5 })
        .toFile(out);
      outBytes += (await stat(out)).size;
      made++;
    }
  }
}

const mb = (b) => (b / 1e6).toFixed(1) + ' MB';
console.log(`variants: ${made} written, ${skipped} up to date${PRUNE ? `, ${pruned} pruned` : ''}`);
console.log(`sources ${mb(srcBytes)} -> variants ${mb(outBytes)}`);

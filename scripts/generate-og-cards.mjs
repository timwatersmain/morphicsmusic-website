#!/usr/bin/env node
/**
 * generate-og-cards.mjs — build the 1200x630 link-preview images.
 *
 *   node scripts/generate-og-cards.mjs [--only <slug>] [--force]
 *
 * WHY HEADLESS CHROME rather than an image library: the cards have to look
 * like the site, and the site's look is its two self-hosted faces (Rubik and
 * Geist Mono), its palette, and its type scale. Compositing with sharp or
 * Pillow means re-implementing all of that against woff2 files neither can
 * load. Rendering the real HTML gets it exactly right and makes the template
 * something you can open in a browser and edit.
 *
 * Cards are written to public/images/og/ and committed, NOT generated at
 * request time. An unfurler fetches og:image with no cookies, a short timeout,
 * and often no JavaScript — a card that has to be rendered on demand is a card
 * that sometimes is not there, and a preview that fails once is cached broken
 * by whoever asked.
 *
 * Existing files are skipped unless --force, so a run after adding one release
 * costs one render rather than twenty.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { card, FOOT_LINE } from './og-template.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(PUBLIC, 'images', 'og');
const SHELL = '/Users/morphics/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-x64/chrome-headless-shell';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const force = process.argv.includes('--force');

const catalog = JSON.parse(readFileSync(join(ROOT, 'src/data/music-catalog.json'), 'utf8'));

// One card per surface someone actually shares. Anything not listed falls back
// to the default card, which is the right outcome for a page nobody links to
// on purpose.
const jobs = [
  // The site card and every section share ONE design — the wordmark filled
  // with the macro photograph. A section is not a different brand, so it does
  // not get a different card; only the two lines of type change.
  { name: 'og-default', spec: { kind: 'wordmark' } },
  { name: 'og-music',   spec: { kind: 'wordmark', foot: `Audio · ${catalog.releases.length} releases` } },
  { name: 'og-visuals', spec: { kind: 'wordmark', foot: 'Visual · Motion & stills' } },
  { name: 'og-store',   spec: { kind: 'wordmark', foot: 'Store · Music, merch & tools' } },
  { name: 'og-events',  spec: { kind: 'wordmark', foot: 'Live · Shows & booking' } },
  { name: 'og-social',  spec: { kind: 'wordmark', foot: 'Community · Every platform' } },
  // Releases keep their own artwork. A record is the one thing on this site
  // where the specific object beats the brand mark.
  ...catalog.releases
    .filter(r => r.artwork)
    .map(r => ({
      name: `release-${r.slug}`,
      spec: {
        kind: 'release',
        title: r.title,
        kicker: `${(r.type || 'release').toUpperCase()} · ${r.track_count} track${r.track_count === 1 ? '' : 's'}`,
        art: r.artwork,
        blurb: r.release_date ? `Out ${r.release_date}` : null,
      },
    })),
].filter(j => !only || j.name.includes(only));

// A static server over public/ so the template's own font and artwork URLs
// resolve exactly as they do on the site — no path rewriting, no data URIs.
const MIME = { '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css' };
let pending = new Map();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (pending.has(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pending.get(url.pathname));
  }
  const p = join(PUBLIC, decodeURIComponent(url.pathname));
  if (!p.startsWith(PUBLIC) || !existsSync(p) || statSync(p).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});

const PORT = 4390 + (process.pid % 200);
await new Promise(r => server.listen(PORT, r));

const chrome = spawn(SHELL, [
  `--remote-debugging-port=${PORT + 1000}`, '--headless=new', '--disable-gpu',
  '--window-size=1200,630', '--hide-scrollbars', '--no-first-run',
  '--force-device-scale-factor=2',           // render at 2x, then downscale
  `--user-data-dir=/tmp/og-${PORT}`, 'about:blank',
], { stdio: 'ignore' });

function cleanup() { try { chrome.kill('SIGTERM'); } catch {} try { server.close(); } catch {} }
process.on('uncaughtException', e => { cleanup(); console.error(e.message); process.exit(1); });

let list;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 250));
  try {
    list = await (await fetch(`http://127.0.0.1:${PORT + 1000}/json/list`)).json();
    if (list.some(t => t.type === 'page')) break;
  } catch {}
}
const sock = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const waiting = new Map();
sock.onmessage = e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
await new Promise(r => (sock.onopen = r));
const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 2, mobile: false });

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

let made = 0, skipped = 0;
for (const job of jobs) {
  const dest = join(OUT, `${job.name}.jpg`);
  if (existsSync(dest) && !force) { skipped++; continue; }

  const path = `/__card_${job.name}.html`;
  pending.set(path, card(job.spec));
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${path}` });

  // Wait for the fonts AND the artwork. A card captured before either lands is
  // a card with fallback type or an empty square — and it would be written to
  // disk and committed looking exactly like a finished one.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `document.fonts.status === 'loaded' &&
        [...document.images].every(i => i.complete && i.naturalWidth > 0)`,
    });
    if (r.result?.result?.value === true) break;
  }
  await new Promise(r => setTimeout(r, 120));

  // Auto-fit the title. Length buckets were a guess and a bad one: at 84px
  // "PERCEPTION" fitted its line but ran to within a few pixels of the card
  // edge, past the safe margin that exists because some clients centre-crop.
  // Measuring is the only thing that actually knows — glyph widths are not
  // recoverable from a character count.
  await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const t = document.querySelector('.title');
      if (!t) return null;
      const box = t.parentElement;
      let size = parseFloat(getComputedStyle(t).fontSize);
      // scrollWidth/clientWidth of the TITLE, not of its parent: the parent's
      // clientWidth includes its padding, so comparing against it reported a
      // fit while the glyphs were visibly running past the card's safe margin.
      // Shrink until the longest line fits the column AND the block fits two
      // lines' worth of the box. 34px is the floor: below that the title is
      // unreadable at the size these are actually displayed, and a title that
      // long wants a different card, not smaller type.
      for (let i = 0; i < 60 && size > 34; i++) {
        const overflowsWidth = t.scrollWidth > t.clientWidth + 1;
        const overflowsHeight = t.getBoundingClientRect().height > box.clientHeight * 0.62;
        if (!overflowsWidth && !overflowsHeight) break;
        size -= 2;
        t.style.fontSize = size + 'px';
      }
      return { fitted: size, text: t.textContent.trim() };
    })()`,
  }).then(r => {
    const v = r.result?.result?.value;
    if (v && v.fitted) process.stdout.write(`    title fitted at ${v.fitted}px\n`);
  });

  // JPEG, not PNG: several unfurlers cap og:image around 1MB and a 2x PNG of
  // this blows past it. quality 88 keeps the type crisp at ~90-160KB.
  // scale 0.5 against a deviceScaleFactor of 2 lands EXACTLY 1200x630, which
  // is what og:image:width/height declare. Capturing at scale 1 wrote
  // 2400x1260 files whose dimensions contradicted the meta — some unfurlers
  // trust the declared size and mis-scale, and the files were 4x the bytes for
  // a card almost nobody sees above 600px. Rendering at 2x and downsampling
  // here keeps the type crisp without shipping the extra pixels.
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90,
    clip: { x: 0, y: 0, width: 1200, height: 630, scale: 0.5 } });
  writeFileSync(dest, Buffer.from(shot.result.data, 'base64'));
  pending.delete(path);
  made++;
  process.stdout.write(`  ${job.name}.jpg\n`);
}

console.log(`\n${made} card(s) written, ${skipped} already present (use --force to rebuild).`);
sock.close(); cleanup(); process.exit(0);

#!/usr/bin/env node
// Build the press kit: data -> HTML -> PDF.
//
// The whole point is single-sourcing. The one-sheet's show list, venue list
// and catalogue counts are read from the SAME src/data files the website
// renders from, so a PDF sent to a promoter can never quietly disagree with
// the page they land on. Update a show once; the site and both PDFs move.
//
//   node press-kit/build.mjs            build everything
//   node press-kit/build.mjs one-sheet  build one
//
// Requires Chrome (present on macOS by default). Output: public/downloads/.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/downloads');
const TMP = join(ROOT, 'press-kit/.build');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** file:// URL for an asset, so Chrome resolves it without a web server. */
export const asset = (rel) => 'file://' + join(ROOT, rel);

export function shell({ title, css, body }) {
  const kit = readFileSync(join(ROOT, 'press-kit/kit.css'), 'utf8')
    .replace('FONT_PATH', asset('public/fonts/Rubik-Variable.woff2'));
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${kit}</style>
<style>${css}</style>
</head><body>${body}</body></html>`;
}

export function renderPdf(name, html) {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const htmlPath = join(TMP, `${name}.html`);
  const pdfPath = join(OUT, `${name}.pdf`);
  writeFileSync(htmlPath, html);

  if (!existsSync(CHROME)) {
    console.error(`  ! Chrome not found at ${CHROME} — wrote HTML only`);
    return null;
  }
  execFileSync(CHROME, [
    '--headless',
    '--disable-gpu',
    // Local file:// assets (the font, the logo) are cross-origin to the
    // temp HTML without this, and silently fail to load — which shows up as
    // a PDF set in Times New Roman with no logo.
    '--allow-file-access-from-files',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ], { stdio: 'pipe', timeout: 60000 });

  const size = readFileSync(pdfPath).length;
  console.log(`  ${name}.pdf — ${(size / 1024).toFixed(0)} KB`);
  return pdfPath;
}

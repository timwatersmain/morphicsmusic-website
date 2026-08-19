#!/usr/bin/env node
// Reissue the press kit. Run after editing src/data/epk.json or
// src/data/events.json — both PDFs read from those, which is what keeps the
// documents, the website and each other in step.
//
//   node press-kit/build-all.mjs
//
// Images are prepared separately and only need rerunning if the source
// photography changes:
//   python3 press-kit/make-hero.py        hue-rotated macro heroes
//   python3 press-kit/make-composite.py   the three-silhouette curtain
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
console.log('Building Morphics press kit…');
for (const doc of ['one-sheet.mjs', 'rider.mjs']) {
  execFileSync(process.execPath, [join(HERE, doc)], { stdio: 'inherit' });
}
console.log('→ public/downloads/');

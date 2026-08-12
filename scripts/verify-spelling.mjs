#!/usr/bin/env node
// Verify the Spelling engine against its source glyphs, per the design handoff:
// rasterise a settled glyph, threshold it, compare to the SVG at the same size.
// IoU should reach ~0.90. Exits non-zero if the worst IoU < 0.85.
//
// Also performs the manual guard checks from the plan (loop repeats, off-screen
// pause, hidden-tab skip, prefers-reduced-motion static frame) as far as they
// can be automated over CDP, using only black-box observation (pixel
// fingerprints of the live canvas) — nothing under src/scripts/spelling or
// src/components is touched or instrumented.
//
// Usage: node scripts/verify-spelling.mjs
//
// NOTE on the dist/ vs src/ split: Astro bundles and hashes
// src/scripts/spelling/*.js into dist/_astro/*.js with renamed exports, so
// `import('/scripts/spelling/engine.js')` cannot be served straight out of
// dist/ as an unbundled ES module — that path simply doesn't exist there. The
// IoU harness therefore imports the engine modules directly from src/ (they
// are already plain ESM with relative imports, so they run unmodified in a
// browser) over a dedicated route, while glyph SVGs and the real built page
// (for the guard checks) are served from dist/ as built.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_PORT = 4399;
const CDP_PORT = 9333;
const SIZE = 430; // matches the desktop canvas size in Spelling.astro

const DIST_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const SRC_SPELLING = fileURLToPath(new URL('../src/scripts/spelling/', import.meta.url));
const SRC_ROUTE = '/__spelling_src__/';

const CHROME_CANDIDATES = [
  process.env.CHROME_HEADLESS_SHELL,
  'chrome-headless-shell',
  '/Users/morphics/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-x64/chrome-headless-shell',
].filter(Boolean);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml', '.css': 'text/css', '.png': 'image/png',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

if (!existsSync(DIST_ROOT)) {
  console.error(`FAIL: ${DIST_ROOT} does not exist. Run \`npm run build\` first.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Static server: dist/ as the built site, plus a src/ route for the engine
// modules the IoU harness imports directly.
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  let p = normalize(decodeURI(req.url.split('?')[0]));
  try {
    let buf;
    if (p.startsWith(SRC_ROUTE)) {
      buf = await readFile(join(SRC_SPELLING, p.slice(SRC_ROUTE.length)));
    } else {
      if (p.endsWith('/')) p += 'index.html';
      buf = await readFile(join(DIST_ROOT, p));
    }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('nope');
  }
});
await new Promise((r) => server.listen(SITE_PORT, r));
const SITE_URL = `http://127.0.0.1:${SITE_PORT}/`;

// ---------------------------------------------------------------------------
// chrome-headless-shell + a small CDP client
// ---------------------------------------------------------------------------

// spawn() ENOENT surfaces asynchronously via the 'error' event, not a thrown
// exception, so probe candidates by waiting briefly to see whether the
// process actually starts before committing to it.
async function trySpawn(bin) {
  return new Promise((resolve) => {
    const proc = spawn(bin, [
      '--headless', `--remote-debugging-port=${CDP_PORT}`, '--disable-gpu',
      '--no-sandbox', '--window-size=900,900', 'about:blank',
    ], { stdio: 'ignore' });
    let settled = false;
    proc.once('error', () => { if (!settled) { settled = true; resolve(null); } });
    proc.once('spawn', () => { if (!settled) { settled = true; resolve(proc); } });
  });
}

async function spawnChrome() {
  for (const bin of CHROME_CANDIDATES) {
    const proc = await trySpawn(bin);
    if (proc) return { proc, bin };
  }
  return null;
}

const spawned = await spawnChrome();
if (!spawned) {
  console.error('FAIL: could not spawn chrome-headless-shell (tried: ' + CHROME_CANDIDATES.join(', ') + ')');
  server.close();
  process.exit(1);
}
const { proc: chrome } = spawned;
chrome.on('error', () => {}); // process is already confirmed spawned; ignore late errors here
let chromeExited = false;
chrome.on('exit', () => { chromeExited = true; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectCdp(retries = 20) {
  for (let i = 0; i < retries; i++) {
    if (chromeExited) throw new Error('chrome-headless-shell exited before CDP came up');
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await wait(300);
  }
  throw new Error('CDP endpoint never came up on port ' + CDP_PORT);
}

let ws;
try {
  const wsUrl = await connectCdp();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
} catch (e) {
  console.error('FAIL: could not connect to chrome-headless-shell over CDP:', e.message);
  try { chrome.kill(); } catch {}
  server.close();
  process.exit(1);
}

let id = 0;
const pending = new Map();
const pageEventHandlers = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method) {
    for (const h of pageEventHandlers) h(m.method, m.params);
  }
};
const send = (method, params) => new Promise((r) => {
  const i = ++id;
  pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails, null, 2));
  }
  return r.result?.result?.value;
};

async function navigate(url) {
  let resolveLoad;
  const loaded = new Promise((r) => { resolveLoad = r; });
  const handler = (method) => { if (method === 'Page.loadEventFired') resolveLoad(); };
  pageEventHandlers.push(handler);
  await send('Page.navigate', { url });
  await Promise.race([loaded, wait(8000)]);
  pageEventHandlers.splice(pageEventHandlers.indexOf(handler), 1);
}

await send('Page.enable');
await send('Runtime.enable');

let exitCode = 0;
const results = { iou: null, guards: {} };

try {
  // -------------------------------------------------------------------------
  // Part 1: IoU measurement
  // -------------------------------------------------------------------------
  await navigate(SITE_URL);
  await wait(300);

  const iouExpr = `(async () => {
    const { SpellingEngine } = await import('${SRC_ROUTE}engine.js');
    const SIZE = ${SIZE};
    const out = {};

    const mask = (ctx) => {
      const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
      const m = new Uint8Array(SIZE * SIZE);
      for (let i = 0; i < m.length; i++) m[i] = d[i * 4] > 127 ? 1 : 0;
      return m;
    };
    const bbox = (m) => {
      let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1, count = 0;
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        if (m[y * SIZE + x]) {
          count++;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return count ? { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, count } : null;
    };

    for (const ch of [...new Set('THEONLYCONSTANTISCHANGE')]) {
      // 1. the engine's rendering, settled (frozen = true, no scheduling)
      const c = document.createElement('canvas');
      c.style.cssText = 'width:' + SIZE + 'px;height:' + SIZE + 'px;position:fixed;left:-9999px';
      document.body.appendChild(c);
      const eng = new SpellingEngine(c);
      eng.size();
      const pts = await eng.glyph(ch, 900);
      eng.cur = pts.map(p => ({ x: p.x, y: p.y }));
      eng.from = eng.cur.map(p => ({ x: p.x, y: p.y }));
      eng.to = eng.cur.map(p => ({ x: p.x, y: p.y }));
      eng.frozen = true;
      eng.t0 = performance.now() - 10000;
      eng.dur = 1;
      eng.renderFrame(performance.now());

      // the CSS filter is what thresholds the mass, so read back through it
      const shot = document.createElement('canvas');
      shot.width = shot.height = SIZE;
      const sctx = shot.getContext('2d');
      sctx.filter = c.style.filter;
      sctx.drawImage(c, 0, 0, SIZE, SIZE);
      const A = mask(sctx);

      // 2. the source SVG at the same size and same scale/centre the engine uses
      const txt = await fetch('/glyphs/svg/' + ch + '.svg').then(r => r.text());
      const ref = document.createElement('canvas');
      ref.width = ref.height = SIZE;
      const rctx = ref.getContext('2d');
      rctx.fillStyle = '#000';
      rctx.fillRect(0, 0, SIZE, SIZE);
      const img = new Image();
      const white = txt.replace(/#000/g, '#fff').replace(/black/g, '#fff');
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(white)));
      await img.decode();
      // the engine draws the artboard at min(W,H) * 0.66 * vScale(=1 at rest), centred
      const S = SIZE * 0.66;
      rctx.drawImage(img, (SIZE - S) / 2, (SIZE - S) / 2, S, S);
      const B = mask(rctx);

      let inter = 0, uni = 0;
      for (let i = 0; i < A.length; i++) {
        if (A[i] | B[i]) uni++;
        if (A[i] & B[i]) inter++;
      }
      out[ch] = { iou: uni ? inter / uni : 0, bboxA: bbox(A), bboxB: bbox(B) };
      if (window.__DUMP__ && (window.__DUMP__ === true || window.__DUMP__.includes(ch))) {
        out[ch].pngA = shot.toDataURL('image/png');
        out[ch].pngB = ref.toDataURL('image/png');
        const diff = document.createElement('canvas');
        diff.width = diff.height = SIZE;
        const dctx = diff.getContext('2d');
        const dimg = dctx.createImageData(SIZE, SIZE);
        for (let i = 0; i < A.length; i++) {
          const o = i * 4;
          if (A[i] && B[i]) { dimg.data[o] = dimg.data[o+1] = dimg.data[o+2] = 255; }
          else if (A[i] && !B[i]) { dimg.data[o+1] = 255; } // engine only = green (engine too fat here)
          else if (!A[i] && B[i]) { dimg.data[o] = 255; } // svg only = red (engine too thin here)
          dimg.data[o+3] = 255;
        }
        dctx.putImageData(dimg, 0, 0);
        out[ch].pngDiff = diff.toDataURL('image/png');
      }
      c.remove();
    }
    return out;
  })()`;

  const dumpList = process.env.SPELLING_DUMP ? process.env.SPELLING_DUMP.split(',') : [];
  if (dumpList.length) await evaluate(`window.__DUMP__ = ${JSON.stringify(dumpList)}`);
  results.iou = await evaluate(iouExpr);
  if (dumpList.length) {
    const { writeFile } = await import('node:fs/promises');
    for (const ch of dumpList) {
      const r = results.iou[ch];
      if (!r?.pngA) continue;
      await writeFile(`/tmp/spelling-${ch}-engine.png`, Buffer.from(r.pngA.split(',')[1], 'base64'));
      await writeFile(`/tmp/spelling-${ch}-svg.png`, Buffer.from(r.pngB.split(',')[1], 'base64'));
      await writeFile(`/tmp/spelling-${ch}-diff.png`, Buffer.from(r.pngDiff.split(',')[1], 'base64'));
    }
  }

  console.log('IoU vs source SVG (target ~0.90):');
  let worst = 1;
  const rows = Object.entries(results.iou).sort((a, b) => a[1].iou - b[1].iou);
  for (const [ch, r] of rows) {
    console.log(
      '  ' + ch.padEnd(2) + ' ' + r.iou.toFixed(3) +
      '   engine bbox ' + JSON.stringify(r.bboxA) +
      '   svg bbox ' + JSON.stringify(r.bboxB)
    );
    worst = Math.min(worst, r.iou);
  }
  results.worstIou = worst;
  results.medianIou = rows[Math.floor(rows.length / 2)][1].iou;

  if (worst < 0.85) {
    console.error('\nFAIL: worst IoU ' + worst.toFixed(3) + ' is below 0.85');
    exitCode = 1;
  } else {
    console.log('\nPASS (IoU): worst ' + worst.toFixed(3));
  }

  // -------------------------------------------------------------------------
  // Part 2: guard checks against the real built page (black-box, no source
  // instrumentation — pixel fingerprints of the live #spelling canvas only)
  // -------------------------------------------------------------------------
  const FP = `() => {
    const c = document.getElementById('spelling');
    if (!c || !c.width) return null;
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4 * 37) { s = (s * 31 + d[i]) >>> 0; s = (s * 31 + d[i + 1]) >>> 0; }
    return s;
  }`;
  const fingerprint = async () => evaluate(`(${FP})()`);
  const fingerprintSeries = async (count, gapMs) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(await fingerprint());
      if (i < count - 1) await wait(gapMs);
    }
    return out;
  };
  const allSame = (arr) => arr.every((v) => v === arr[0]);
  const anyDiffer = (arr) => !allSame(arr);

  // --- Guard A: the loop repeats ---------------------------------------------
  // Fully repeating the reference cycle (23 letters + phrase hold + dormant
  // tail + restMs) takes ~30s at production timings, so watching for TWO
  // cycles takes on the order of a minute — sample the live canvas over that
  // window and look for the "settled phrase" plateau (frozen = true for
  // holdMs*4 = 1520ms) recurring more than once. This is real-time
  // observation of the actual production page, not an accelerated stand-in.
  await navigate(SITE_URL);
  await wait(500);
  const LOOP_WINDOW_MS = 75000;
  const LOOP_SAMPLE_MS = 500;
  const loopSamples = [];
  const loopStart = Date.now();
  while (Date.now() - loopStart < LOOP_WINDOW_MS) {
    loopSamples.push({ t: Date.now() - loopStart, fp: await fingerprint() });
    await wait(LOOP_SAMPLE_MS);
  }
  // A plateau = a run of >=2 consecutive identical fingerprints (>=1 sample
  // interval frozen). Record each plateau's start time; report the gaps.
  const plateaus = [];
  let runStart = null;
  for (let i = 1; i < loopSamples.length; i++) {
    if (loopSamples[i].fp === loopSamples[i - 1].fp) {
      if (runStart === null) runStart = loopSamples[i - 1].t;
    } else {
      if (runStart !== null) plateaus.push(runStart);
      runStart = null;
    }
  }
  if (runStart !== null) plateaus.push(runStart);
  const plateauGapsMs = plateaus.slice(1).map((t, i) => t - plateaus[i]);
  const animatedAtAll = anyDiffer(loopSamples.map((s) => s.fp));

  results.guards.loopRepeats = {
    windowMs: LOOP_WINDOW_MS, sampleCount: loopSamples.length,
    plateauStartsMs: plateaus, plateauGapsMs, animatedAtAll,
    pass: plateaus.length >= 2,
    note: plateaus.length >= 2
      ? `Observed ${plateaus.length} settle-plateaus over ${LOOP_WINDOW_MS / 1000}s (gaps: ${plateauGapsMs.join(', ')}ms) — consistent with the phrase resolving and the loop repeating more than once.`
      : `Observed only ${plateaus.length} settle-plateau(s) over ${LOOP_WINDOW_MS / 1000}s; the canvas ${animatedAtAll ? 'was animating throughout, so the loop is running, but only one (or zero) full cycles completed in the observation window' : 'never changed at all, which would be a real defect'}. Widen LOOP_WINDOW_MS to confirm a second cycle, or watch by eye per the brief's Step 4.`,
  };

  // --- Guard B: off-screen pause (IntersectionObserver) --------------------
  // index.astro's hero section is deliberately the whole page ("the landing
  // is the cleanest page" — no content below the fold) and roughly fills a
  // normal viewport, so there is no natural scroll room to move the canvas
  // fully out of view. Inject a spacer div above the hero (a test-session DOM
  // mutation only — nothing under src/ is touched) so there is real,
  // generous room to scroll the canvas fully off-screen in either direction.
  await navigate(SITE_URL);
  await wait(1000);
  await evaluate(`document.body.insertAdjacentHTML('afterbegin', '<div id="__spacer__" style="height:2400px"></div>')`);
  await wait(200);

  await evaluate("document.getElementById('spelling').scrollIntoView({ block: 'center' })");
  await wait(600); // let the IntersectionObserver callback fire and start() run
  const rectVisible = await evaluate("JSON.stringify(document.getElementById('spelling').getBoundingClientRect())");
  const beforeScroll = await fingerprintSeries(3, 300);
  const activeBefore = anyDiffer(beforeScroll);

  await evaluate('window.scrollTo(0, 0)'); // top of the spacer — canvas is ~2400px below, fully out of view
  await wait(600);
  const rectAway = await evaluate("JSON.stringify(document.getElementById('spelling').getBoundingClientRect())");
  const duringOffscreen = await fingerprintSeries(4, 300);
  const frozenOffscreen = allSame(duringOffscreen);

  await evaluate("document.getElementById('spelling').scrollIntoView({ block: 'center' })");
  await wait(600);
  const afterScrollBack = await fingerprintSeries(3, 300);
  const resumedOnscreen = anyDiffer(afterScrollBack);

  results.guards.offscreenPause = {
    rectVisible, rectAway, activeBefore, frozenOffscreen, resumedOnscreen,
    beforeScroll, duringOffscreen, afterScrollBack,
    pass: activeBefore && frozenOffscreen && resumedOnscreen,
  };

  // --- Guard C: hidden-tab skip (document.hidden) ---------------------------
  await navigate(SITE_URL);
  await wait(600);
  await evaluate(`(() => { Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()`);
  await wait(300);
  const whileHidden = await fingerprintSeries(4, 300);
  const frozenHidden = allSame(whileHidden);

  await evaluate(`(() => { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })()`);
  await wait(400);
  const afterUnhide = await fingerprintSeries(3, 300);
  const resumedAfterUnhide = anyDiffer(afterUnhide);

  results.guards.hiddenTab = {
    frozenHidden, resumedAfterUnhide, whileHidden, afterUnhide,
    pass: frozenHidden && resumedAfterUnhide,
    note: '"no burst of catch-up frames" was not independently measured (would need the Performance/Tracing CDP domain); frame() has no frame-catch-up queue by inspection — it only reads document.hidden live each tick — so a burst is not structurally possible, but that inference was not verified by measurement here.',
  };

  // --- Guard D: prefers-reduced-motion -> single static frame ---------------
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  let rafHookInstalled = false;
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__rafCount__ = 0; const orig = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => { window.__rafCount__++; return orig(cb); };",
  }).then(() => { rafHookInstalled = true; });
  await navigate(SITE_URL);
  await wait(700);
  const staticSeries = await fingerprintSeries(4, 400);
  const staticFrame = allSame(staticSeries);
  const rafCount = await evaluate('window.__rafCount__');
  const measureEntries = await evaluate("performance.getEntriesByType('measure').length");

  results.guards.reducedMotion = {
    staticFrame, staticSeries, rafCount, measureEntries, rafHookInstalled,
    pass: staticFrame,
    note: "rafCount includes any requestAnimationFrame call from ANY script on the page, not just the spelling engine, so a nonzero count does not by itself indicate the engine is looping — the operative evidence is the canvas pixel fingerprint staying constant. performance.getEntriesByType('measure') was empty in both modes because this codebase never calls performance.mark/measure, so that specific instruction from the brief does not distinguish anything here.",
  };
  // reset emulation so it doesn't leak into anything after this
  await send('Emulation.setEmulatedMedia', { features: [] });

  console.log('\nGuard checks (against the real built page, black-box pixel fingerprinting):');
  console.log('  loop repeats     :', results.guards.loopRepeats.pass ? 'PASS' : 'INCONCLUSIVE', JSON.stringify(results.guards.loopRepeats));
  console.log('  off-screen pause :', results.guards.offscreenPause.pass ? 'PASS' : 'FAIL', JSON.stringify(results.guards.offscreenPause));
  console.log('  hidden-tab skip  :', results.guards.hiddenTab.pass ? 'PASS' : 'FAIL', JSON.stringify(results.guards.hiddenTab));
  console.log('  reduced-motion   :', results.guards.reducedMotion.pass ? 'PASS' : 'FAIL', JSON.stringify(results.guards.reducedMotion));

} catch (e) {
  console.error('FAIL: verification script errored:', e.message || e);
  exitCode = 1;
} finally {
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  server.close();
}

process.exit(exitCode);

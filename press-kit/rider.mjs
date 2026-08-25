// Performance & Technical Rider — three pages.
//
// THE WORDS ARE NOT IN THIS FILE. Every sentence, bullet, table row and tick
// box lives in src/data/rider.json — edit that, run `node press-kit/build-all.mjs`,
// and the PDF is reissued. This file is only the layout: the three-page print
// shell around the shared renderer in src/lib/rider/render.mjs, plus the CSS.
// That split is the point — a rider gets edited on the day a promoter asks a
// question, and nobody should have to open a build script to change "hot meal"
// to "meal".
//
// Was five pages, then two. Three sits between them — but only because the
// extra page is spent on something that wanted it: the stage plot, which at
// two pages was squeezed under a spec table at a size a production manager
// would squint at. It now has a page, at nearly double the width, with the
// per-format signal path beside it. Type is a touch larger throughout for
// the same reason: this document gets read on a phone backstage.
//
// The rule that keeps this honest — no page may be half empty. Three pages
// of padded content looked worse than five.
//
// Order follows what a promoter needs, in the order they need it: what the
// show IS, what the room must provide, then the terms.

import { read, esc, asset, shell, renderPdf } from './build.mjs';
import { stagePlot } from './stage-plot.mjs';
import {
  riderContext, inline, renderTable, renderSection, renderSections,
} from '../src/lib/rider/render.mjs';
import { validateRider } from '../src/lib/rider/schema.mjs';

const epk = read('src/data/epk.json');
const mgmt = epk.management || {};
const R = read('src/data/rider.json');

/* A hand edit that breaks the structure — a table row with a missing cell, a
   block that is neither a paragraph nor a list — does not fail loudly on its
   own. It prints: a torn table in a document that goes to a promoter. So the
   build refuses instead, naming the field. */
const check = validateRider(R);
if (!check.ok) {
  console.error('src/data/rider.json is not a valid rider:');
  for (const problem of check.errors) console.error(`  ${problem.path || 'document'} ${problem.message}`);
  process.exit(1);
}

const UPDATED = R.updated;
const A = '#3df082';

/* ---- content rendering -------------------------------------------------
   The walk over the document — marks, tables, blocks, section numbering —
   lives in src/lib/rider/render.mjs, because the live page at /rider and the
   editor preview render the same document and must not drift from the PDF.
   What stays here is only the print shell: three pages, the band, the stage
   plot and the footers. */
const ctx = riderContext(R, mgmt);
const t = (s) => inline(s, ctx);
const table = (tb) => renderTable(tb, ctx);
const section = (s, attrs = '') => renderSection(s, ctx, attrs);
const sections = (list, attrs) => renderSections(list, ctx, attrs);

const css = `
.page { background:#000; color:#fff; padding:0; position:relative; }
.inner { padding:11mm 16mm 13mm; }

/* Header band, not a cover page. */
.band { position:relative; height:66mm; overflow:hidden }
.band img { width:100%; height:100%; object-fit:cover; display:block }
.band::after { content:''; position:absolute; left:0; right:0; top:0; bottom:-2mm;
  background:
    linear-gradient(270deg,rgba(0,0,0,.82) 0%,rgba(0,0,0,.45) 26%,rgba(0,0,0,0) 52%),
    linear-gradient(180deg,rgba(0,0,0,.2),rgba(0,0,0,.6) 55%,#000 90%,#000 100%) }
.band .mk { position:absolute; left:16mm; bottom:14mm; width:84mm; height:auto; z-index:2 }
.band .ttl { position:absolute; left:16mm; bottom:5.5mm; z-index:2; font-size:11pt;
  font-weight:700; letter-spacing:-.01em }
.band .ttl em { font-style:normal; color:${A} }
.band .meta { position:absolute; right:16mm; bottom:6mm; z-index:2; text-align:right;
  font-size:6.8pt; color:#c4c4c4; line-height:1.8 }
.band .meta b { color:#fff; font-weight:700 }
.band .meta a { color:${A} }

.head { display:flex; justify-content:space-between; align-items:baseline;
  border-bottom:1px solid #fff; padding-bottom:3mm; margin-bottom:6mm }
.head .t { font-size:13pt; font-weight:700; letter-spacing:-.015em }
.k { font-size:6.2pt; font-weight:700; letter-spacing:.2em; text-transform:uppercase; color:#6f6f6f }

h2 { font-size:9.6pt; margin:5.4mm 0 2.2mm; font-weight:700 }
h2:first-of-type { margin-top:0 }
h2 .n { color:${A}; margin-right:2mm }
p, li { font-size:8.3pt; line-height:1.48; color:#cfcfcf }
p { margin:0 0 2mm }
b { color:#fff; font-weight:700 }
ul { margin:0 0 2.5mm; padding-left:4mm }
li { margin-bottom:.9mm }
li::marker { color:${A} }

table { width:100%; border-collapse:collapse; margin:1.5mm 0 3mm }
th, td { text-align:left; padding:2.2mm 2.4mm; font-size:8pt; vertical-align:top;
  border-bottom:1px solid #1a1a1a; color:#cfcfcf }
th { font-size:6.2pt; letter-spacing:.16em; text-transform:uppercase; color:#8a8a8a;
  border-bottom:1px solid #fff }
td.f { color:#fff; font-weight:700; width:30mm }
td.q { width:17mm; font-weight:700; font-variant-numeric:tabular-nums; color:#fff }
tr.key td { background:#0d1a08 }

.note { border-left:2px solid ${A}; background:#0b0b0b; padding:3.2mm 4mm;
  margin:4mm 0; font-size:7.9pt; color:#cfcfcf }

/* The terms page reads as a list, so two columns fit it on one page and
   shorten every line into something scannable. */
.two { column-count:2; column-gap:9mm }
.two h2 { break-after:avoid }
.two > *:first-child { margin-top:0 }

.chk { column-count:2; column-gap:9mm; margin:1mm 0 0 }
.ck { display:flex; gap:2.5mm; align-items:flex-start; font-size:8pt; color:#cfcfcf;
  margin-bottom:2.2mm; break-inside:avoid }
.ck span { flex:0 0 3mm; height:3mm; border:1px solid #4a4a4a; margin-top:.6mm }
.sign { display:grid; grid-template-columns:1fr 1fr 34mm; gap:7mm; margin-top:9mm }
.sign .ln { border-bottom:1px solid #555; height:9mm }
.sign .sl { font-size:6.2pt; color:#6f6f6f; margin-top:1.4mm }

.foot { position:absolute; left:16mm; right:16mm; bottom:7mm;
  border-top:1px solid #1a1a1a; padding-top:2.2mm; display:flex;
  justify-content:space-between; font-size:6.2pt; color:#6f6f6f }
`;

const foot = (n) =>
  `<div class="foot"><span>${t(R.footer)}</span><span>${n} / 3</span></div>`;

const body = `
<div class="page">
  <div class="band">
    <img src="${asset('public/images/press/hero/r2-stack3.jpg')}" alt="">
    <img class="mk" data-mark src="${asset('public/images/logos/morphics-text-white.png')}" alt="Morphics">
    <div class="ttl">${t(R.coverTitle)}</div>
    <div class="meta">
      ${t(R.coverStrap)}<br>
      <b>${esc(mgmt.contact || '')}</b> · ${esc(mgmt.company || '')}<br>
      <a>${esc(mgmt.email || '')}</a>
    </div>
  </div>

  <div class="inner">
    <p>${t(R.page1.intro)}</p>

    ${table(R.page1.formats)}

    <div class="note">${t(R.page1.note)}</div>
${sections(R.page1.sections)}
  </div>
  ${foot(1)}
</div>

<div class="page">
  <div class="inner">
    <div class="head"><div class="t">${t(R.page2.title)}</div>
      <div class="k">Morphics · Rider ${UPDATED}</div></div>

    <p>${t(R.page2.intro)}</p>

    <div style="margin:5mm 0 2mm">${stagePlot(A)}</div>
${sections(R.page2.sections)}
  </div>
  ${foot(2)}
</div>

<div class="page">
  <div class="inner">
    <div class="head"><div class="t">${t(R.page3.title)}</div>
      <div class="k">Morphics · Rider ${UPDATED}</div></div>

    <div class="two">
${sections(R.page3.sections)}
    </div>

    <div class="note" style="margin-top:5mm">${t(R.page3.closingNote)}</div>
${section(R.page3.confirm, ' style="margin-top:7mm"')}

    <div class="sign">
      ${R.page3.signature.map(s => `<div><div class="k">${t(s.label)}</div><div class="ln"></div>
        <div class="sl">${s.under ? t(s.under) : '&nbsp;'}</div></div>`).join('\n      ')}
    </div>
  </div>
  ${foot(3)}
</div>
`;

renderPdf('morphics-rider', shell({ title: 'Morphics — Performance & Technical Rider', css, body }));

// The chosen one-sheet. Was selected from a long comparison run — the
// variants that lost are in git history, not in the build.
// Five subtle variations on G — the layout the owner picked. Same skeleton
// throughout: macro hero fading into black, A's flowing pitch, format tags,
// figures, two columns, curtain composite, footer. What moves is the artwork,
// the accent's exact green, and one structural detail each, so the comparison
// is fine-grained rather than five different documents.
import { esc, asset, shell, renderPdf } from './build.mjs';
import * as D from './data.mjs';

const mark = asset('public/images/logos/morphics-text-white.png');
const curtain = asset('public/images/press/morphics-composite.jpg');
const contact = `${esc(D.mgmt.contact || 'Morphics')}${D.mgmt.company ? ' · ' + esc(D.mgmt.company) : ''}`;
const email = esc(D.mgmt.email || 'morphicsmusic@gmail.com');

// Rooms played, taken from the show history but CURATED. D.venues is derived
// straight from events.json, so alongside real rooms it carries a street
// address, a private farm and a bare city name — entries that are accurate
// records of a gig but read, on a document handed to a talent buyer, as
// padding. Dropping them makes the list shorter and stronger. Anything not
// named here still counts in the show history; it just does not get printed.
const NOT_A_ROOM = new Set([
  '216 Westhampton Blvd',   // a street address
  'Camp grounds',           // not a venue name at all
  'River Farm Recreation',  // private property
  'Tracy City',             // a town, not a room
]);
const roomList = D.venues.filter(v => !NOT_A_ROOM.has(v));

// The blue set: artwork left in its OWN colour, not rotated. B1 pairs it
// with the green accent (complementary, so the type pops off the image);
// B2 pulls the accent out of the photograph itself (#3fa9ff, hue 207°) for
// a single-temperature page. Same layout throughout.
// The chosen direction. Hero is the 5120x2880 ORIGINAL of the macro that was
// only on the site at 1200x675 — 18x the pixels — rotated 35° toward green
// and lifted 22% in saturation.
const variants = [
  { id: 'B3', out: 'morphics-one-sheet', hero: 'b3-macro-4k', accent: '#3df082',
    heroH: 78, glyph: true, rule: false, note: 'the chosen one-sheet' },
];

for (const v of variants) {
  const A = v.accent;
  const css = `
  .page{background:#000;color:#fff;position:relative;overflow:hidden;
        display:flex;flex-direction:column;padding:0}
  .hero{position:relative;height:${v.heroH}mm;overflow:hidden;flex-shrink:0}
  .hero img{width:100%;height:100%;object-fit:cover;display:block}
  .hero::after{content:'';position:absolute;left:0;right:0;top:0;bottom:-2mm;
    background:linear-gradient(180deg,rgba(0,0,0,.12) 0%,rgba(0,0,0,.5) 52%,#000 88%,#000 100%)}
  .hero .mk{position:absolute;${v.id === 'G4'
      ? 'left:50%;transform:translateX(-50%);width:104mm;bottom:9mm'
      : 'left:18mm;width:88mm;bottom:9mm'};z-index:2;height:auto}
  .hero .tag{position:absolute;right:18mm;bottom:10mm;z-index:2;text-align:right;
    font-size:7pt;letter-spacing:.16em;text-transform:uppercase;color:#c8c8c8;line-height:1.9}
  .hero .tag b{color:${A};font-weight:700}
  ${v.rule ? `.arule{height:2px;background:${A};flex-shrink:0}` : ''}
  .wrap{padding:9mm 18mm 14mm;flex:1;display:flex;flex-direction:column}
  ${v.glyph ? `.glyph{position:absolute;right:-30mm;top:${v.heroH + 20}mm;width:128mm;opacity:.2}
  .glyph img{width:100%;display:block}` : ''}
  .pitch{font-size:${v.id === 'G5' ? 14 : 15}pt;line-height:1.32;font-weight:500;
    letter-spacing:-.015em;max-width:150mm;margin:0}
  .pitch em{font-style:normal;color:${A}}
  .fmt{display:flex;gap:2.5mm;margin:7mm 0 0}
  .fmt span{border:1px solid #333;padding:1.8mm 4.5mm;font-size:7pt;font-weight:700;
    letter-spacing:.16em;text-transform:uppercase;color:#e4e4e4}
  .fmt span b{color:${A}}
  /* The old layout led with a five-figure strip (shows / active / states /
     festivals / releases) over a DATED "Recent shows" list. Both are removed.
     A span reading "2018-24" next to a most-recent date of Dec 2024 states,
     in the largest type on the page, that nothing has happened in two years —
     the one thing a one-sheet must never say. The credentials that actually
     sell the act carry no timestamp at all: who the bills were shared with,
     and which rooms were played. Those now lead instead, and neither goes
     stale sitting in a promoter's inbox. */
  .block{margin:8mm 0 0}
  .h{font-size:6.5pt;font-weight:700;letter-spacing:.2em;text-transform:uppercase;
    color:${A};display:block;margin-bottom:3mm}
  .bills{font-size:9.5pt;line-height:1.72;color:#e8e8e8;margin:0;max-width:170mm}
  .bills b{color:#fff;font-weight:600}
  .rooms{list-style:none;margin:0;padding:0;font-size:7.6pt;color:#c4c4c4;
    columns:4;column-gap:8mm}
  .rooms li{padding:1.15mm 0;break-inside:avoid;border-bottom:1px solid #141414}
  .band{margin:8mm 0 0}
  .band img{width:100%;height:auto;display:block}
  .foot{margin-top:auto;border-top:1px solid #fff;padding-top:5mm;
    display:flex;justify-content:space-between;align-items:flex-end}
  .k{font-size:6.5pt;letter-spacing:.2em;text-transform:uppercase;color:#6e6e6e}
  .foot .nm{font-size:10.5pt;font-weight:700;margin-top:1.2mm}
  .foot .em{font-size:9.5pt;color:${A};margin-top:.6mm}
  .foot .r{text-align:right;font-size:7.5pt;color:#8a8a8a;line-height:1.6}
  .foot .r b{color:#fff;font-weight:500}`;

  const body = `
  <div class="page">
    <div class="hero">
      <img src="${asset(`public/images/press/hero/${v.hero}.jpg`)}" alt="">
      <img class="mk" data-mark src="${mark}" alt="Morphics">
      ${v.id === 'G4' ? '' : `<div class="tag">Experimental audiovisual<br>Baltimore, MD<br><b>morphicsmusic.com</b></div>`}
    </div>
    ${v.rule ? '<div class="arule"></div>' : ''}
    ${v.glyph ? `<div class="glyph"><img src="${asset('public/images/brand/Abstract/abstract-c.png')}" alt=""></div>` : ''}
    <div class="wrap">
      <p class="pitch">Music driven by the dramatic changes in life, and a style that is
        <em>ever evolving</em> — fusing elements from every genre into a listening or live
        experience built fresh each time.</p>
      <div class="fmt"><span><b>Live A/V</b></span><span><b>Live — Ableton</b></span><span><b>DJ set</b></span></div>
      <div class="block">
        <span class="h">Shared bills</span>
        <p class="bills"><b>${D.bills.map(esc).join('</b> · <b>')}</b></p>
      </div>
      <div class="block">
        <span class="h">Rooms played &mdash; ${roomList.length} venues across ${D.stats.states} states</span>
        <ul class="rooms">${roomList.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>
      <div class="band"><img src="${curtain}" alt=""></div>
      <div class="foot">
        <div><div class="k">Booking</div><div class="nm">${contact}</div><div class="em">${email}</div></div>
        <div class="r"><b>morphicsmusic.com/events</b><br>
          instagram @morphicsmusic · soundcloud /morphics-music</div>
      </div>
    </div>
  </div>`;

  renderPdf(v.out || `one-sheet-${v.id}`, shell({ title: `Morphics — ${v.id}`, css, body }));
  console.log(`     ${v.id}: ${v.note}, accent ${v.accent}`);
}

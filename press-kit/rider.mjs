// Performance & Technical Rider — two pages.
//
// Was five. Three was better but left every page half empty, which reads as
// padding rather than restraint. Two pages, both full: the cover becomes a
// header band, the technical content sits together on page one, and the
// plot plus every contractual clause fills page two in two columns.
//
// Order follows what a promoter needs, in the order they need it: what the
// show IS, what the room must provide, then the terms.

import { read, esc, asset, shell, renderPdf } from './build.mjs';
import { stagePlot } from './stage-plot.mjs';

const epk = read('src/data/epk.json');
const mgmt = epk.management || {};
const UPDATED = 'August 2026';
const A = '#3df082';

const css = `
.page { background:#000; color:#fff; padding:0; position:relative; }
.inner { padding:11mm 16mm 13mm; }

/* Header band, not a cover page. */
.band { position:relative; height:56mm; overflow:hidden }
.band img { width:100%; height:100%; object-fit:cover; display:block }
.band::after { content:''; position:absolute; left:0; right:0; top:0; bottom:-2mm;
  background:
    linear-gradient(270deg,rgba(0,0,0,.82) 0%,rgba(0,0,0,.45) 26%,rgba(0,0,0,0) 52%),
    linear-gradient(180deg,rgba(0,0,0,.2),rgba(0,0,0,.6) 55%,#000 90%,#000 100%) }
.band .mk { position:absolute; left:16mm; bottom:13mm; width:74mm; height:auto; z-index:2 }
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

h2 { font-size:9pt; margin:5.5mm 0 2mm; font-weight:700 }
h2:first-of-type { margin-top:0 }
h2 .n { color:${A}; margin-right:2mm }
p, li { font-size:7.8pt; line-height:1.5; color:#cfcfcf }
p { margin:0 0 2mm }
b { color:#fff; font-weight:700 }
ul { margin:0 0 2.5mm; padding-left:4mm }
li { margin-bottom:.9mm }
li::marker { color:${A} }

table { width:100%; border-collapse:collapse; margin:1.5mm 0 3mm }
th, td { text-align:left; padding:1.9mm 2.2mm; font-size:7.5pt; vertical-align:top;
  border-bottom:1px solid #1a1a1a; color:#cfcfcf }
th { font-size:6.2pt; letter-spacing:.16em; text-transform:uppercase; color:#8a8a8a;
  border-bottom:1px solid #fff }
td.f { color:#fff; font-weight:700; width:30mm }
td.q { width:17mm; font-weight:700; font-variant-numeric:tabular-nums; color:#fff }
tr.key td { background:#0d1a08 }

.note { border-left:2px solid ${A}; background:#0b0b0b; padding:2.6mm 3.4mm;
  margin:3mm 0; font-size:7.4pt; color:#cfcfcf }

/* The terms page reads as a list, so two columns fit it on one page and
   shorten every line into something scannable. */
.two { column-count:2; column-gap:9mm }
.two h2 { break-after:avoid }
.two > *:first-child { margin-top:0 }

.foot { position:absolute; left:16mm; right:16mm; bottom:7mm;
  border-top:1px solid #1a1a1a; padding-top:2.2mm; display:flex;
  justify-content:space-between; font-size:6.2pt; color:#6f6f6f }
`;

const foot = (n) =>
  `<div class="foot"><span>Morphics — Performance &amp; Technical Rider · ${UPDATED}</span><span>${n} / 2</span></div>`;

const body = `
<div class="page">
  <div class="band">
    <img src="${asset('public/images/press/hero/r2-stack3.jpg')}" alt="">
    <img class="mk" data-mark src="${asset('public/images/logos/morphics-text-white.png')}" alt="Morphics">
    <div class="ttl">Performance &amp; <em>Technical Rider</em></div>
    <div class="meta">
      Updated ${UPDATED} · supersedes all previous<br>
      <b>${esc(mgmt.contact || '')}</b> · ${esc(mgmt.company || '')}<br>
      <a>${esc(mgmt.email || '')}</a>
    </div>
  </div>

  <div class="inner">
    <p>Morphics performs three ways. <b>All three are offered on every booking</b> —
    confirm which at advance; the requirements below apply only to the one chosen.
    This rider is executed with the performance contract and the Purchaser is bound
    by each clause collectively and independently.</p>

    <table>
      <thead><tr><th>Format</th><th>Artist provides</th><th>Venue provides</th></tr></thead>
      <tbody>
        <tr><td class="f">Live A/V</td>
          <td>Laptop, controllers, audio interface, all visual content and playback</td>
          <td>2× balanced line input (DI or XLR), projector or LED wall with a feed, monitor</td></tr>
        <tr><td class="f">Live — Ableton</td>
          <td>Laptop, controllers, audio interface. Audio routed from the artist's own interface</td>
          <td>2× balanced line input (DI or XLR) and a monitor. Nothing else</td></tr>
        <tr><td class="f">DJ set</td><td>USB drives</td>
          <td>Linked CDJ setup as specified overleaf, and a monitor</td></tr>
      </tbody>
    </table>

    <div class="note">
      <b>Flexibility is the default.</b> The rig adapts to the room — if the house
      cannot meet a spec, say so at advance rather than on the day and it can almost
      always be worked around. What matters is a clean stereo feed into a capable
      system and enough monitoring to play to.
    </div>

    <h2><span class="n">01</span>Common to every format</h2>
    <ul>
      <li>A competent, experienced sound engineer on site from sound-check through the entire set.</li>
      <li>System loud and clear enough for the room, with real low end and no bleed from other stages.</li>
      <li>One monitor minimum, two preferred, on stands and adjustable from the position played.</li>
      <li>A stable, structurally safe performance area, and a fan for the booth.</li>
      <li>Microphone — Shure SM58 or similar dynamic, wireless preferred.</li>
    </ul>
    <p>The Artist reserves the right to refuse equipment judged unfit, unsafe or outside
    these specifications, and to have people removed from the stage during the performance.</p>

    <h2><span class="n">02</span>DJ set — required equipment</h2>
    <table>
      <thead><tr><th>Qty</th><th>DJ set — required equipment</th><th>Notes</th></tr></thead>
      <tbody>
        <tr class="key"><td class="q">2 <span style="font-weight:400">(4 pref.)</span></td>
          <td><b>Pioneer CDJ-3000</b> preferred</td>
          <td>CDJ-2000NXS2 accepted. USB and Ethernet must be functional.</td></tr>
        <tr class="key"><td class="q">1</td><td><b>Pioneer DJM-900NXS2</b> or better</td>
          <td>DJM-A9 or V10 equally welcome.</td></tr>
        <tr><td class="q">1</td><td>Ethernet hub</td>
          <td>Netgear ProSAFE GS105 or similar, linking all CDJs.</td></tr>
        <tr><td class="q">1</td><td>Technics 1200 turntable</td><td>Where available.</td></tr>
      </tbody>
    </table>

    <div class="note">
      Decks and mixer must LINK, with working USB and Ethernet — the set is prepared as
      a linked multi-deck performance. A four-deck layout needs roughly <b>2200 mm</b> of
      stable table; two decks fit comfortably in less. Where a venue cannot provide this,
      the <b>Ableton format needs only two line inputs</b> and is the simpler booking.
    </div>
  </div>
  ${foot(1)}
</div>

<div class="page">
  <div class="inner">
    <div class="head"><div class="t">Stage plot, terms &amp; hospitality</div>
      <div class="k">Morphics · Rider ${UPDATED}</div></div>

    <p>Plan view. The booth footprint is the same for all three formats — only what sits
    on it changes. Green marks what the artist brings or what the house is asked to patch.</p>

    ${stagePlot(A)}

    <div class="two" style="margin-top:5mm">
      <h2><span class="n">03</span>Advancing</h2>
      <p>The Purchaser or their representative will be available to advance the show by
      phone or email no later than <b>ten business days</b> before the performance,
      confirming: chosen format; fee, capacity, ticket pricing and any tax withheld;
      stage size and condition of sound and lighting; parking, internet, green room
      access and exits; day-of contact; and times for load-in, sound-check, performance
      and curfew.</p>

      <h2><span class="n">04</span>Billing</h2>
      <p>The name is <b>Morphics</b> — one word, as written here — in all printed
      advertising and mentioned in any radio or social advertising. For support slots it
      is listed, published and promoted in full. It is never shortened or restyled.</p>

      <h2><span class="n">05</span>Load-in, parking &amp; access</h2>
      <ul>
        <li>Access at the contracted load-in time, and for 45 minutes after curfew for load-out when headlining.</li>
        <li>Free parking at the venue, or as close as possible.</li>
        <li>A competent driver between airport, hotel and venue where contracted.</li>
        <li>All-access credentials for Artist, crew and management, for the duration of the event.</li>
      </ul>

      <h2><span class="n">06</span>Comps &amp; payment</h2>
      <p>Comps as contracted; where unstated, <b>five</b>, two of them all-access — band,
      crew and management not counted against that total. Cash preferred. Cheques only
      with written approval from management in advance, payable to <b>Tim Waters</b>.
      Where management travels with the Artist, the Purchaser settles with management.
      Please provide a private space for settlement.</p>

      <h2><span class="n">07</span>Hospitality</h2>
      <p>Morphics typically travels alone; confirm numbers at advance. Contracted meals
      are served one hour before the performance or 30 minutes after. In the green room
      before arrival:</p>
      <ul>
        <li>Bottled water, sufficient for Artist and any crew.</li>
        <li>6–18 beers.</li>
        <li>A hot meal, before the show or at the venue. <b>Not pizza.</b></li>
        <li>Safe, on-time transport to and from the necessary locations.</li>
      </ul>
      <p>Where a meal cannot be provided, a <b>$30</b> buyout per person applies.</p>

      <h2><span class="n">08</span>Accommodation</h2>
      <p>Where provided: a double room at a three-star hotel or better, non-smoking,
      close to the venue, booked for late arrival and late check-out, available until the
      day after the performance. No B&amp;Bs. The Purchaser is not responsible for
      incidentals. Where a hotel was contracted but not provided, a <b>$175</b> buyout
      applies at settlement.</p>
    </div>

    <div class="note" style="margin-top:5mm">
      Anything here can be discussed — raise it at advance rather than on the day.
      Nearly everything is negotiable with notice; almost nothing is, without it.
      <b>${esc(mgmt.contact || '')} · ${esc(mgmt.email || '')}</b>
    </div>
  </div>
  ${foot(2)}
</div>
`;

renderPdf('morphics-rider', shell({ title: 'Morphics — Performance & Technical Rider', css, body }));

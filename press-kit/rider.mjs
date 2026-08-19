// Performance & Technical Rider — dark throughout.
//
// The last version had a dark cover and three white body pages, which was
// exactly the "blank white document with some text" the owner said he did
// not want. Printing legibility was not a good enough reason to override
// that, so the whole document now sits in the same system as the one-sheets.
//
// The substantive change: FORMATS. Morphics performs three ways — live A/V,
// live on Ableton with controllers, and a CDJ DJ set — and the old rider
// only described the last one. That understated him and, worse, overstated
// what a venue has to supply: on the Ableton rig he brings everything and
// needs two line inputs. A promoter reading the old rider saw a four-CDJ
// demand and nothing else. The formats table leads the production page now,
// and the CDJ spec sits underneath as the requirement for ONE of the three.

import { read, esc, asset, shell, renderPdf } from './build.mjs';

const epk = read('src/data/epk.json');
const mgmt = epk.management || {};
const UPDATED = 'August 2026';
const A = '#3df082';   // matches the one-sheet

const css = `
.page { background:#000; color:#fff; }

.cover { display:flex; flex-direction:column; padding:0; }
.cover .art { position:relative; height:150mm; overflow:hidden; }
.cover .art img { width:100%; height:100%; object-fit:cover; }
.cover .art::after { content:''; position:absolute; inset:0;
  background:linear-gradient(180deg,rgba(0,0,0,.2),rgba(0,0,0,.7) 60%,#000); }
.cover .body { padding:10mm 18mm 16mm; flex:1; display:flex; flex-direction:column; }
.cover .mark { height:13mm; width:auto; }
.cover h1 { font-size:27pt; line-height:1.05; letter-spacing:-.028em; margin:9mm 0 0; }
.cover h1 em { font-style:normal; color:${A}; }
.cover .upd { font-size:8pt; color:#6f6f6f; margin-top:3mm; }
.cover .contacts { margin-top:auto; border-top:1px solid #fff; padding-top:6mm;
  display:grid; grid-template-columns:1fr 1fr; gap:8mm; }
.cover .nm { font-size:11pt; font-weight:700; margin-top:1.5mm; }
.cover .em { font-size:9.5pt; color:${A}; margin-top:.8mm; }
.cover .co { font-size:8pt; color:#8a8a8a; margin-top:.8mm; }

.sheet { padding:14mm 18mm 16mm; }
.sheet .head { display:flex; justify-content:space-between; align-items:baseline;
  border-bottom:1px solid #fff; padding-bottom:3.5mm; margin-bottom:8mm; }
.sheet .head .t { font-size:14pt; font-weight:700; letter-spacing:-.015em; }
.k { font-size:6.5pt; font-weight:700; letter-spacing:.2em; text-transform:uppercase; color:#6f6f6f; }

h2 { font-size:10pt; margin:7mm 0 2.5mm; }
h2:first-of-type { margin-top:0; }
h2 .n { color:${A}; margin-right:2.5mm; }
p, li { font-size:8.6pt; line-height:1.6; color:#d2d2d2; }
p { margin:0 0 2.5mm; max-width:160mm; }
b { color:#fff; font-weight:700; }
ul { margin:0 0 3mm; padding-left:4.5mm; }
li { margin-bottom:1.2mm; }
li::marker { color:${A}; }

table { width:100%; border-collapse:collapse; margin:2mm 0 4mm; }
th, td { text-align:left; padding:2.4mm 2.5mm; font-size:8.2pt; vertical-align:top;
  border-bottom:1px solid #1c1c1c; color:#d2d2d2; }
th { font-size:6.5pt; letter-spacing:.16em; text-transform:uppercase; color:#8a8a8a;
  border-bottom:1px solid #fff; }
td.f { color:#fff; font-weight:700; width:34mm; }
td.q { width:19mm; font-weight:700; font-variant-numeric:tabular-nums; color:#fff; }
tr.key td { background:#111a06; }

.note { border-left:2px solid ${A}; background:#0c0c0c; padding:3.5mm 4.5mm;
  margin:4mm 0; font-size:8.2pt; color:#d2d2d2; }
.foot { position:absolute; left:18mm; right:18mm; bottom:9mm;
  border-top:1px solid #1c1c1c; padding-top:2.5mm; display:flex;
  justify-content:space-between; font-size:6.8pt; color:#6f6f6f; }
`;

const page = (title, num, inner) => `
<div class="page sheet">
  <div class="head"><div class="t">${esc(title)}</div>
    <div class="k">Morphics · Rider ${UPDATED}</div></div>
  ${inner}
  <div class="foot"><span>Morphics — Performance &amp; Technical Rider</span><span>${num}</span></div>
</div>`;

const body = `
<div class="page cover">
  <div class="art"><img src="${asset('public/images/press/hero/b3-macro-4k.jpg')}" alt=""></div>
  <div class="body">
    <img class="mark" src="${asset('public/images/logos/morphics-text-white.png')}" alt="Morphics">
    <h1>Performance &amp;<br><em>Technical Rider</em></h1>
    <div class="upd">Updated ${UPDATED} · supersedes all previous versions</div>
    <div class="contacts">
      <div><div class="k">Booking &amp; management</div>
        <div class="nm">${esc(mgmt.contact || '')}</div>
        <div class="em">${esc(mgmt.email || '')}</div>
        <div class="co">${esc(mgmt.company || '')}</div></div>
      <div><div class="k">Artist</div>
        <div class="nm">Morphics</div>
        <div class="em">morphicsmusic@gmail.com</div>
        <div class="co">morphicsmusic.com</div></div>
    </div>
  </div>
</div>

${page('Performance formats', 2, `
  <p>Morphics performs three ways. <b>All three are offered on every booking</b> —
  confirm which at advance, and the requirements below apply only to the one
  chosen.</p>

  <table>
    <thead><tr><th>Format</th><th>Artist provides</th><th>Venue provides</th></tr></thead>
    <tbody>
      <tr><td class="f">Live A/V</td>
        <td>Laptop, controllers, audio interface, all visual content and playback</td>
        <td>2× balanced line input (DI or XLR), a projector or LED wall with a feed, and a monitor</td></tr>
      <tr><td class="f">Live — Ableton</td>
        <td>Laptop, controllers, audio interface. Audio is routed out of the artist's own interface</td>
        <td>2× balanced line input (DI or XLR) and a monitor. Nothing else</td></tr>
      <tr><td class="f">DJ set</td>
        <td>USB drives</td>
        <td>Linked CDJ setup as specified overleaf, and a monitor</td></tr>
    </tbody>
  </table>

  <div class="note">
    <b>Flexibility is the default.</b> The rig adapts to the room — if the house
    cannot meet a spec below, say so at advance rather than on the day and it can
    almost always be worked around. What matters is a clean stereo feed into a
    capable system and enough monitoring to play to.
  </div>

  <h2><span class="n">01</span>Common to every format</h2>
  <ul>
    <li>A competent, experienced sound engineer on site from sound-check through the entire set.</li>
    <li>System loud and clear enough for the room, with real low end and no bleed from other stages.</li>
    <li>One monitor minimum, two preferred, on stands near the booth and adjustable from the position played.</li>
    <li>A stable, structurally safe performance area, and a fan for the booth.</li>
    <li>Microphone — Shure SM58 or similar dynamic, wireless preferred.</li>
  </ul>

  <p>The Artist reserves the right to refuse equipment judged unfit, unsafe or
  outside these specifications, and to have people removed from the stage during
  the performance.</p>
`)}

${page('DJ set specification', 3, `
  <p>Required for the <b>DJ set</b> format only. A standard modern CDJ setup in
  full working order. Highlighted rows are the ones that stop the show.</p>

  <table>
    <thead><tr><th>Qty</th><th>Item</th><th>Notes</th></tr></thead>
    <tbody>
      <tr class="key"><td class="q">2 <span style="font-weight:400">(4 pref.)</span></td>
        <td><b>Pioneer CDJ-2000 NEXUS</b> or better</td>
        <td>NXS or NXS2. USB and Ethernet ports must be functional.</td></tr>
      <tr class="key"><td class="q">1</td><td><b>Pioneer DJM-900 NEXUS</b> or better</td>
        <td>NXS or NXS2.</td></tr>
      <tr><td class="q">1</td><td>Ethernet hub</td>
        <td>Netgear ProSAFE GS105 5-port or similar, linking all CDJs.</td></tr>
      <tr><td class="q">1</td><td>Technics 1200 turntable</td><td>Where available.</td></tr>
    </tbody>
  </table>

  <div class="note">
    The CDJs and mixer must be NEXUS editions with working USB and Ethernet —
    the set is prepared as a linked multi-deck performance. Where a venue cannot
    provide this, the <b>Ableton format needs only two line inputs</b> and is the
    simpler booking.
  </div>

  <h2><span class="n">02</span>Advancing</h2>
  <p>The Purchaser or their representative will be available to advance the show
  by phone or email no later than <b>ten business days</b> before the performance,
  confirming: chosen performance format; fee, capacity, ticket pricing and any
  tax withheld; stage size and the condition of sound and lighting; parking,
  internet, green room access and exits; day-of contact; and times for load-in,
  sound-check, performance and curfew.</p>

  <h2><span class="n">03</span>Billing</h2>
  <p>The name is <b>Morphics</b> — one word, as written here — in all printed
  advertising and mentioned in any radio or social advertising. For support slots
  it is listed, published and promoted in full. It is never shortened or restyled.</p>
`)}

${page('Logistics & hospitality', 4, `
  <h2><span class="n">04</span>Load-in, parking &amp; access</h2>
  <ul>
    <li>Venue access at the contracted load-in time, and for 45 minutes after curfew for load-out when headlining.</li>
    <li>Free parking at the venue, or as close to it as possible.</li>
    <li>A competent driver between airport, hotel and venue where contracted.</li>
    <li>All-access credentials for Artist, crew and management, for the duration of the event.</li>
  </ul>

  <h2><span class="n">05</span>Complimentary tickets &amp; payment</h2>
  <p>Comps as stated in the contract; where unstated, <b>five</b>, two of which are
  all-access — band, crew and management are not counted against that total.
  Cash is preferred for payment. Cheques only with written approval from
  management in advance, payable to <b>Tim Waters</b>. Where management travels
  with the Artist, the Purchaser settles with management. Please provide a
  private space for settlement.</p>

  <h2><span class="n">06</span>Hospitality</h2>
  <p>Morphics typically travels alone; confirm numbers at advance. Contracted
  meals are served one hour before the performance or 30 minutes after it.
  Please have in the green room before arrival:</p>
  <ul>
    <li>Bottled water, sufficient for the Artist and any crew.</li>
    <li>6–18 beers.</li>
    <li>A hot meal, before the show or at the venue. <b>Not pizza.</b></li>
    <li>Safe, on-time transport to and from the necessary locations.</li>
  </ul>
  <p>Where a meal cannot be provided, a <b>$20</b> buyout per person applies.</p>

  <h2><span class="n">07</span>Accommodation</h2>
  <p>Where provided by the Purchaser: a double room at a three-star hotel or
  better, non-smoking, close to the venue, booked for late arrival and late
  check-out, available until the day after the performance. No B&amp;Bs. The
  Purchaser is not responsible for incidentals. Where a hotel was contracted but
  not provided, a <b>$125</b> buyout applies at settlement.</p>

  <div class="note">
    Anything here can be discussed — raise it at advance rather than on the day.
    Nearly everything is negotiable with notice; almost nothing is, without it.
  </div>
`)}
`;

renderPdf('morphics-rider', shell({ title: 'Morphics — Performance & Technical Rider', css, body }));

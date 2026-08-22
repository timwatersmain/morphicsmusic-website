// The link-preview cards, as HTML. Rendered at 1200x630 by
// scripts/generate-og-cards.mjs. Open one in a browser to edit it.
//
// Three constraints shape every decision here, and none are taste:
//
//  1. It is seen SMALL. iMessage and Slack draw this around 300-400px wide, so
//     anything under ~28px in card space is unreadable. Hence no body copy and
//     an enormous wordmark.
//  2. The app behind it is not ours. iMessage draws on white, Slack on white or
//     dark, Discord on dark. Every card paints its own opaque background edge to
//     edge — a transparency anywhere lets the host's colour through and the card
//     looks broken on half of them.
//  3. It is cropped unpredictably. Twitter stays near 1.91:1, several clients
//     centre-crop toward square. Nothing meaningful within 60px of an edge.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const FONTS = `
  @font-face { font-family: 'Rubik'; src: url('/fonts/Rubik-Variable.woff2') format('woff2-variations');
               font-weight: 300 900; font-display: block; }
  @font-face { font-family: 'GeistMono'; src: url('/fonts/GeistMono-Variable.woff2') format('woff2-variations');
               font-weight: 100 900; font-display: block; }
`;

const BG = '#06090a';
const PANEL_BG = '#0d1211';
const PRIMARY = '#dbfcff';
const SECONDARY = '#7dffb3';

// The macro photograph that fills the wordmark. Chosen by rendering all 24
// images on the site into this card and comparing at message-bubble size: it is
// the brightest and busiest, and brightness is what keeps the letterforms
// readable once the card is 340px wide. The darker, prettier candidates lost
// whole letters into the black background.
export const WORDMARK_FILL = '/images/visuals/perforated.jpg';
const WORDMARK = '/images/logos/morphics-text-white.png';

export const FOOT_LINE = 'Audio · Visual · Experiment';

const GRAIN = `<div class="grain"></div>`;
const GRAIN_CSS = `
  /* Flat areas band visibly at this size on an 8-bit JPEG; a little noise stops
     that reading as a compression fault. */
  .grain {
    position: absolute; inset: 0; opacity: 0.055; mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
  }`;

function shell(inner, extra = '', bg = BG) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 1200px; height: 630px; overflow: hidden; }
    body {
      background: ${bg};
      font-family: 'Rubik', system-ui, sans-serif;
      color: ${PRIMARY};
      position: relative;
      -webkit-font-smoothing: antialiased;
    }
    ${GRAIN_CSS}
    .tag {
      font-family: 'GeistMono', monospace; letter-spacing: 0.42em;
      text-transform: uppercase; color: ${SECONDARY};
    }
    .foot {
      position: absolute; left: 0; right: 0; bottom: 52px; text-align: center;
      font-family: 'GeistMono', monospace; font-size: 19px; letter-spacing: 0.24em;
      text-transform: uppercase; color: rgba(219,252,255,0.34);
    }
    ${extra}
  </style></head><body>${inner}${GRAIN}</body></html>`;
}

export function card(spec) {
  if (spec.kind === 'release') return releaseCard(spec);
  return wordmarkCard(spec);
}

/**
 * THE site card, and the template for every section.
 *
 * The wordmark is a window: the macro photograph is masked to the letterforms
 * and nothing else is on the card. It is the only design in the audition that
 * makes the logo and the work the same object, and the only one no other artist
 * could produce — the mask is this wordmark and the fill is this photograph.
 *
 * The mask uses the white-on-transparent PNG's ALPHA, so the letterforms come
 * from the real logo file rather than a traced copy that would drift the next
 * time the logo changes.
 */
function wordmarkCard({ tag, foot }) {
  return shell(`
    <div class="cut"><img src="${WORDMARK_FILL}" alt=""></div>
    <div class="tag">${esc(tag || 'The only constant is change')}</div>
    <div class="foot">${esc(foot || FOOT_LINE)}</div>
  `, `
    .cut {
      position: absolute; left: 50%; top: 44%; transform: translate(-50%, -50%);
      width: 940px; height: 240px;
      -webkit-mask-image: url('${WORDMARK}'); mask-image: url('${WORDMARK}');
      -webkit-mask-size: contain; mask-size: contain;
      -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
      -webkit-mask-position: center; mask-position: center;
    }
    /* Lifted, because the mask is the only thing carrying the shape: a dark
       patch of the photograph landing inside a letter reads as a hole in the
       logo rather than as texture. */
    .cut img { width: 100%; height: 100%; object-fit: cover; filter: saturate(1.2) brightness(1.2); }
    .tag { position: absolute; left: 0; right: 0; top: 65%; text-align: center; font-size: 22px; }
  `);
}

/**
 * A specific record. The artwork IS the card — someone sharing a release is
 * sharing that object, and the site's wordmark where the sleeve should be is
 * exactly what this replaces.
 */
function releaseCard({ title, kicker, art, blurb }) {
  return shell(`
    <div class="wrap">
      <div class="art"><img src="${esc(art)}" alt=""></div>
      <div class="meta">
        <div class="kicker">${esc(kicker || '')}</div>
        <h1 class="title">${esc(title)}</h1>
        ${blurb ? `<div class="blurb">${esc(blurb)}</div>` : ''}
      </div>
    </div>
    <div class="mark"><img src="/images/logos/emblem-still.webp" alt=""><span>Morphics</span></div>
  `, `
    .wrap { position: absolute; inset: 0; display: grid; grid-template-columns: 630px 1fr; }
    /* Full-bleed square flush to three edges. A framed thumbnail reads as a list
       row; a bleed reads as a cover. */
    .art { position: relative; overflow: hidden; }
    .art img { width: 100%; height: 100%; object-fit: cover; }
    .art::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent 55%, ${PANEL_BG} 99%);
    }
    .meta {
      display: flex; flex-direction: column; justify-content: center;
      gap: 20px; padding: 64px 64px 150px 56px;
    }
    .kicker {
      font-family: 'GeistMono', monospace; font-size: 22px; letter-spacing: 0.3em;
      text-transform: uppercase; color: ${SECONDARY};
    }
    .title {
      font-size: 84px; font-weight: 800; line-height: 0.94;
      letter-spacing: -0.035em; text-transform: uppercase;
      /* Breaks at spaces only; the generator shrinks it to fit by MEASURING.
         overflow-wrap:anywhere split PERCEPTION as "PERCEPTI / ON", which reads
         as a rendering fault rather than a long title. NOTE: this block is
         inside a template literal — a backtick in a comment here ends it. */
      overflow-wrap: normal; hyphens: none;
    }
    .blurb {
      font-family: 'GeistMono', monospace; font-size: 23px; line-height: 1.55;
      color: rgba(219,252,255,0.45);
    }
    .mark {
      position: absolute; right: 64px; bottom: 52px;
      display: flex; align-items: center; gap: 14px;
    }
    .mark img { width: 34px; height: 34px; object-fit: contain; }
    .mark span {
      font-family: 'GeistMono', monospace; font-size: 19px; letter-spacing: 0.34em;
      text-transform: uppercase; color: rgba(219,252,255,0.5);
    }
  `, PANEL_BG);
}

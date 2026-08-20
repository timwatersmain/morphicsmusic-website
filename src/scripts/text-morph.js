// Text morph: EVERY run of text on the page comes apart into particles and
// reassembles as the text standing in its place on the next page.
//
// This is title-morph.js's effect applied to the whole page, and it reuses
// morphWord() rather than reimplementing it, so both sample the same
// letterforms through the same behaviour library and cannot drift apart.
//
// PAIRING IS BY ORDER, not by meaning. The nth run of text on the outgoing
// page becomes the nth on the incoming one. There is no correspondence to
// discover — "Latest release" becoming "Selected shows" is the point, exactly
// as STORE becomes SOCIAL.
import { morphWord, TITLE_MODES } from './title-morph.js';

const KEY = 'morphics:text-from';

// Marks a run as hidden until its particles land. A class rather than an
// inline style so the CSS failsafe can reveal it without JavaScript — see
// global.css.
const HIDE = 'tm-hide';

// --- what counts as a run of text ------------------------------------------

// Leaf text only: an element with text of its own and no child element that
// also has text. Without this, a <div> wrapping three labels would morph as
// one run AND each label would morph again inside it — the same pixels
// animated three deep.
function hasOwnText(el) {
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent.trim()) return true;
  }
  return false;
}
function hasTextChild(el) {
  for (const c of el.children) {
    if ((c.textContent || '').trim()) return true;
  }
  return false;
}

const textOf = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');

// Skipped outright: the title (title-morph.js owns it), anything already
// hidden from assistive tech, and the script/style content that is not really
// text on a page.
const SKIP = 'h1, script, style, noscript, svg, canvas, [aria-hidden="true"]';

/**
 * Every text run under `root`, in document order.
 *
 * Deliberately layout-free — no getBoundingClientRect anywhere. It has to run
 * identically against the INCOMING document, which Astro hands over before it
 * is in the page and therefore before it has any layout at all. Selecting on
 * structure alone is what keeps the outgoing and incoming lists index-aligned,
 * and that alignment is the whole pairing mechanism.
 */
export function runsIn(root) {
  const out = [];
  const main = root.querySelector('main');
  if (!main) return out;
  for (const el of main.querySelectorAll('*')) {
    if (el.closest(SKIP)) continue;
    if (!hasOwnText(el) || hasTextChild(el)) continue;
    const t = textOf(el);
    if (t) out.push({ el, text: t });
  }
  return out;
}

// Runs longer than this are paired and revealed but never morphed. A sentence
// rasterises to a wide, dense cloud that costs the most and reads the least —
// body copy coming apart into dust is noise, not motion. Headings, labels,
// counts, buttons and titles all sit well under it.
const MAX_MORPH_CHARS = 44;

// Total particles across the whole page, split between the runs by their
// rendered area. This is the number that decides whether this is a transition
// or a stall, so it is spent deliberately rather than per-element.
const POINT_BUDGET = 15000;
const MIN_POINTS = 45;
const MAX_POINTS = 900;

function reveal(el) {
  if (!el) return;
  el.classList.remove(HIDE);
}

function revealAll(root = document) {
  document.documentElement.classList.remove('text-morphing');
  for (const el of root.querySelectorAll('.' + HIDE)) el.classList.remove(HIDE);
}

export function initTextMorph() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Record what is leaving, and hide what is arriving — both in the same
  // moment, because this is the only moment that can do either.
  //
  // astro:before-swap fires while the outgoing DOM is still on screen AND
  // hands over the incoming document before it is displayed. Marking the
  // incoming runs here is what makes them hidden from their very first paint;
  // astro:page-load would be too late and every word would flash into place
  // before its particles arrived.
  document.addEventListener('astro:before-swap', (e) => {
    if (reduce.matches) return;
    try {
      const outgoing = runsIn(document).map((r) => r.text);
      if (!outgoing.length) { sessionStorage.removeItem(KEY); return; }
      sessionStorage.setItem(KEY, JSON.stringify(outgoing));

      const incoming = e.newDocument ? runsIn(e.newDocument) : [];
      if (incoming.length) {
        document.documentElement.classList.add('text-morphing');
        for (const r of incoming) r.el.classList.add(HIDE);
      }
    } catch (err) { /* private mode or no newDocument: no morph, no harm */ }
  });

  // A full page load has no before-swap, so nothing was hidden and nothing
  // should be morphed — there is no outgoing page in this tab to morph FROM.
  // Clearing the record keeps a stale one from firing against the wrong page.
  window.addEventListener('pagehide', () => {
    try { sessionStorage.removeItem(KEY); } catch (err) { /* ignore */ }
  });

  const run = () => {
    if (reduce.matches) { revealAll(); return; }

    let from = null;
    try {
      const raw = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
      if (raw) from = JSON.parse(raw);
    } catch (err) { from = null; }

    if (!Array.isArray(from) || !from.length) { revealAll(); return; }

    // Bounded wait, same as the title: rasterising against a fallback face
    // samples the wrong letterforms, but these runs are hidden until this
    // resolves, so it can never be open-ended. Past the deadline, show them.
    let started = false;
    const go = (morph) => {
      if (started) return;
      started = true;
      if (!morph) { revealAll(); return; }
      try { play(from); } catch (err) { revealAll(); }
    };
    const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(() => go(true), () => go(true));
    setTimeout(() => go(false), 450);
  };

  function play(from) {
    const runs = runsIn(document);
    document.documentElement.classList.remove('text-morphing');

    // Measure once, up front. Interleaving reads with the writes below would
    // thrash layout across dozens of elements.
    const measured = runs.map((r, i) => {
      const rect = r.el.getBoundingClientRect();
      const onScreen = rect.width > 0 && rect.height > 0
        && rect.top < window.innerHeight * 1.1 && rect.bottom > -rect.height;
      return { ...r, rect, onScreen, fromText: from[i] };
    });

    // Which runs actually morph: on screen, changed, and short enough to read
    // as a word rather than as a paragraph.
    const active = measured.filter((m) =>
      m.onScreen && m.fromText && m.fromText !== m.text
      && m.text.length <= MAX_MORPH_CHARS && m.fromText.length <= MAX_MORPH_CHARS);

    // Everything else is simply shown — off screen, unchanged, or too long.
    for (const m of measured) if (!active.includes(m)) reveal(m.el);

    // Split the particle budget by rendered area, so a heading gets a dense
    // cloud and a caption gets a sparse one instead of every run paying the
    // same price regardless of how much of the page it occupies.
    const totalArea = active.reduce((n, m) => n + m.rect.width * m.rect.height, 0) || 1;

    // One behaviour for the whole page, chosen per navigation. Per-element
    // modes read as a fault rather than a flourish: dozens of different
    // behaviours at once is chaos, not one page becoming another.
    const mode = TITLE_MODES[(Math.random() * TITLE_MODES.length) | 0];

    active.forEach((m, i) => {
      const share = (m.rect.width * m.rect.height) / totalArea;
      const points = Math.max(MIN_POINTS, Math.min(MAX_POINTS, Math.round(POINT_BUDGET * share)));
      // Staggered by document order so the page resolves top-down instead of
      // every canvas starting on the same frame.
      setTimeout(() => {
        try {
          morphWord(m.el, m.fromText, m.text, { mode, points, onDone: () => reveal(m.el) });
        } catch (err) { reveal(m.el); }
      }, Math.min(i * 14, 220));
    });

    // Backstop: whatever happens above, nothing stays hidden.
    setTimeout(() => revealAll(), 1400);
  }

  document.addEventListener('astro:page-load', run);
}

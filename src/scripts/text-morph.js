// Text morph: every short run of text on the page comes apart into particles
// and reassembles as the corresponding text on the next page.
//
// This is title-morph.js's effect applied to the rest of the page. It reuses
// morphWord() rather than reimplementing it, so both surfaces sample the same
// letterforms with the same behaviour library and cannot drift apart.
//
// It exists because the whole-page transition it replaced was wrong in kind:
// a mask over everything dressed content in motion it did not need and fought
// the elements that already had their own. Morphing text into text is the
// same gesture the title already makes, applied consistently.
//
// PAIRING IS BY ORDER, not by meaning. The nth morphable run on the outgoing
// page becomes the nth on the incoming one. There is no correspondence to
// discover — "Rewards" becoming "Your collection" is the point, the same way
// STORE becomes SOCIAL.
import { morphWord, TITLE_MODES } from './title-morph.js';

const KEY = 'morphics:text-from';

// A budget, not a preference. Each morph rasterises two words and runs its own
// canvas, so this is the difference between a transition and a stall. Twelve
// is what fits comfortably inside the title's own 620ms on a mid-range
// machine; the rest of the page simply appears, which is what it did before.
const MAX_RUNS = 12;

// Short runs only. Headings, labels, counts, buttons — never a paragraph. A
// long string rasterises to a wide, dense point cloud that costs the most and
// reads the least: body copy coming apart into dust is noise, not motion.
const MAX_CHARS = 32;

// Where the effect applies. Deliberately a STATIC selector rather than "any
// element with short text": the same list is used by CSS to hide these runs
// before first paint, and CSS cannot ask how long an element's text is.
// [data-morph-text] is the escape hatch for anything else worth including.
// h2/h3 are here for correctness, but this site barely uses them — its
// section labels are spans carrying the .uppercase.tracking-widest pair from
// the design system. Targeting only headings matched almost nothing, which is
// exactly what the first build of this did.
const SELECTOR = 'main h2, main h3, main .uppercase.tracking-widest, main [data-morph-text]';

const textOf = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');

/**
 * The runs this page offers, in document order and already budgeted.
 *
 * Filtered to what is actually on screen: an element far below the fold would
 * spend its share of the budget animating something nobody is looking at, and
 * the elements above it are the ones that carry the transition.
 */
export function morphableRuns() {
  const seen = new Set();
  const candidates = [];

  document.querySelectorAll(SELECTOR).forEach((el, order) => {
    const t = textOf(el);
    if (!t || t.length > MAX_CHARS) return;

    // Interactive chrome is excluded. Buttons and links repeat all over a
    // page — /music carries "Name your price" twenty-two times — so in
    // document order they would swallow the entire budget and the page's
    // actual structure would never morph at all.
    if (el.closest('a, button')) return;

    // One morph per distinct string. Twelve copies of the same word coming
    // apart in unison reads as a glitch, not as a page turning.
    const key = t.toLowerCase();
    if (seen.has(key)) return;

    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;                                // hidden
    if (r.top > window.innerHeight * 1.15 || r.bottom < 0) return;    // off screen

    seen.add(key);
    // Prominence, so the budget is spent on what carries the page rather than
    // on whatever happens to be first in the DOM.
    candidates.push({ el, text: t, order, weight: r.width * r.height });
  });

  return candidates
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_RUNS)
    .sort((a, b) => a.order - b.order)   // back to document order, so the
    .map(({ el, text }) => ({ el, text })); // stagger still reads top-down
}

// Reveal a run whatever happens. Same contract as the title's failsafe: these
// elements start hidden so the particles can assemble them, so their
// visibility must never depend on this module finishing, or even running.
function reveal(el) {
  if (el) el.style.opacity = '1';
}

function revealAll() {
  document.documentElement.classList.remove('text-morphing');
  for (const el of document.querySelectorAll(SELECTOR)) reveal(el);
}

export function initTextMorph() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Record what is leaving, for whichever page comes next. Both events for
  // the same reason title-morph binds both: pagehide covers a real navigation,
  // astro:before-swap covers an in-app one, and neither fires for the other.
  const recordOutgoing = () => {
    try {
      const runs = morphableRuns().map((r) => r.text);
      if (runs.length) sessionStorage.setItem(KEY, JSON.stringify(runs));
      else sessionStorage.removeItem(KEY);
    } catch (e) { /* private mode: no morph, no harm */ }
  };
  window.addEventListener('pagehide', recordOutgoing);
  document.addEventListener('astro:before-swap', recordOutgoing);

  const run = () => {
    if (reduce.matches) { revealAll(); return; }

    let from = null;
    try {
      const raw = sessionStorage.getItem(KEY);
      sessionStorage.removeItem(KEY);
      if (raw) from = JSON.parse(raw);
    } catch (e) { from = null; }

    if (!Array.isArray(from) || !from.length) { revealAll(); return; }

    // Same bounded wait as the title: rasterising against a fallback face
    // samples the wrong letterforms, but these runs are HIDDEN until this
    // resolves, so the wait cannot be open-ended. Past the deadline they are
    // simply shown.
    let started = false;
    const go = (morph) => {
      if (started) return;
      started = true;
      if (!morph) { revealAll(); return; }
      try { play(from); } catch (e) { revealAll(); }
    };
    const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(() => go(true), () => go(true));
    setTimeout(() => go(false), 450);
  };

  function play(from) {
    const runs = morphableRuns();
    document.documentElement.classList.remove('text-morphing');

    // One mode for the whole page, chosen per navigation. Per-element modes
    // looked like a fault rather than a flourish — twelve different
    // behaviours firing at once reads as chaos, not as one page turning into
    // another.
    const mode = TITLE_MODES[(Math.random() * TITLE_MODES.length) | 0];

    runs.forEach((r, i) => {
      const fromText = from[i];
      // Nothing to morph from, or the text did not change: just show it.
      if (!fromText || fromText === r.text) { reveal(r.el); return; }
      // Staggered so the page resolves top-down rather than all at once —
      // 26ms apart is under the threshold where it reads as a sequence, but
      // enough to stop twelve canvases starting on the same frame.
      setTimeout(() => {
        try {
          morphWord(r.el, fromText, r.text, { mode, onDone: () => reveal(r.el) });
        } catch (e) { reveal(r.el); }
      }, i * 26);
    });

    // Anything the budget or the filters excluded is still hidden by the
    // class-based rule until this point; make sure it comes back.
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (!runs.some((r) => r.el === el)) reveal(el);
    }
  }

  document.addEventListener('astro:page-load', run);
}

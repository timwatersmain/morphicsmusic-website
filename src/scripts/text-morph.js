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

// Fidelity is set by SAMPLING STRIDE, not by a particle count. A count fixed
// per run samples big type finely and small type coarsely, and since the
// particle radius follows the stride, small runs ended up drawn with dots
// wider than their own strokes. Tying the stride to the type's size keeps the
// particles the same size RELATIVE to the letterforms at 11px as at 80px,
// which is the whole reason the title reads sharp.
//
// fontPx/13 lands a 40px heading near 3 and an 11px label near 0.85.
const STRIDE_DIVISOR = 13;
const MIN_STRIDE = 0.75;
const MAX_STRIDE = 3;

// Cost ceiling for the page, in sampled points. Fine sampling is what makes
// small text read, and it is not free: every point is an arc drawn every
// frame. Runs are taken largest first until this is spent; whatever is left
// is simply shown.
//
// Quality over coverage, deliberately. Morphing every last caption badly
// looks worse than morphing the text that carries the page properly and
// letting the rest arrive — which is what a page did before any of this.
const POINT_CEILING = 34000;

// Rough cost of a run before sampling it: its area, the share of that area
// that is typically ink, divided by the stride cell. Close enough to rank and
// budget by, and it costs nothing — the real count is only known after
// rasterising, which is the work being budgeted for.
function estimatePoints(rect, stride) {
  return (rect.width * rect.height * 0.22) / (stride * stride);
}

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

    // SELECT FIRST, REVEAL THE REST IMMEDIATELY, THEN WAIT.
    //
    // The order here is the whole difference between this reading as a morph
    // and reading as a broken page. Everything under <main> is hidden before
    // paint, but only a fraction of it can be morphed well; the first build
    // kept ALL of it hidden until the font gate resolved, so a page with 145
    // runs showed roughly 140 of them as blank space for ~450ms and then
    // popped them in at once. That is what the effect actually looked like.
    //
    // Selection needs layout, which exists now, and it does not need fonts.
    // So choose, show everything not chosen on this very frame, and let only
    // the handful that will actually morph wait for the font gate.
    let chosen;
    try { chosen = select(from); } catch (err) { revealAll(); return; }
    if (!chosen.length) { revealAll(); return; }

    // Bounded wait, same as the title: rasterising against a fallback face
    // samples the wrong letterforms. The chosen runs are hidden until this
    // resolves, so it can never be open-ended.
    let started = false;
    const go = (morph) => {
      if (started) return;
      started = true;
      if (!morph) { revealAll(); return; }
      try { play(chosen); } catch (err) { revealAll(); }
    };
    const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(() => go(true), () => go(true));
    setTimeout(() => go(false), 450);
  };

  /**
   * Decide what morphs, reveal everything else at once, and return the list.
   * Measures, but never waits.
   */
  function select(from) {
    const runs = runsIn(document);
    document.documentElement.classList.remove('text-morphing');

    // Measure in one pass. Interleaving reads with the reveals below would
    // thrash layout across a hundred-odd elements.
    const measured = runs.map((r, i) => {
      const rect = r.el.getBoundingClientRect();
      const onScreen = rect.width > 0 && rect.height > 0
        && rect.top < window.innerHeight * 1.1 && rect.bottom > -rect.height;
      return { ...r, rect, onScreen, order: i, fromText: from[i] };
    });

    const eligible = [];
    for (const m of measured) {
      const ok = m.onScreen && m.fromText && m.fromText !== m.text
        && m.text.length <= MAX_MORPH_CHARS && m.fromText.length <= MAX_MORPH_CHARS;
      if (ok) eligible.push(m);
      else reveal(m.el);            // off screen, unchanged, or too long
    }

    const ranked = eligible.map((m) => {
      const fontPx = parseFloat(getComputedStyle(m.el).fontSize) || 14;
      const stride = Math.max(MIN_STRIDE, Math.min(MAX_STRIDE, fontPx / STRIDE_DIVISOR));
      return { ...m, stride, cost: estimatePoints(m.rect, stride) };
    }).sort((a, b) => b.cost - a.cost);

    let spent = 0;
    const chosen = [];
    for (const m of ranked) {
      if (spent + m.cost > POINT_CEILING) { reveal(m.el); continue; }
      spent += m.cost;
      chosen.push(m);
    }
    // Back to document order so the stagger resolves top-down.
    chosen.sort((a, b) => a.order - b.order);
    return chosen;
  }

  function play(chosen) {
    // One behaviour for the whole page, chosen per navigation. Per-element
    // modes read as a fault rather than a flourish: dozens of different
    // behaviours at once is chaos, not one page becoming another.
    const mode = TITLE_MODES[(Math.random() * TITLE_MODES.length) | 0];

    chosen.forEach((m, i) => {
      // Staggered by document order so the page resolves top-down instead of
      // every canvas starting on the same frame.
      setTimeout(() => {
        try {
          morphWord(m.el, m.fromText, m.text, { mode, strideCss: m.stride, onDone: () => reveal(m.el) });
        } catch (err) { reveal(m.el); }
      }, Math.min(i * 14, 220));
    });

    // Backstop: whatever happens above, nothing stays hidden.
    setTimeout(() => revealAll(), 1400);
  }

  document.addEventListener('astro:page-load', run);
}

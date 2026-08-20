// Page settle: the incoming page's sections rise into place, staggered.
//
// The motion is LAYOUT, not pixels. That is the whole point, and it is the
// lesson from the two whole-page effects that came off before it: a dot-field
// mask fought everything that had its own transition, and a particle morph
// applied to all the page's text could never work at 11px, because a run that
// small has too few pixels to be described by particles. Moving a section
// 16px looks identical at every type size, on every page, forever.
//
// SAFE BY CONSTRUCTION. This only ever ADDS an animation. If the script never
// runs, never loads, or throws, nothing is marked and the page is simply
// there — no class, no animation, no hidden content. That is deliberately the
// opposite of the text morph, which had to hide content first and therefore
// needed a failsafe to undo itself.
const CLASS = 'settle';

// Per-step delay and how many steps before it stops growing. Past about six,
// a stagger stops reading as a sequence and starts reading as a page that is
// slow to arrive.
const STEP_MS = 55;
const MAX_STEPS = 6;

/**
 * The element whose children are the page's sections.
 *
 * Pages here are built two ways: music/visuals/store hang their sections
 * directly off <main>, while events/community/profile wrap everything in a
 * single column div. Staggering <main>'s children on the second kind would
 * animate one element — the whole page as a single block — which is the
 * effect this is meant to replace. So when <main> holds exactly one element,
 * step inside it.
 */
// Astro leaves each page's bundled <script> inside <main>, so the element
// children are never quite what the markup suggests: /events reads as
// [div, script], not [div]. Filtering these out is what makes the
// single-wrapper test below correct — and stops a <script> tag being handed
// an animation delay as though it were a section.
const NON_VISUAL = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

function sections(el) {
  return [...el.children].filter((c) => !NON_VISUAL.has(c.tagName));
}

function contentRoot(doc) {
  const main = doc.querySelector('main');
  if (!main) return null;
  const kids = sections(main);
  // A single wrapper is a column div, not a section — step inside it, or the
  // whole page animates as one block, which is the effect this replaces.
  if (kids.length === 1 && sections(kids[0]).length > 1) return kids[0];
  return main;
}

/** Mark the incoming page's sections. Runs before that page is displayed. */
export function markSettle(doc) {
  const root = contentRoot(doc);
  if (!root) return;

  let step = 0;
  for (const el of sections(root)) {
    // The title is excluded, and not for tidiness: title-morph.js pins an
    // absolutely-positioned canvas to the <h1>'s measured rect. Translating
    // an ancestor would slide the heading out from under its own particles.
    if (el.querySelector('h1') || el.tagName === 'H1') continue;
    // An explicit opt-out for anything that must not move.
    if (el.hasAttribute('data-no-settle')) continue;

    el.classList.add(CLASS);
    el.style.animationDelay = `${Math.min(step, MAX_STEPS) * STEP_MS}ms`;
    step++;
  }
}

export function initPageSettle() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // astro:before-swap hands over the incoming document before it is
  // displayed, which is the only moment that can mark it without a flash: at
  // astro:page-load the page may already have painted, and the sections would
  // be seen in place before dropping back 16px to animate in.
  document.addEventListener('astro:before-swap', (e) => {
    try { if (e.newDocument) markSettle(e.newDocument); } catch (err) { /* page still fine */ }
  });
}

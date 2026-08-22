// website/functions/_lib/preorder.mjs
// Single source of truth for pre-order eligibility, the companion to
// release-gate.mjs. That module answers "can this be DELIVERED yet"; this one
// answers "can this be SOLD yet", and the two are deliberately independent:
//
//   released           → sell yes, deliver yes   (the ordinary case)
//   unreleased + listed → sell yes, deliver NO   (a pre-order)
//   unreleased         → sell no,  deliver no
//
// There is no fourth state. Nothing here ever loosens delivery — the download
// path keeps asking release-gate and only release-gate, so a pre-order cannot
// leak files early no matter what this file says.
//
// Shared by checkout (the sell gate), the store pages (the button) and the
// library (the "unlocks in N days" row) so all three cannot drift apart.

import { isReleased, goLiveUtcMs } from './release-gate.mjs';
import preorderData from '../../src/data/preorders.json';

const SLUGS = new Set(preorderData.slugs || []);

// True when a release is not out yet AND has been opted in to pre-orders.
// Both halves matter: the allow-list alone would sell a release forever, and
// the date alone would put every future-dated release on sale the moment it
// was scheduled.
export function isPreorderable(slug, releaseDateStr, nowMs = Date.now()) {
  if (!slug || !SLUGS.has(slug)) return false;
  // A usable date is required, and this is not a formality. `isReleased` is
  // false for a blank or malformed date, so testing only "not released yet"
  // would make a listed release with no date pre-orderable FOREVER — money
  // taken for a delivery that has no day to arrive on. A pre-order is a
  // promise about a date; with no date there is no promise to make.
  if (!Number.isFinite(goLiveUtcMs(releaseDateStr))) return false;
  return !isReleased(releaseDateStr, nowMs);
}

// True when a release can be added to the cart at all — the union of the two
// sellable states above. This is what a buy button should ask.
export function isSellable(slug, releaseDateStr, nowMs = Date.now()) {
  return isReleased(releaseDateStr, nowMs) || isPreorderable(slug, releaseDateStr, nowMs);
}

// Whole days until a pre-order unlocks, rounded UP so the last partial day
// still reads as "1 day" rather than "0 days". Null once it is out (or if the
// date is unusable), which is also the caller's cue to say nothing.
export function daysUntilUnlock(releaseDateStr, nowMs = Date.now()) {
  const live = goLiveUtcMs(releaseDateStr);
  if (!Number.isFinite(live) || nowMs >= live) return null;
  return Math.ceil((live - nowMs) / 86_400_000);
}

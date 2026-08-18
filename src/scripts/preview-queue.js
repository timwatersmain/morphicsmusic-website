// Pure autoplay-queue logic for the preview player. No DOM, no <audio>, no
// fetch — just catalogue data in, an ordered list of playable tracks out.
// preview-player.js is the only runtime consumer; tests exercise this
// module directly so the ordering/skip rules are pinned without a browser.
//
// "Next chronologically" means FORWARD in time: releases are ordered oldest
// release_date first. Finishing a release continues into whatever the
// artist made *next* — the way a listener moving forward through a
// discography experiences it — rather than jumping backward into the past
// when a release ends.

/**
 * Flatten the catalogue into one ordered list of playable tracks: within a
 * release, track_number order; across releases, oldest release_date first.
 * Any track (or whole release) with no preview key is skipped entirely —
 * it can never stall the queue because it was never in it.
 */
export function buildQueue(catalog, previewsData) {
  const previewsBySlug = (previewsData && previewsData.previews) || {};
  const releases = ((catalog && catalog.releases) || [])
    .slice()
    .sort((a, b) => String(a.release_date || '').localeCompare(String(b.release_date || '')));

  const now = Date.now();
  const entries = [];
  for (const release of releases) {
    const previewByTrack = {};
    for (const p of previewsBySlug[release.slug] || []) {
      if (p.track_number != null && p.key) previewByTrack[p.track_number] = p.key;
    }
    const tracks = (release.tracks || [])
      .slice()
      .sort((a, b) => (a.track_number || 0) - (b.track_number || 0));

    for (const t of tracks) {
      const key = previewByTrack[t.track_number];
      if (!key) continue; // unplayable — step over it, don't stall the queue

      const buyable = !!release.has_masters &&
        (!release.release_date || new Date(release.release_date).getTime() <= now);

      entries.push({
        key,
        title: t.title,
        sub: release.title,
        art: release.artwork || null,
        slug: release.slug,
        trackNum: t.track_number,
        cart: {
          slug: release.slug,
          title: release.title,
          type: release.type,
          count: release.track_count,
          cents: release.min_price_cents,
          buyable,
          art: release.artwork || null,
        },
      });
    }
  }
  return entries;
}

/** The entry after `currentKey` in `queue`, or null at the end (or if the key isn't queued). */
export function nextInQueue(queue, currentKey) {
  const idx = (queue || []).findIndex((e) => e.key === currentKey);
  if (idx === -1) return null;
  return queue[idx + 1] || null;
}

// ── "Actually heard it" progress tracking ──────────────────────────────────
// Same standard the engagement-XP work uses for a genuine listen (see
// functions/_lib/community/engagement.ts's LISTEN_COMPLETION_FRACTION /
// applyListenEntry, and engagement-tracker.js's client-side mirror of it):
// only FORWARD playback progress counts, and a jump bigger than a normal
// timeupdate tick (~250ms of real playback) is treated as a seek and
// discarded. A track someone scrubbed straight to the end never accumulates
// forwardSeconds, so it never reads as "genuinely complete" even though the
// browser still fires `ended`.

export const LISTEN_COMPLETION_FRACTION = 0.9;
export const MAX_PROGRESS_JUMP_SECONDS = 2;

/** A tiny, DOM-free forward-progress accumulator for one <audio> element's lifetime with one track. */
export function createForwardProgressTracker() {
  let forwardSeconds = 0;
  let lastTime = 0;
  let duration = 0;

  return {
    /** Call on every timeupdate (and whenever duration becomes known). */
    update(currentTime, dur) {
      if (Number.isFinite(dur) && dur > 0) duration = dur;
      const t = Number.isFinite(currentTime) ? currentTime : lastTime;
      const delta = t - lastTime;
      if (delta > 0 && delta < MAX_PROGRESS_JUMP_SECONDS) forwardSeconds += delta;
      lastTime = t;
    },
    /** Start tracking a new track from zero. */
    reset() { forwardSeconds = 0; lastTime = 0; duration = 0; },
    /** True once accumulated forward progress reaches LISTEN_COMPLETION_FRACTION of duration. */
    isGenuineComplete() {
      return duration > 0 && forwardSeconds / duration >= LISTEN_COMPLETION_FRACTION;
    },
  };
}

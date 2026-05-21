// website/scripts/catalog-helpers.mjs
// Pure helpers shared by sync-music-catalog.mjs (and unit-tested directly).

const UUID32 = /^[0-9a-f]{32}$/i;

export function slugify(title) {
  return String(title).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Pipeline releases have a 32-hex UUID id; older catalog releases already use
// a clean slug as their id. Keep the clean id; derive a slug for UUIDs.
export function releaseSlug(id, title) {
  return UUID32.test(String(id)) ? slugify(title) : String(id);
}

// Upcoming releases store the future date in scheduled_release_date and leave
// release_date blank. Fall back so the catalog always carries the live date.
export function releaseDateFor(releaseDate, scheduledReleaseDate) {
  return (releaseDate && releaseDate.trim()) ? releaseDate : (scheduledReleaseDate || '');
}

// Name-your-price minimums (cents). EPs are $1/track per Tim 2026-05-21;
// other types keep their existing tiers.
export function minPriceCentsFor(type, trackCount) {
  if (type === 'ep') return Math.max(1, trackCount) * 100;
  if (type === 'single') return 100;
  if (type === 'mix') return 200;
  if (trackCount >= 8) return 700;
  return 500;
}

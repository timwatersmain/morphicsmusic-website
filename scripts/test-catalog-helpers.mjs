// website/scripts/test-catalog-helpers.mjs
import assert from 'node:assert/strict';
import { releaseSlug, releaseDateFor, minPriceCentsFor } from './catalog-helpers.mjs';

// UUID id → slug derived from title; clean id → unchanged
assert.equal(releaseSlug('edb40167312d42adbed12c13da2f65fa', 'Swamp Logic'), 'swamp-logic');
assert.equal(releaseSlug('heart-of-the-sun', 'Heart of the Sun'), 'heart-of-the-sun');

// release_date falls back to scheduled_release_date when blank
assert.equal(releaseDateFor('', '2026-05-23'), '2026-05-23');
assert.equal(releaseDateFor('2019-12-13', '2026-05-23'), '2019-12-13');
assert.equal(releaseDateFor('', ''), '');

// EP priced at $1/track; other tiers unchanged
assert.equal(minPriceCentsFor('ep', 2), 200);
assert.equal(minPriceCentsFor('ep', 5), 500);
assert.equal(minPriceCentsFor('single', 1), 100);
assert.equal(minPriceCentsFor('mix', 3), 200);
assert.equal(minPriceCentsFor('album', 8), 700);
assert.equal(minPriceCentsFor('album', 4), 500);

console.log('catalog-helpers OK');

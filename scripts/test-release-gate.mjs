// website/scripts/test-release-gate.mjs
import assert from 'node:assert/strict';
import { goLiveUtcMs, isReleased } from '../functions/_lib/release-gate.mjs';

// 2026-05-23 is EDT (UTC-4): midnight ET = 04:00 UTC.
assert.equal(goLiveUtcMs('2026-05-23'), Date.UTC(2026, 4, 23, 4, 0, 0));
// 2026-01-10 is EST (UTC-5): midnight ET = 05:00 UTC.
assert.equal(goLiveUtcMs('2026-01-10'), Date.UTC(2026, 0, 10, 5, 0, 0));

// isReleased: before go-live = false, at/after = true.
assert.equal(isReleased('2026-05-23', Date.UTC(2026, 4, 23, 3, 59, 0)), false);
assert.equal(isReleased('2026-05-23', Date.UTC(2026, 4, 23, 4, 0, 0)), true);
assert.equal(isReleased('2019-12-13', Date.now()), true);   // past release
assert.equal(isReleased('', Date.now()), false);            // no date = not released

console.log('release-gate OK');

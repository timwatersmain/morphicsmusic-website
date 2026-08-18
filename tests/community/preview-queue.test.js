import { describe, it, expect } from 'vitest';
import {
  buildQueue,
  nextInQueue,
  previousInQueue,
  resolvePrevious,
  PREVIOUS_RESTART_THRESHOLD_SECONDS,
  createForwardProgressTracker,
  LISTEN_COMPLETION_FRACTION,
} from '../../src/scripts/preview-queue.js';

const catalog = {
  releases: [
    {
      slug: 'later-ep',
      title: 'LATER EP',
      type: 'ep',
      release_date: '2026-01-01',
      artwork: '/images/later.jpg',
      has_masters: true,
      min_price_cents: 200,
      track_count: 2,
      tracks: [
        { track_number: 1, title: 'Later One' },
        { track_number: 2, title: 'Later Two' },
      ],
    },
    {
      slug: 'earliest-single',
      title: 'EARLIEST SINGLE',
      type: 'single',
      release_date: '2018-01-01',
      artwork: '/images/earliest.jpg',
      has_masters: true,
      min_price_cents: 100,
      track_count: 1,
      tracks: [{ track_number: 1, title: 'Earliest' }],
    },
    {
      slug: 'no-preview-release',
      title: 'NO PREVIEW RELEASE',
      type: 'single',
      release_date: '2019-01-01',
      artwork: '/images/np.jpg',
      has_masters: true,
      min_price_cents: 100,
      track_count: 1,
      tracks: [{ track_number: 1, title: 'Silent' }],
    },
    {
      slug: 'partial-ep',
      title: 'PARTIAL EP',
      type: 'ep',
      release_date: '2020-06-01',
      artwork: '/images/partial.jpg',
      has_masters: true,
      min_price_cents: 200,
      track_count: 2,
      tracks: [
        { track_number: 1, title: 'Has Preview' },
        { track_number: 2, title: 'No Preview' },
      ],
    },
  ],
};

const previewsData = {
  previews: {
    'later-ep': [
      { track_number: 1, key: 'previews/later-ep/1.mp3' },
      { track_number: 2, key: 'previews/later-ep/2.mp3' },
    ],
    'earliest-single': [{ track_number: 1, key: 'previews/earliest-single/1.mp3' }],
    // no-preview-release: intentionally absent — whole release unplayable
    'partial-ep': [{ track_number: 1, key: 'previews/partial-ep/1.mp3' }], // track 2 unplayable
  },
};

describe('buildQueue', () => {
  it('orders releases oldest release_date first (chronologically forward)', () => {
    const q = buildQueue(catalog, previewsData);
    const slugOrder = [...new Set(q.map((e) => e.slug))];
    expect(slugOrder).toEqual(['earliest-single', 'partial-ep', 'later-ep']);
  });

  it('orders tracks within a release by track_number', () => {
    const q = buildQueue(catalog, previewsData);
    const laterKeys = q.filter((e) => e.slug === 'later-ep').map((e) => e.key);
    expect(laterKeys).toEqual(['previews/later-ep/1.mp3', 'previews/later-ep/2.mp3']);
  });

  it('skips a whole release with no previews at all', () => {
    const q = buildQueue(catalog, previewsData);
    expect(q.some((e) => e.slug === 'no-preview-release')).toBe(false);
  });

  it('skips an individual unplayable track without stalling the rest of its release', () => {
    const q = buildQueue(catalog, previewsData);
    const partialKeys = q.filter((e) => e.slug === 'partial-ep').map((e) => e.trackNum);
    expect(partialKeys).toEqual([1]); // track 2 (no preview key) is gone, track 1 still queued
  });

  it('shapes each entry like the player bar meta object (title/sub/art/cart)', () => {
    const q = buildQueue(catalog, previewsData);
    const entry = q.find((e) => e.slug === 'earliest-single');
    expect(entry).toMatchObject({
      title: 'Earliest',
      sub: 'EARLIEST SINGLE',
      art: '/images/earliest.jpg',
      slug: 'earliest-single',
      trackNum: 1,
      cart: { slug: 'earliest-single', title: 'EARLIEST SINGLE', cents: 100, buyable: true },
    });
  });

  it('is deterministic', () => {
    expect(buildQueue(catalog, previewsData)).toEqual(buildQueue(catalog, previewsData));
  });
});

describe('nextInQueue', () => {
  it('returns the next track within the same release', () => {
    const q = buildQueue(catalog, previewsData);
    const next = nextInQueue(q, 'previews/later-ep/1.mp3');
    expect(next.key).toBe('previews/later-ep/2.mp3');
  });

  it('moves to the first track of the next release chronologically once a release runs out', () => {
    const q = buildQueue(catalog, previewsData);
    const next = nextInQueue(q, 'previews/earliest-single/1.mp3');
    expect(next).toMatchObject({ slug: 'partial-ep', trackNum: 1 });
  });

  it('stops at the end of the catalogue instead of looping back to the start', () => {
    const q = buildQueue(catalog, previewsData);
    const last = q[q.length - 1];
    expect(nextInQueue(q, last.key)).toBeNull();
  });

  it('returns null for a key that is not queued at all', () => {
    const q = buildQueue(catalog, previewsData);
    expect(nextInQueue(q, 'not-a-real-key')).toBeNull();
  });
});

describe('previousInQueue', () => {
  it('returns the previous track within the same release', () => {
    const q = buildQueue(catalog, previewsData);
    const prev = previousInQueue(q, 'previews/later-ep/2.mp3');
    expect(prev.key).toBe('previews/later-ep/1.mp3');
  });

  it('moves to the last track of the previous release chronologically once a release starts', () => {
    const q = buildQueue(catalog, previewsData);
    const prev = previousInQueue(q, 'previews/later-ep/1.mp3');
    expect(prev).toMatchObject({ slug: 'partial-ep', trackNum: 1 });
  });

  it('returns null at the start of the catalogue', () => {
    const q = buildQueue(catalog, previewsData);
    const first = q[0];
    expect(previousInQueue(q, first.key)).toBeNull();
  });

  it('returns null for a key that is not queued at all', () => {
    const q = buildQueue(catalog, previewsData);
    expect(previousInQueue(q, 'not-a-real-key')).toBeNull();
  });
});

describe('resolvePrevious — the "restart vs step back" convention', () => {
  it('steps back to the previous track when just barely into the current one', () => {
    const q = buildQueue(catalog, previewsData);
    const result = resolvePrevious(q, 'previews/later-ep/2.mp3', 0);
    expect(result).toEqual({ action: 'previous', entry: expect.objectContaining({ key: 'previews/later-ep/1.mp3' }) });
  });

  it('steps back at exactly the threshold (not yet past it)', () => {
    const q = buildQueue(catalog, previewsData);
    const result = resolvePrevious(q, 'previews/later-ep/2.mp3', PREVIOUS_RESTART_THRESHOLD_SECONDS);
    expect(result.action).toBe('previous');
  });

  it('restarts the current track once just past the threshold', () => {
    const q = buildQueue(catalog, previewsData);
    const result = resolvePrevious(q, 'previews/later-ep/2.mp3', PREVIOUS_RESTART_THRESHOLD_SECONDS + 0.01);
    expect(result).toEqual({ action: 'restart' });
  });

  it('restarts (never throws/stalls) at the very start of the catalogue past the threshold', () => {
    const q = buildQueue(catalog, previewsData);
    const first = q[0];
    const result = resolvePrevious(q, first.key, 10);
    expect(result).toEqual({ action: 'restart' });
  });

  it('restarts at the very start of the catalogue even within the threshold, since there is nowhere earlier to go', () => {
    const q = buildQueue(catalog, previewsData);
    const first = q[0];
    const result = resolvePrevious(q, first.key, 0);
    expect(result).toEqual({ action: 'restart' });
  });
});

describe('createForwardProgressTracker — the "actually heard it" gate', () => {
  it('is not complete before any progress', () => {
    const t = createForwardProgressTracker();
    t.update(0, 200);
    expect(t.isGenuineComplete()).toBe(false);
  });

  it('reports complete once forward progress reaches the completion fraction', () => {
    const t = createForwardProgressTracker();
    const duration = 200;
    for (let time = 0; time <= duration * LISTEN_COMPLETION_FRACTION + 1; time += 1) {
      t.update(time, duration);
    }
    expect(t.isGenuineComplete()).toBe(true);
  });

  it('does NOT report complete for a scrub-to-the-end (one large forward jump)', () => {
    const t = createForwardProgressTracker();
    t.update(0.1, 200);
    t.update(199.9, 200); // dragged the scrubber to the end in one jump
    expect(t.isGenuineComplete()).toBe(false);
  });

  it('ignores backward seeks (does not go negative / does not count them as progress)', () => {
    const t = createForwardProgressTracker();
    t.update(50, 200);
    t.update(5, 200); // seeked backward
    t.update(5.1, 200); // then a tiny bit of real forward progress
    expect(t.isGenuineComplete()).toBe(false);
  });

  it('reset() clears accumulated progress for a fresh track', () => {
    const t = createForwardProgressTracker();
    for (let time = 0; time <= 190; time += 1) t.update(time, 200);
    expect(t.isGenuineComplete()).toBe(true);
    t.reset();
    expect(t.isGenuineComplete()).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { evaluateUnlocks } from '../../functions/_lib/community/unlocks';
import type { AvatarCatalogueRow, UnlockContext } from '../../functions/_lib/community/types';

const DAY = 86400;
const NOW = 1_800_000_000;

function avatar(id: string, rule: object, over: Partial<AvatarCatalogueRow> = {}): AvatarCatalogueRow {
  return {
    id, kind: id.startsWith('release:') ? 'release' : 'special',
    release_slug: null, name: id, art_path: '/a.webp',
    unlock_rule: JSON.stringify(rule), hint: 'hint',
    available_from: null, available_until: null, sort_order: 0, ...over,
  };
}

function ctx(over: Partial<UnlockContext> = {}): UnlockContext {
  return {
    ownedSlugs: [], fanSince: NOW, now: NOW,
    streakWeeks: 0, showsAttended: [], gatesCompleted: [], ...over,
  };
}

describe('release ownership', () => {
  const cat = [avatar('release:perception', { type: 'own_release', slug: 'perception' })];

  it('grants when the release is owned', () => {
    const g = evaluateUnlocks(ctx({ ownedSlugs: ['perception'] }), cat);
    expect(g.map(x => x.avatarId)).toEqual(['release:perception']);
    expect(g[0].source).toBe('own_release');
    expect(g[0].sourceRef).toBe('perception');
  });

  it('does not grant when unowned', () => {
    expect(evaluateUnlocks(ctx({ ownedSlugs: ['other'] }), cat)).toEqual([]);
  });
});

describe('tenure', () => {
  const cat = [avatar('special:year-one', { type: 'tenure_days', days: 365 })];

  it('grants once the fan is old enough', () => {
    expect(evaluateUnlocks(ctx({ fanSince: NOW - 400 * DAY }), cat)).toHaveLength(1);
  });
  it('withholds before the milestone', () => {
    expect(evaluateUnlocks(ctx({ fanSince: NOW - 100 * DAY }), cat)).toHaveLength(0);
  });
  it('grants exactly on the boundary', () => {
    expect(evaluateUnlocks(ctx({ fanSince: NOW - 365 * DAY }), cat)).toHaveLength(1);
  });
});

describe('streaks, shows and gates', () => {
  it('grants a streak avatar at or above the threshold', () => {
    const cat = [avatar('special:streak-4', { type: 'free_song_streak', weeks: 4 })];
    expect(evaluateUnlocks(ctx({ streakWeeks: 4 }), cat)).toHaveLength(1);
    expect(evaluateUnlocks(ctx({ streakWeeks: 3 }), cat)).toHaveLength(0);
  });

  it('grants a show avatar only for that show', () => {
    const cat = [avatar('special:show-2026', { type: 'show_attended', showId: 'ldn-2026' })];
    expect(evaluateUnlocks(ctx({ showsAttended: ['ldn-2026'] }), cat)).toHaveLength(1);
    expect(evaluateUnlocks(ctx({ showsAttended: ['other'] }), cat)).toHaveLength(0);
  });

  it('grants a gate avatar on completion', () => {
    const cat = [avatar('special:acid', { type: 'gate_completed', gateSlug: 'acid-pack' })];
    expect(evaluateUnlocks(ctx({ gatesCompleted: ['acid-pack'] }), cat)).toHaveLength(1);
  });
});

describe('availability windows', () => {
  const rule = { type: 'tenure_days', days: 0 };

  it('withholds before available_from', () => {
    const cat = [avatar('special:soon', rule, { available_from: NOW + DAY })];
    expect(evaluateUnlocks(ctx(), cat)).toHaveLength(0);
  });
  it('withholds after available_until — time-limited avatars stay unrepeatable', () => {
    const cat = [avatar('special:gone', rule, { available_until: NOW - DAY })];
    expect(evaluateUnlocks(ctx(), cat)).toHaveLength(0);
  });
  it('grants inside the window', () => {
    const cat = [avatar('special:live', rule, { available_from: NOW - DAY, available_until: NOW + DAY })];
    expect(evaluateUnlocks(ctx(), cat)).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('ignores an unknown rule type rather than throwing', () => {
    expect(evaluateUnlocks(ctx(), [avatar('special:x', { type: 'telepathy' })])).toEqual([]);
  });
  it('ignores malformed rule JSON rather than throwing', () => {
    const bad = { ...avatar('special:x', {}), unlock_rule: '{not json' };
    expect(() => evaluateUnlocks(ctx(), [bad])).not.toThrow();
    expect(evaluateUnlocks(ctx(), [bad])).toEqual([]);
  });
  it('evaluates a whole catalogue and returns only what qualifies', () => {
    const cat = [
      avatar('release:a', { type: 'own_release', slug: 'a' }),
      avatar('release:b', { type: 'own_release', slug: 'b' }),
      avatar('special:year-one', { type: 'tenure_days', days: 365 }),
    ];
    const g = evaluateUnlocks(ctx({ ownedSlugs: ['a'], fanSince: NOW - 400 * DAY }), cat);
    expect(g.map(x => x.avatarId).sort()).toEqual(['release:a', 'special:year-one']);
  });
});

// Coverage for scripts/rebuild-fan-projection.mjs's pure functions. This
// file guards the branch's single worst failure mode — a rebuild silently
// overwriting a fan's chosen handle or display name — so it must not be the
// one file in this feature with no automated tests.
import { describe, it, expect } from 'vitest';
import { buildRebuildSql, parseCustomerRecord, assertNoFanOwnedWrites } from '../../scripts/rebuild-fan-projection.mjs';

const CATALOGUE = [
  {
    id: 'release:perception', kind: 'release', release_slug: 'perception', name: 'PERCEPTION',
    art_path: '/images/albums/perception-400.webp',
    unlock_rule: JSON.stringify({ type: 'own_release', slug: 'perception' }),
    hint: 'Own PERCEPTION', available_from: null, available_until: null, sort_order: 0,
  },
];

describe('buildRebuildSql — output shape', () => {
  it('contains only the expected derived columns and none of the fan-owned ones', () => {
    const fans = [{ email: 'a@b.com', fanSince: 1000, ownedSlugs: ['perception'] }];
    const sql = buildRebuildSql(fans, CATALOGUE, 2000);

    expect(sql).toContain('fan_since = 1000');
    expect(sql).toContain('collection_count = 1');
    expect(sql).toContain('updated_at = 2000');
    expect(sql).toContain('avatar_id');

    expect(sql).not.toMatch(/\bhandle\b/i);
    expect(sql).not.toMatch(/\bdisplay_name\b/i);
    expect(sql).not.toMatch(/\bequipped_avatar_id\b/i);
  });

  it('skips a fan with no usable fan_since rather than writing 0', () => {
    const fans = [{ email: 'nodata@b.com', fanSince: null, ownedSlugs: [] }];
    expect(buildRebuildSql(fans, CATALOGUE, 2000)).toBe('');
  });
});

describe('assertNoFanOwnedWrites', () => {
  const FORBIDDEN = ['handle', 'display_name', 'equipped_avatar_id'];

  it.each(FORBIDDEN)('throws on an unquoted write to %s', col => {
    expect(() => assertNoFanOwnedWrites(`UPDATE fan_profiles SET ${col} = 'x' WHERE id=1;`)).toThrow();
  });

  // Regression test for the review finding: the original regex `\b${col}\s*=`
  // could not match a quoted identifier, because the quote character sits
  // between the column name and `=`, breaking `\s*=` right after the name.
  // Confirmed (outside this suite, via node -e against the pre-fix file at
  // commit c347d40) that the OLD regex let all three quoted forms below
  // through silently — this test exists so that regression can't return
  // unnoticed.
  it.each(FORBIDDEN)('throws on a double-quoted write to %s', col => {
    expect(() => assertNoFanOwnedWrites(`UPDATE fan_profiles SET "${col}" = 'x' WHERE id=1;`)).toThrow();
  });

  it.each(FORBIDDEN)('throws on a backtick-quoted write to %s', col => {
    expect(() => assertNoFanOwnedWrites(`UPDATE fan_profiles SET \`${col}\` = 'x' WHERE id=1;`)).toThrow();
  });

  it.each(FORBIDDEN)('throws on a bracket-quoted write to %s', col => {
    expect(() => assertNoFanOwnedWrites(`UPDATE fan_profiles SET [${col}] = 'x' WHERE id=1;`)).toThrow();
  });

  it.each(FORBIDDEN)('throws when %s appears in an INSERT column list', col => {
    expect(() => assertNoFanOwnedWrites(
      `INSERT INTO fan_profiles (id, ${col}) VALUES (1, 'x');`,
    )).toThrow();
  });

  it('does not throw on legitimate rebuild SQL', () => {
    const legit = buildRebuildSql(
      [{ email: 'a@b.com', fanSince: 1000, ownedSlugs: ['perception'] }],
      CATALOGUE,
      2000,
    );
    expect(() => assertNoFanOwnedWrites(legit)).not.toThrow();
  });

  it('does not false-positive on the legitimate avatar_id column — the near-miss against equipped_avatar_id', () => {
    const sql = "INSERT INTO fan_avatar_unlocks (fan_id, avatar_id, unlocked_at, source, source_ref)\n" +
      "  SELECT id, 'release:perception', 2000, 'own_release', 'perception' FROM fan_profiles WHERE email = 'a@b.com'\n" +
      "  ON CONFLICT (fan_id, avatar_id) DO NOTHING;";
    expect(() => assertNoFanOwnedWrites(sql)).not.toThrow();
  });
});

describe('parseCustomerRecord', () => {
  it('unions music_release_slugs and digital_slugs across purchases, deduped', () => {
    const raw = JSON.stringify({
      first_seen_at: 1000,
      purchases: [
        { music_release_slugs: ['perception'], digital_slugs: ['morphian'] },
        { music_release_slugs: ['perception', 'swamp-logic'], digital_slugs: [] },
      ],
    });
    const parsed = parseCustomerRecord('A@B.com', raw);
    expect(parsed.email).toBe('a@b.com');
    expect(parsed.fanSince).toBe(1000);
    expect(new Set(parsed.ownedSlugs)).toEqual(new Set(['perception', 'swamp-logic', 'morphian']));
  });

  it('handles malformed JSON without throwing, returning fanSince: null', () => {
    expect(() => parseCustomerRecord('a@b.com', '{not valid json')).not.toThrow();
    const parsed = parseCustomerRecord('a@b.com', '{not valid json');
    expect(parsed.fanSince).toBeNull();
    expect(parsed.ownedSlugs).toEqual([]);
  });

  it('handles an empty/missing record without throwing, returning fanSince: null', () => {
    expect(() => parseCustomerRecord('a@b.com', '')).not.toThrow();
    const parsed = parseCustomerRecord('a@b.com', '');
    expect(parsed.fanSince).toBeNull();
    expect(parsed.ownedSlugs).toEqual([]);
  });
});

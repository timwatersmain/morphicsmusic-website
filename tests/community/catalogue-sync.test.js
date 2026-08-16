import { describe, it, expect } from 'vitest';
import { buildReleaseAvatars, toUpsertSql } from '../../scripts/sync-avatar-catalogue.mjs';

const catalog = {
  releases: [
    { slug: 'perception', title: 'PERCEPTION', artwork: '/images/albums/perception.jpg' },
    { slug: 'swamp-logic', title: 'SWAMP LOGIC', artwork: '/images/albums/swamp-logic.jpg' },
  ],
};

describe('buildReleaseAvatars', () => {
  it('makes one avatar per release', () => {
    expect(buildReleaseAvatars(catalog)).toHaveLength(2);
  });

  it('uses a stable id so re-running never re-issues an unlock', () => {
    expect(buildReleaseAvatars(catalog)[0].id).toBe('release:perception');
  });

  it('prefers the 400px webp variant over the source jpg', () => {
    expect(buildReleaseAvatars(catalog)[0].art_path).toBe('/images/albums/perception-400.webp');
  });

  it('encodes an ownership rule naming the release', () => {
    expect(JSON.parse(buildReleaseAvatars(catalog)[0].unlock_rule))
      .toEqual({ type: 'own_release', slug: 'perception' });
  });

  it('writes a hint that tells a locked fan how to earn it', () => {
    expect(buildReleaseAvatars(catalog)[0].hint).toBe('Own PERCEPTION');
  });

  it('skips a release with no artwork rather than emitting a broken avatar', () => {
    const out = buildReleaseAvatars({ releases: [{ slug: 'x', title: 'X', artwork: null }] });
    expect(out).toEqual([]);
  });

  it('is deterministic — same input, same output', () => {
    expect(buildReleaseAvatars(catalog)).toEqual(buildReleaseAvatars(catalog));
  });
});

describe('toUpsertSql — apostrophe escaping', () => {
  // No release title today has an apostrophe, so nothing currently exercises
  // this path. A future release like "Don't Look" would be the first thing
  // ever to hit it — this test stands in for that release so a regression
  // from q()'s doubled-quote escaping back to raw template interpolation is
  // caught here instead of in a live SQL error (or worse, a broken-out
  // string literal) the day that release ships.
  const apostropheRelease = {
    releases: [
      { slug: 'dont-look', title: "Don't Look", artwork: '/images/albums/dont-look.jpg' },
    ],
  };

  it('doubles the single quote so the statement stays a valid string literal', () => {
    const [row] = buildReleaseAvatars(apostropheRelease);
    const sql = toUpsertSql([row]);

    // name = 'Don't Look' -> escaped as 'Don''t Look'
    expect(sql).toContain("'Don''t Look'");
    // hint = "Own Don't Look" -> escaped the same way
    expect(sql).toContain("'Own Don''t Look'");
  });

  it('never emits a raw un-doubled apostrophe that would break out of the string literal', () => {
    const [row] = buildReleaseAvatars(apostropheRelease);
    const sql = toUpsertSql([row]);

    // If q() regressed to plain template-literal interpolation, the name
    // field would appear as the broken `'Don't Look'` — a single quote
    // closing the string literal early, followed by bare, un-quoted SQL
    // text `t Look'`. Assert that broken (single-quote) form is absent and
    // only the escaped (doubled-quote) form is present.
    expect(sql).not.toMatch(/Don't(?!')/);
    expect(sql).toContain("Don''t");
  });

  it('produces exactly one well-formed statement per row (no SQL break-out)', () => {
    const rows = buildReleaseAvatars(apostropheRelease);
    const sql = toUpsertSql(rows);
    const statementCount = (sql.match(/INSERT INTO avatar_catalogue/g) || []).length;
    expect(statementCount).toBe(rows.length);
  });
});

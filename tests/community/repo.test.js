import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ensureProfile, grantUnlocks, getProfileByHandle, getUnlockedAvatarIds,
  getRarity, getDirectory, toPublicProfile,
} from '../../functions/_lib/community/repo';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');

import { makeD1Shim } from './helpers/d1-shim.js';

let raw, db;
beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(UP);
  raw.exec(`INSERT INTO avatar_catalogue (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order)
    VALUES ('release:perception','release','perception','PERCEPTION','/a.webp',
            '{"type":"own_release","slug":"perception"}','Own PERCEPTION',0)`);
  db = makeD1Shim(raw);
});

describe('ensureProfile', () => {
  it('creates a profile on first call', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana Vex' });
    expect(p.handle).toBe('ana-vex');
    expect(p.fan_since).toBe(100);
  });

  it('is idempotent — a second call returns the same row', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    const b = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    expect(b.id).toBe(a.id);
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_profiles').get().c).toBe(1);
  });

  it('suffixes a colliding handle instead of failing', async () => {
    await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: 'Ana' });
    const second = await ensureProfile(db, { email: 'c@d.com', fanSince: 0, displayName: 'Ana' });
    expect(second.handle).toBe('ana-2');
  });

  it('falls back to a neutral name when none is supplied', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: null });
    expect(p.display_name).toBe('Fan');
    // The email must never leak into the public-facing handle.
    expect(p.handle).not.toContain('a@b.com');
    expect(p.handle).not.toContain('b.com');
  });
});

describe('ensureProfile race recovery', () => {
  it('returns the existing row when a concurrent insert wins the unique-email race', async () => {
    const email = 'race@b.com';
    // Simulate a concurrent request that already created the profile between
    // our pre-check and our insert.
    raw.exec(`INSERT INTO fan_profiles (email, handle, display_name, fan_since, created_at, updated_at, last_seen_at)
      VALUES ('${email}', 'race', 'Race', 0, 0, 0, 0)`);

    // Wrap the shim so the FIRST getProfileByEmail-shaped read misses the row
    // that genuinely exists — reproducing the race window — while every
    // later read (including the catch-block re-read) sees real data.
    let emailReadCount = 0;
    const raceDb = {
      prepare: sql => {
        const stmt = db.prepare(sql);
        if (!sql.includes('FROM fan_profiles WHERE email = ?')) return stmt;
        return {
          ...stmt,
          bind: (...a) => {
            const bound = stmt.bind(...a);
            return {
              ...bound,
              first: async () => {
                emailReadCount += 1;
                if (emailReadCount === 1) return null;
                return bound.first();
              },
            };
          },
        };
      },
      batch: db.batch,
    };

    const p = await ensureProfile(raceDb, { email, fanSince: 0, displayName: 'Race' });
    // The winner's row stands — ensureProfile must not throw or create a duplicate.
    expect(p.handle).toBe('race');
    expect(p.display_name).toBe('Race');
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_profiles').get().c).toBe(1);
  });

  it('rethrows a non-unique-violation error rather than swallowing it', async () => {
    const boomDb = {
      prepare: sql => {
        const stmt = db.prepare(sql);
        if (!sql.trim().startsWith('INSERT INTO fan_profiles')) return stmt;
        return {
          ...stmt,
          bind: (...a) => ({
            ...stmt.bind(...a),
            run: async () => { throw new Error('disk I/O error'); },
          }),
        };
      },
      batch: db.batch,
    };

    await expect(
      ensureProfile(boomDb, { email: 'boom@b.com', fanSince: 0, displayName: 'Boom' }),
    ).rejects.toThrow('disk I/O error');
    // The catch block's re-read found nothing real, so it must not fabricate
    // or leave behind a row.
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_profiles').get().c).toBe(0);
  });
});

describe('grantUnlocks', () => {
  let fanId;
  beforeEach(async () => {
    fanId = (await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: 'Ana' })).id;
  });

  const grant = { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' };

  it('grants a new avatar', async () => {
    expect(await grantUnlocks(db, fanId, [grant])).toBe(1);
    expect(await getUnlockedAvatarIds(db, fanId)).toEqual(['release:perception']);
  });

  it('is idempotent — re-granting adds nothing and does not throw', async () => {
    await grantUnlocks(db, fanId, [grant]);
    expect(await grantUnlocks(db, fanId, [grant])).toBe(0);
    expect(await getUnlockedAvatarIds(db, fanId)).toHaveLength(1);
  });

  it('handles an empty grant list', async () => {
    expect(await grantUnlocks(db, fanId, [])).toBe(0);
  });
});

describe('reads', () => {
  beforeEach(async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 10, displayName: 'Ana' });
    await ensureProfile(db, { email: 'c@d.com', fanSince: 20, displayName: 'Bo' });
    await grantUnlocks(db, a.id, [{ avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' }]);
  });

  it('finds a profile by handle', async () => {
    expect((await getProfileByHandle(db, 'ana')).display_name).toBe('Ana');
  });

  it('returns null for an unknown handle', async () => {
    expect(await getProfileByHandle(db, 'nobody')).toBeNull();
  });

  it('computes rarity as a fraction of all fans', async () => {
    // 1 of 2 fans holds it.
    expect((await getRarity(db))['release:perception']).toBeCloseTo(0.5);
  });

  it('lists the directory', async () => {
    expect(await getDirectory(db, { limit: 10, offset: 0 })).toHaveLength(2);
  });
});

describe('toPublicProfile', () => {
  it('never includes the email', () => {
    const row = {
      id: 1, email: 'secret@b.com', handle: 'ana', display_name: 'Ana',
      equipped_avatar_id: null, fan_since: 1, rank_points: 0,
      collection_count: 2, created_at: 0, updated_at: 0, last_seen_at: null,
    };
    const pub = toPublicProfile(row, null);
    expect(JSON.stringify(pub)).not.toContain('secret@b.com');
    expect('email' in pub).toBe(false);
    expect(pub.handle).toBe('ana');
  });
});

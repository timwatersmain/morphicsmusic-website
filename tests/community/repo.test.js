import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ensureProfile, grantUnlocks, getProfileByHandle, getUnlockedAvatarIds,
  getRarity, getDirectory, toPublicProfile, updateProfile,
  canChangeHandle, nextHandleChangeAt, HANDLE_CHANGE_COOLDOWN_DAYS,
  recordXpEvent, sumLedgerXp, voidXpEvent, getXpEvents,
  softDeleteFanProfile, restoreFanProfile, purgeFanProfile, purgeExpiredProfiles,
  getDeletedProfileByEmail, getProfileByEmail, isHandleTaken,
  isGraceExpired, purgeDueAt, DELETE_GRACE_DAYS,
} from '../../functions/_lib/community/repo';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');
const UP3 = readFileSync(join(root, 'migrations/0003_handle_locked.sql'), 'utf8');
const UP4 = readFileSync(join(root, 'migrations/0004_handle_cooldown.sql'), 'utf8');
const UP6 = readFileSync(join(root, 'migrations/0006_creatures.sql'), 'utf8');
const UP7 = readFileSync(join(root, 'migrations/0007_sprites.sql'), 'utf8');
const UP8 = readFileSync(join(root, 'migrations/0008_sprite_override.sql'), 'utf8');
const UP9 = readFileSync(join(root, 'migrations/0009_native_colourway.sql'), 'utf8');
const UP10 = readFileSync(join(root, 'migrations/0010_engagement_ep.sql'), 'utf8');
const UP11 = readFileSync(join(root, 'migrations/0011_profile_bio_privacy.sql'), 'utf8');
const UP12 = readFileSync(join(root, 'migrations/0012_profile_soft_delete.sql'), 'utf8');
const UP13 = readFileSync(join(root, 'migrations/0013_discord_links.sql'), 'utf8');
const UP14 = readFileSync(join(root, 'migrations/0014_xp_events.sql'), 'utf8');

import { makeD1Shim } from './helpers/d1-shim.js';

let raw, db;
beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(UP);
  raw.exec(UP3);
  raw.exec(UP4);
  raw.exec(UP6);
  raw.exec(UP7);
  raw.exec(UP8);
  raw.exec(UP9);
  raw.exec(UP10);
  raw.exec(UP11);
  raw.exec(UP12);
  raw.exec(UP13);
  raw.exec(UP14);
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

  it('defaults the handle (and display name) to the account username, when one exists', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: null, username: 'ana_vex' });
    expect(p.display_name).toBe('ana_vex');
    expect(p.handle).toBe('ana-vex');
  });

  it('prefers the username over a supplied display name', async () => {
    const p = await ensureProfile(db, {
      email: 'a@b.com', fanSince: 0, displayName: 'Some Legal Name', username: 'realuser',
    });
    expect(p.display_name).toBe('realuser');
    expect(p.handle).toBe('realuser');
  });

  // Usernames allow underscores AND hyphens, but slugifyHandle collapses
  // underscores to hyphens — so two DISTINCT usernames can slugify to the
  // same handle. The second account must get a suffix, not a collision.
  it('suffixes the second account when two usernames slugify to the same handle', async () => {
    const first = await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: null, username: 'foo_bar' });
    const second = await ensureProfile(db, { email: 'c@d.com', fanSince: 0, displayName: null, username: 'foo-bar' });
    expect(first.handle).toBe('foo-bar');
    expect(second.handle).toBe('foo-bar-2');
    expect(first.handle).not.toBe(second.handle);
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

describe('getDirectory ordering', () => {
  beforeEach(async () => {
    raw.exec(`INSERT INTO avatar_catalogue (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order)
      VALUES ('release:second','release','second','SECOND','/b.webp',
              '{"type":"own_release","slug":"second"}','Own SECOND',1)`);
  });

  it('ranks a fan with more unlocks above an older fan with fewer, even though they joined later', async () => {
    // Older fan, zero unlocks.
    const veteran = await ensureProfile(db, { email: 'veteran@b.com', fanSince: 5, displayName: 'Veteran' });
    // Much younger fan, but holds two avatars — under the old
    // rank_points/tenure ordering this fan would rank LAST, not first.
    const collector = await ensureProfile(db, { email: 'collector@b.com', fanSince: 5000, displayName: 'Collector' });
    await grantUnlocks(db, collector.id, [
      { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' },
      { avatarId: 'release:second', source: 'own_release', sourceRef: 'second' },
    ]);

    const rows = await getDirectory(db, { limit: 10, offset: 0 });
    const handles = rows.map(r => r.handle);
    expect(handles.indexOf('collector')).toBeLessThan(handles.indexOf('veteran'));
  });

  it('falls back to tenure (ascending) when unlock counts tie', async () => {
    const older = await ensureProfile(db, { email: 'older@b.com', fanSince: 10, displayName: 'Older' });
    const younger = await ensureProfile(db, { email: 'younger@b.com', fanSince: 999, displayName: 'Younger' });

    const rows = await getDirectory(db, { limit: 10, offset: 0 });
    const handles = rows.map(r => r.handle);
    expect(handles.indexOf(older.handle)).toBeLessThan(handles.indexOf(younger.handle));
  });
});

describe('toPublicProfile', () => {
  it('never includes the email', () => {
    const row = {
      id: 1, email: 'secret@b.com', handle: 'ana', display_name: 'Ana',
      equipped_avatar_id: null, fan_since: 1, rank_points: 0,
      collection_count: 2, created_at: 0, updated_at: 0, last_seen_at: null,
      handle_changed_at: 1700000000,
    };
    const pub = toPublicProfile(row, null);
    expect(JSON.stringify(pub)).not.toContain('secret@b.com');
    expect('email' in pub).toBe(false);
    expect(pub.handle).toBe('ana');
  });

  it('never includes handle_changed_at — it is internal state, not fan-facing', () => {
    const row = {
      id: 1, email: 'secret@b.com', handle: 'ana', display_name: 'Ana',
      equipped_avatar_id: null, fan_since: 1, rank_points: 0,
      collection_count: 2, created_at: 0, updated_at: 0, last_seen_at: null,
      handle_changed_at: 1700000000,
    };
    const pub = toPublicProfile(row, null);
    expect('handle_changed_at' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('handle_changed_at');
  });

  it('carries the tier-ladder recipe fields on the avatar', () => {
    const row = {
      id: 1, email: 'secret@b.com', handle: 'ana', display_name: 'Ana',
      equipped_avatar_id: 'tier:cyan-1', fan_since: 1, rank_points: 0,
      collection_count: 2, created_at: 0, updated_at: 0, last_seen_at: null,
      handle_changed_at: null,
    };
    const avatar = {
      id: 'tier:cyan-1', kind: 'special', release_slug: null, name: 'Cyan I',
      art_path: '(procedural)', unlock_rule: '{"type":"tier1_default"}', hint: '',
      available_from: null, available_until: null, sort_order: 0,
      style: 'glyph_solid', colourway: 'cyan', artwork_key: null, tier: 1,
    };
    const pub = toPublicProfile(row, avatar);
    expect(pub.avatar).toEqual({
      id: 'tier:cyan-1', name: 'Cyan I', art_path: '(procedural)',
      style: 'glyph_solid', colourway: 'cyan', artwork_key: null, tier: 1,
    });
  });

  it('a release avatar (style null) still emits a usable art_path', () => {
    const row = {
      id: 1, email: 'secret@b.com', handle: 'ana', display_name: 'Ana',
      equipped_avatar_id: 'release:perception', fan_since: 1, rank_points: 0,
      collection_count: 2, created_at: 0, updated_at: 0, last_seen_at: null,
      handle_changed_at: null,
    };
    const avatar = {
      id: 'release:perception', kind: 'release', release_slug: 'perception', name: 'PERCEPTION',
      art_path: '/images/visuals/perception-960.webp', unlock_rule: '{"type":"own_release","slug":"perception"}',
      hint: '', available_from: null, available_until: null, sort_order: 0,
      style: null, colourway: null, artwork_key: null, tier: null,
    };
    const pub = toPublicProfile(row, avatar);
    expect(pub.avatar.style).toBeNull();
    expect(pub.avatar.art_path).toBe('/images/visuals/perception-960.webp');
  });
});

describe('canChangeHandle / nextHandleChangeAt', () => {
  const DAY = 24 * 60 * 60;

  it('permits the change when the handle has never been changed', () => {
    expect(canChangeHandle(null, 1_000_000)).toBe(true);
  });

  it('rejects a second change within the cooldown window', () => {
    const changedAt = 1_000_000;
    expect(canChangeHandle(changedAt, changedAt + DAY)).toBe(false);
  });

  it('permits a change once the cooldown has fully elapsed', () => {
    const changedAt = 1_000_000;
    expect(canChangeHandle(changedAt, changedAt + HANDLE_CHANGE_COOLDOWN_DAYS * DAY)).toBe(true);
  });

  it('nextHandleChangeAt is exactly cooldown-days after the last change', () => {
    const changedAt = 1_000_000;
    expect(nextHandleChangeAt(changedAt)).toBe(changedAt + HANDLE_CHANGE_COOLDOWN_DAYS * DAY);
  });
});

describe('updateProfile stamps handle_changed_at on a handle write', () => {
  it('sets handle_changed_at when the handle field is included', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: 'Ana' });
    expect(profile.handle_changed_at).toBeNull();

    await updateProfile(db, profile.id, { handle: 'ana-vex' });

    const row = raw.prepare('SELECT handle, handle_changed_at FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle).toBe('ana-vex');
    expect(row.handle_changed_at).not.toBeNull();
  });

  it('leaves handle_changed_at untouched when only display_name changes', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: 'Ana' });
    await updateProfile(db, profile.id, { displayName: 'Someone Else' });
    const row = raw.prepare('SELECT handle_changed_at FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle_changed_at).toBeNull();
  });
});

describe('updateProfile handle race recovery', () => {
  it('recovers from a handle collision during regeneration instead of throwing', async () => {
    // Fan A already owns the handle "ana" — the exact candidate Fan B's
    // regeneration would otherwise land on.
    await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: 'Ana' });
    const fanB = await ensureProfile(db, { email: 'b@b.com', fanSince: 0, displayName: null });
    expect(fanB.display_name).toBe('Fan');

    // Force the "candidate" the caller picked to collide: bypass
    // nextAvailableHandle's own collision-avoidance by handing updateProfile
    // the already-taken handle directly, exactly as update.ts would if two
    // concurrent regenerations raced to the same free slug and both read it
    // as available before either wrote.
    await expect(
      updateProfile(db, fanB.id, { displayName: 'Ana', handle: 'ana' }),
    ).resolves.toBeUndefined();

    const row = raw.prepare('SELECT display_name, handle, handle_changed_at FROM fan_profiles WHERE id = ?')
      .get(fanB.id);
    // No exception escaped, the display name was still persisted, and the
    // fan ended up on a real handle that is NOT "ana" (either a suffixed
    // retry candidate or, if even the retry collided, their prior handle).
    expect(row.display_name).toBe('Ana');
    expect(row.handle).not.toBe('ana');
    expect(row.handle).toBeTruthy();

    // "ana" itself must still belong exclusively to fan A — the collision
    // must never have been resolved by silently overwriting the other row.
    const fanA = raw.prepare('SELECT handle FROM fan_profiles WHERE email = ?').get('a@b.com');
    expect(fanA.handle).toBe('ana');
  });
});

describe('bio and fan-wall visibility (migration 0011)', () => {
  it('round-trips a bio through updateProfile and out via toPublicProfile', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await updateProfile(db, p.id, { bio: 'Modular and field recordings.' });
    const row = await getProfileByHandle(db, 'ana');
    expect(row.bio).toBe('Modular and field recordings.');
    expect(toPublicProfile(row, null).bio).toBe('Modular and field recordings.');
  });

  it('treats null as "clear the bio", not as "leave it alone"', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await updateProfile(db, p.id, { bio: 'something' });
    await updateProfile(db, p.id, { bio: null });
    expect((await getProfileByHandle(db, 'ana')).bio).toBeNull();
  });

  it('leaves the bio untouched when the field is absent from the update', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await updateProfile(db, p.id, { bio: 'keep me' });
    await updateProfile(db, p.id, { displayName: 'Ana Vex' });
    expect((await getProfileByHandle(db, 'ana')).bio).toBe('keep me');
  });

  it('reports a null bio for a fan who never wrote one', async () => {
    await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    expect(toPublicProfile(await getProfileByHandle(db, 'ana'), null).bio).toBeNull();
  });

  it('drops an unlisted fan from the directory but keeps their profile reachable', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await ensureProfile(db, { email: 'b@b.com', fanSince: 200, displayName: 'Bo' });
    expect((await getDirectory(db, { limit: 10, offset: 0 })).map(r => r.handle)).toEqual(['ana', 'bo']);

    await updateProfile(db, a.id, { hiddenFromWall: true });
    expect((await getDirectory(db, { limit: 10, offset: 0 })).map(r => r.handle)).toEqual(['bo']);
    // Unlisted, not deleted and not private: the direct lookup the profile
    // page uses still finds them.
    expect(await getProfileByHandle(db, 'ana')).toBeTruthy();
  });

  it('puts a fan back on the wall when they re-list', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await updateProfile(db, a.id, { hiddenFromWall: true });
    await updateProfile(db, a.id, { hiddenFromWall: false });
    expect((await getDirectory(db, { limit: 10, offset: 0 })).map(r => r.handle)).toEqual(['ana']);
  });
});

describe('purgeFanProfile — the real, irreversible delete', () => {
  it('removes the profile and its unlock ledger together', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await grantUnlocks(db, p.id, [
      { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' },
    ]);
    expect(await getUnlockedAvatarIds(db, p.id)).toEqual(['release:perception']);

    await purgeFanProfile(db, p.id);

    expect(await getProfileByHandle(db, 'ana')).toBeNull();
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_avatar_unlocks').get().c).toBe(0);
  });

  it('leaves every other fan alone', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await ensureProfile(db, { email: 'b@b.com', fanSince: 200, displayName: 'Bo' });
    await purgeFanProfile(db, a.id);
    expect(await getProfileByHandle(db, 'bo')).toBeTruthy();
  });

  it('frees the handle, so the fan can sign up again and reclaim it', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await purgeFanProfile(db, a.id);
    const again = await ensureProfile(db, { email: 'a@b.com', fanSince: 999, displayName: 'Ana' });
    expect(again.handle).toBe('ana');
  });
});

describe('softDeleteFanProfile — the 30-day grace period', () => {
  it('hides the profile from every fan-facing read straight away', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await softDeleteFanProfile(db, p.id, 1000);

    expect(await getProfileByHandle(db, 'ana')).toBeNull();
    expect(await getProfileByEmail(db, 'a@b.com')).toBeNull();
    expect(await getDirectory(db, { limit: 50, offset: 0 })).toEqual([]);
  });

  it('keeps the row — nothing about the profile is actually destroyed yet', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await updateProfile(db, p.id, { bio: 'a bio worth getting back' });
    await grantUnlocks(db, p.id, [
      { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' },
    ]);
    await softDeleteFanProfile(db, p.id, 1000);

    const pending = await getDeletedProfileByEmail(db, 'a@b.com');
    expect(pending.id).toBe(p.id);
    expect(pending.bio).toBe('a bio worth getting back');
    expect(pending.deleted_at).toBe(1000);
    // The unlock ledger is deliberately left intact — see softDeleteFanProfile.
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_avatar_unlocks').get().c).toBe(1);
  });

  it('reserves the handle for the whole window, so nobody can take it mid-restore', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await softDeleteFanProfile(db, a.id, 1000);

    // Invisible to the fan-facing lookup...
    expect(await getProfileByHandle(db, 'ana')).toBeNull();
    // ...but still unavailable to the next person called Ana.
    expect(await isHandleTaken(db, 'ana')).toBe(true);
    const other = await ensureProfile(db, { email: 'other@b.com', fanSince: 200, displayName: 'Ana' });
    expect(other.handle).not.toBe('ana');
  });

  it('restore brings the profile back exactly as it was, bio and all', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await updateProfile(db, p.id, { bio: 'still here' });
    await softDeleteFanProfile(db, p.id, 1000);
    await restoreFanProfile(db, p.id);

    const back = await getProfileByEmail(db, 'a@b.com');
    expect(back.id).toBe(p.id);
    expect(back.handle).toBe('ana');
    expect(back.bio).toBe('still here');
    expect(back.deleted_at).toBeNull();
    expect(await getDeletedProfileByEmail(db, 'a@b.com')).toBeNull();
  });

  it('a restored profile is back on the wall', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await softDeleteFanProfile(db, p.id, 1000);
    await restoreFanProfile(db, p.id);
    expect((await getDirectory(db, { limit: 50, offset: 0 })).map(r => r.handle)).toEqual(['ana']);
  });

  it('a soft-deleted fan does not count toward rarity denominators', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    const b = await ensureProfile(db, { email: 'b@b.com', fanSince: 100, displayName: 'Bo' });
    await grantUnlocks(db, a.id, [
      { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' },
    ]);
    await grantUnlocks(db, b.id, [
      { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' },
    ]);
    await softDeleteFanProfile(db, b.id, 1000);
    // 1 holder out of 1 live fan, not 2 — a deleted fan must not dilute rarity.
    expect((await getRarity(db))['release:perception']).toBe(1);
  });
});

describe('grace-window arithmetic', () => {
  const DAY = 24 * 60 * 60;

  it('a live profile is never expired', () => {
    expect(isGraceExpired(null, 999999999)).toBe(false);
  });

  it('is not expired anywhere inside the window, including the final second', () => {
    expect(isGraceExpired(1000, 1000)).toBe(false);
    expect(isGraceExpired(1000, 1000 + DELETE_GRACE_DAYS * DAY)).toBe(false);
  });

  it('is expired one second past the deadline', () => {
    expect(isGraceExpired(1000, 1000 + DELETE_GRACE_DAYS * DAY + 1)).toBe(true);
  });

  it('purgeDueAt is the deletion moment plus the whole window', () => {
    expect(purgeDueAt(1000)).toBe(1000 + DELETE_GRACE_DAYS * DAY);
  });
});

describe('purgeExpiredProfiles — the sweep', () => {
  const DAY = 24 * 60 * 60;
  const NOW = 100 * DAY;

  it('purges only profiles whose window has lapsed, and reports the count', async () => {
    const lapsed = await ensureProfile(db, { email: 'old@b.com', fanSince: 100, displayName: 'Old' });
    const recent = await ensureProfile(db, { email: 'new@b.com', fanSince: 100, displayName: 'New' });
    const live = await ensureProfile(db, { email: 'live@b.com', fanSince: 100, displayName: 'Live' });
    await softDeleteFanProfile(db, lapsed.id, NOW - (DELETE_GRACE_DAYS + 1) * DAY);
    await softDeleteFanProfile(db, recent.id, NOW - DAY);

    expect(await purgeExpiredProfiles(db, NOW)).toBe(1);

    expect(raw.prepare('SELECT COUNT(*) c FROM fan_profiles WHERE id = ?').get(lapsed.id).c).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_profiles WHERE id = ?').get(recent.id).c).toBe(1);
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_profiles WHERE id = ?').get(live.id).c).toBe(1);
  });

  it('takes the unlock ledger with it, and frees the handle for good', async () => {
    const p = await ensureProfile(db, { email: 'old@b.com', fanSince: 100, displayName: 'Old' });
    await grantUnlocks(db, p.id, [
      { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' },
    ]);
    await softDeleteFanProfile(db, p.id, NOW - (DELETE_GRACE_DAYS + 1) * DAY);

    await purgeExpiredProfiles(db, NOW);

    expect(raw.prepare('SELECT COUNT(*) c FROM fan_avatar_unlocks').get().c).toBe(0);
    expect(await isHandleTaken(db, 'old')).toBe(false);
  });

  it('is a no-op when nothing has lapsed', async () => {
    await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    expect(await purgeExpiredProfiles(db, NOW)).toBe(0);
  });
});

describe('xp_events — the ledger', () => {
  it('records a grant and sums it', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    expect(await sumLedgerXp(db, p.id)).toBe(0);

    const first = await recordXpEvent(db, {
      fanId: p.id, actionType: 'admin_grant', xpAmount: 250, eventKey: 'k1',
    });
    expect(first).toBe(true);
    expect(await sumLedgerXp(db, p.id)).toBe(250);
  });

  it('is idempotent — the same event_key twice awards once', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    expect(await recordXpEvent(db, { fanId: p.id, actionType: 'ticket_purchase', xpAmount: 400, eventKey: 'order-99' })).toBe(true);
    // A retried webhook sends the identical key. It must be a no-op that
    // reports success, not an error and not a second award.
    expect(await recordXpEvent(db, { fanId: p.id, actionType: 'ticket_purchase', xpAmount: 400, eventKey: 'order-99' })).toBe(false);
    expect(await sumLedgerXp(db, p.id)).toBe(400);
  });

  it('sums signed entries, so a correction is a negative row and not a deletion', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await recordXpEvent(db, { fanId: p.id, actionType: 'admin_grant', xpAmount: 500, eventKey: 'k1' });
    await recordXpEvent(db, { fanId: p.id, actionType: 'admin_correction', xpAmount: -200, eventKey: 'k2' });
    expect(await sumLedgerXp(db, p.id)).toBe(300);
    // Both rows survive — the history of the correction is the point.
    expect(await getXpEvents(db, p.id)).toHaveLength(2);
  });

  it('a voided event stops counting but stays readable, with its reason', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await recordXpEvent(db, { fanId: p.id, actionType: 'admin_grant', xpAmount: 500, eventKey: 'k1' });
    const [event] = await getXpEvents(db, p.id);

    await voidXpEvent(db, event.id, 'granted to the wrong fan');

    expect(await sumLedgerXp(db, p.id)).toBe(0);
    const [after] = await getXpEvents(db, p.id);
    expect(after.voided_reason).toBe('granted to the wrong fan');
    expect(after.xp_amount).toBe(500);
  });

  it('voiding twice does not double-stamp the reason', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await recordXpEvent(db, { fanId: p.id, actionType: 'admin_grant', xpAmount: 500, eventKey: 'k1' });
    const [event] = await getXpEvents(db, p.id);
    await voidXpEvent(db, event.id, 'first reason');
    await voidXpEvent(db, event.id, 'second reason');
    const [after] = await getXpEvents(db, p.id);
    expect(after.voided_reason).toBe('first reason');
  });

  it('keeps one fan\'s ledger out of another\'s', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    const b = await ensureProfile(db, { email: 'b@b.com', fanSince: 100, displayName: 'Bo' });
    await recordXpEvent(db, { fanId: a.id, actionType: 'admin_grant', xpAmount: 500, eventKey: 'k1' });
    expect(await sumLedgerXp(db, b.id)).toBe(0);
  });

  it('survives a soft delete, so a restored profile keeps its granted XP', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await recordXpEvent(db, { fanId: p.id, actionType: 'admin_grant', xpAmount: 500, eventKey: 'k1' });
    await softDeleteFanProfile(db, p.id, 1000);
    expect(await sumLedgerXp(db, p.id)).toBe(500);
    await restoreFanProfile(db, p.id);
    expect(await sumLedgerXp(db, p.id)).toBe(500);
  });

  it('a purge frees the Discord id, so that person can link a fresh profile', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await db.prepare(
      'INSERT INTO discord_links (fan_id, discord_user_id, discord_ep, linked_at) VALUES (?,?,?,?)',
    ).bind(p.id, '999', 40, 1).run();

    await purgeFanProfile(db, p.id);

    // discord_user_id is UNIQUE — a surviving row would lock that Discord
    // account out of the site forever, with no way for the fan to clear it.
    expect(raw.prepare('SELECT COUNT(*) c FROM discord_links').get().c).toBe(0);
  });

  it('is destroyed by a purge — a deleted fan leaves no ledger behind', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await recordXpEvent(db, { fanId: p.id, actionType: 'admin_grant', xpAmount: 500, eventKey: 'k1' });
    await purgeFanProfile(db, p.id);
    expect(raw.prepare('SELECT COUNT(*) c FROM xp_events').get().c).toBe(0);
  });

  it('stores metadata as JSON the admin inspector can read back', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    await recordXpEvent(db, {
      fanId: p.id, actionType: 'ticket_purchase', xpAmount: 400, eventKey: 'k1',
      sourceRef: 'cs_test_123', metadata: { show: 'brooklyn-2026-09-12', qty: 2 },
    });
    const [event] = await getXpEvents(db, p.id);
    expect(event.source_ref).toBe('cs_test_123');
    expect(JSON.parse(event.metadata).qty).toBe(2);
  });
});

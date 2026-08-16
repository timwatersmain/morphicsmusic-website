// End-to-end verification of the backfill chain: a customer's owned slugs
// (as they'd come from KV) through the unlock engine into the D1 ledger.
// This is the safety net for the KV/D1 split — if this ever breaks, an
// existing customer signing in for the first time after this feature ships
// would not see the avatars they already own.
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureProfile, grantUnlocks, getUnlockedAvatarIds } from '../../functions/_lib/community/repo';
import { evaluateUnlocks } from '../../functions/_lib/community/unlocks';
import { buildReleaseAvatars } from '../../scripts/sync-avatar-catalogue.mjs';
import { makeD1Shim } from './helpers/d1-shim.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');

const CATALOG = {
  releases: [
    { slug: 'perception', title: 'PERCEPTION', artwork: '/images/albums/perception.jpg' },
    { slug: 'swamp-logic', title: 'SWAMP LOGIC', artwork: '/images/albums/swamp-logic.jpg' },
  ],
};

let raw, db;
beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(UP);
  for (const a of buildReleaseAvatars(CATALOG)) {
    raw.prepare(`INSERT INTO avatar_catalogue
      (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(a.id, a.kind, a.release_slug, a.name, a.art_path, a.unlock_rule, a.hint, a.sort_order);
  }
  db = makeD1Shim(raw);
});

const catalogue = () => raw.prepare('SELECT * FROM avatar_catalogue').all();

describe('backfill of an existing customer', () => {
  it('grants avatars for everything they already owned before this feature existed', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 1000, displayName: 'Ana' });
    const grants = evaluateUnlocks({
      ownedSlugs: ['perception'], fanSince: 1000, now: 2000,
      streakWeeks: 0, showsAttended: [], gatesCompleted: [],
    }, catalogue());
    await grantUnlocks(db, profile.id, grants);
    expect(await getUnlockedAvatarIds(db, profile.id)).toEqual(['release:perception']);
  });

  it('is safe to run repeatedly — the second run grants nothing new', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 1000, displayName: 'Ana' });
    const ctx = {
      ownedSlugs: ['perception', 'swamp-logic'], fanSince: 1000, now: 2000,
      streakWeeks: 0, showsAttended: [], gatesCompleted: [],
    };
    await grantUnlocks(db, profile.id, evaluateUnlocks(ctx, catalogue()));
    const added = await grantUnlocks(db, profile.id, evaluateUnlocks(ctx, catalogue()));
    expect(added).toBe(0);
    expect(await getUnlockedAvatarIds(db, profile.id)).toHaveLength(2);
  });

  it('grants the new avatar when a fan buys another release later', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 1000, displayName: 'Ana' });
    const base = { fanSince: 1000, now: 2000, streakWeeks: 0, showsAttended: [], gatesCompleted: [] };
    await grantUnlocks(db, profile.id, evaluateUnlocks({ ...base, ownedSlugs: ['perception'] }, catalogue()));
    await grantUnlocks(db, profile.id, evaluateUnlocks({ ...base, ownedSlugs: ['perception', 'swamp-logic'] }, catalogue()));
    expect(await getUnlockedAvatarIds(db, profile.id)).toHaveLength(2);
  });

  it('grants nothing to a fan who owns nothing', async () => {
    const profile = await ensureProfile(db, { email: 'new@b.com', fanSince: 2000, displayName: 'New' });
    const grants = evaluateUnlocks({
      ownedSlugs: [], fanSince: 2000, now: 2000,
      streakWeeks: 0, showsAttended: [], gatesCompleted: [],
    }, catalogue());
    await grantUnlocks(db, profile.id, grants);
    expect(await getUnlockedAvatarIds(db, profile.id)).toEqual([]);
  });
});

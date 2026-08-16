// Tests for POST/DELETE /api/admin/grant-avatar — the only path that can
// ever put a tier-3/4 (duotone/glyph_overlay) avatar into
// fan_avatar_unlocks. Same harness pattern as endpoints.test.js: a real
// signed session cookie via functions/_lib/auth's signSession, a node:sqlite
// D1 shim, and a minimal KV stub.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeD1Shim } from './helpers/d1-shim.js';
import { signSession, SESSION_COOKIE } from '../../functions/_lib/auth';
import { ensureProfile, getUnlockedAvatarIds } from '../../functions/_lib/community/repo';
import { onRequestPost as grantPost, onRequestDelete as grantDelete } from '../../functions/api/admin/grant-avatar';
import { onRequestPost as updatePost } from '../../functions/api/community/update';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');
const MIGRATION3 = readFileSync(join(root, 'migrations/0003_handle_locked.sql'), 'utf8');
const MIGRATION4 = readFileSync(join(root, 'migrations/0004_handle_cooldown.sql'), 'utf8');
const MIGRATION5 = readFileSync(join(root, 'migrations/0005_avatar_tiers.sql'), 'utf8');

const AUTH_SECRET = 'test-only-secret-not-real';
const ADMIN_EMAIL = 'admin@morphicsmusic.com';
const FAN_EMAIL = 'fan-for-admin-test@example.com';
const TIER3_ID = 'tier3:duotone:cyan:dscf3589';

function makeKvStub() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

let raw, db, kv, env;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(MIGRATION);
  raw.exec(MIGRATION3);
  raw.exec(MIGRATION4);
  raw.exec(MIGRATION5);
  raw.exec(`INSERT INTO avatar_catalogue
    (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order, style, colourway, artwork_key, tier)
    VALUES ('${TIER3_ID}', 'special', NULL, 'Duotone Cyan', '/v.webp', '{"type":"manual"}', 'gift', 0, 'duotone', 'cyan', 'dscf3589', 3)`);
  db = makeD1Shim(raw);
  kv = makeKvStub();
  env = { AUTH_SECRET, DOWNLOADS: kv, GATES: db, ADMIN_EMAILS: `${ADMIN_EMAIL}, other-admin@x.com` };
});

async function cookieFor(email) {
  const value = await signSession(AUTH_SECRET, email, 0);
  return `${SESSION_COOKIE}=${value}`;
}

function req(url, opts = {}) {
  return new Request(url, opts);
}

describe('POST /api/admin/grant-avatar', () => {
  it('a non-admin (signed-out) caller gets a bare 404, not 403', async () => {
    const res = await grantPost({
      request: req('https://morphicsmusic.com/api/admin/grant-avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: FAN_EMAIL, avatar_id: TIER3_ID }),
      }),
      env,
    });
    expect(res.status).toBe(404);
  });

  it('a signed-in fan who is not in ADMIN_EMAILS gets a bare 404', async () => {
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
    const cookie = await cookieFor(FAN_EMAIL);
    const res = await grantPost({
      request: req('https://morphicsmusic.com/api/admin/grant-avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ email: FAN_EMAIL, avatar_id: TIER3_ID }),
      }),
      env,
    });
    expect(res.status).toBe(404);
  });

  it('an admin can grant a tier-3 avatar, and it becomes equippable', async () => {
    const profile = await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
    const adminCookie = await cookieFor(ADMIN_EMAIL);

    const res = await grantPost({
      request: req('https://morphicsmusic.com/api/admin/grant-avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ email: FAN_EMAIL, avatar_id: TIER3_ID }),
      }),
      env,
    });
    expect(res.status).toBe(200);
    expect(await getUnlockedAvatarIds(db, profile.id)).toContain(TIER3_ID);

    const fanCookie = await cookieFor(FAN_EMAIL);
    const equip = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fanCookie },
        body: JSON.stringify({ equipped_avatar_id: TIER3_ID }),
      }),
      env,
    });
    expect(equip.status).toBe(200);
    const stored = raw.prepare('SELECT equipped_avatar_id FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(stored.equipped_avatar_id).toBe(TIER3_ID);
  });

  it('an admin can revoke a previously granted avatar', async () => {
    const profile = await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
    const adminCookie = await cookieFor(ADMIN_EMAIL);

    await grantPost({
      request: req('https://morphicsmusic.com/api/admin/grant-avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ email: FAN_EMAIL, avatar_id: TIER3_ID }),
      }),
      env,
    });
    expect(await getUnlockedAvatarIds(db, profile.id)).toContain(TIER3_ID);

    const res = await grantDelete({
      request: req('https://morphicsmusic.com/api/admin/grant-avatar', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ email: FAN_EMAIL, avatar_id: TIER3_ID }),
      }),
      env,
    });
    expect(res.status).toBe(200);
    expect(await getUnlockedAvatarIds(db, profile.id)).not.toContain(TIER3_ID);
  });
});

describe('POST /api/community/update — tier-1 equips with no unlock row', () => {
  it('accepts a tier-1 avatar without ever writing/checking fan_avatar_unlocks', async () => {
    raw.exec(`INSERT INTO avatar_catalogue
      (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order, style, colourway, tier)
      VALUES ('tier1:glyph_solid:cyan', 'special', NULL, 'Signal Cyan', '(procedural)', '{"type":"tier1_default"}', 'hint', 0, 'glyph_solid', 'cyan', 1)`);
    const profile = await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
    expect(await getUnlockedAvatarIds(db, profile.id)).toEqual([]);
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ equipped_avatar_id: 'tier1:glyph_solid:cyan' }),
      }),
      env,
    });
    expect(res.status).toBe(200);
    const stored = raw.prepare('SELECT equipped_avatar_id FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(stored.equipped_avatar_id).toBe('tier1:glyph_solid:cyan');
    // Still no ledger row — availability came from the tier column, not a grant.
    expect(await getUnlockedAvatarIds(db, profile.id)).toEqual([]);
  });

  it('a tier-2 avatar is still refused without an unlock row', async () => {
    raw.exec(`INSERT INTO avatar_catalogue
      (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order, style, colourway, tier)
      VALUES ('tier2:glyph_inverted:cyan', 'special', NULL, 'Verified Cyan', '(procedural)', '{"type":"has_password"}', 'hint', 0, 'glyph_inverted', 'cyan', 2)`);
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ equipped_avatar_id: 'tier2:glyph_inverted:cyan' }),
      }),
      env,
    });
    expect(res.status).toBe(403);
  });
});

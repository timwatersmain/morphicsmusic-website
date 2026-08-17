// Endpoint-level tests for the four /api/community routes built in Tasks 6
// and 7. The briefs for those tasks specify no tests; this file closes that
// gap because these endpoints carry the project's single hardest guarantee —
// a fan's email must NEVER appear in a response — and because nothing else
// verifies the fans-only auth gate actually rejects signed-out callers.
//
// These are plain exported functions taking { request, env }, so they run
// directly under Node/Vitest with no workers runtime: a D1 handle from the
// existing node:sqlite shim, a minimal KV stub, and a real signed session
// cookie (via the actual signSession from functions/_lib/auth.ts, not a
// bypass) stand in for the Pages runtime bindings.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeD1Shim } from './helpers/d1-shim.js';
import { signSession, SESSION_COOKIE } from '../../functions/_lib/auth';
import { ensureProfile, grantUnlocks, HANDLE_CHANGE_COOLDOWN_DAYS } from '../../functions/_lib/community/repo';

import { onRequestGet as meGet } from '../../functions/api/community/me';
import { onRequestPost as updatePost } from '../../functions/api/community/update';
import { onRequestGet as profileGet } from '../../functions/api/community/profile';
import { onRequestGet as directoryGet } from '../../functions/api/community/directory';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');
const MIGRATION3 = readFileSync(join(root, 'migrations/0003_handle_locked.sql'), 'utf8');
const MIGRATION4 = readFileSync(join(root, 'migrations/0004_handle_cooldown.sql'), 'utf8');
const MIGRATION5 = readFileSync(join(root, 'migrations/0005_avatar_tiers.sql'), 'utf8');
const MIGRATION6 = readFileSync(join(root, 'migrations/0006_creatures.sql'), 'utf8');
const MIGRATION7 = readFileSync(join(root, 'migrations/0007_sprites.sql'), 'utf8');
const MIGRATION8 = readFileSync(join(root, 'migrations/0008_sprite_override.sql'), 'utf8');

const AUTH_SECRET = 'test-only-secret-not-real';
const FAN_EMAIL = 'endpoint-fan@example.com';

// A rule that can never be satisfied by a freshly created fan (tenure_days
// with an absurdly large threshold), so this avatar reliably stays locked —
// exactly what the "equip a locked avatar" test needs.
const LOCKED_AVATAR_ID = 'special:unreachable';

function makeKvStub() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

function seedCatalogue(raw) {
  raw.exec(`INSERT INTO avatar_catalogue (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order)
    VALUES ('release:perception','release','perception','PERCEPTION','/a.webp',
            '{"type":"own_release","slug":"perception"}','Own PERCEPTION',0)`);
  raw.exec(`INSERT INTO avatar_catalogue (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order)
    VALUES ('${LOCKED_AVATAR_ID}','special',NULL,'Unreachable','/u.webp',
            '{"type":"tenure_days","days":999999}','Never happens',1)`);
}

let raw, db, kv, env;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(MIGRATION);
  raw.exec(MIGRATION3);
  raw.exec(MIGRATION4);
  raw.exec(MIGRATION5);
  raw.exec(MIGRATION6);
  raw.exec(MIGRATION7);
  raw.exec(MIGRATION8);
  seedCatalogue(raw);
  db = makeD1Shim(raw);
  kv = makeKvStub();
  env = { AUTH_SECRET, DOWNLOADS: kv, GATES: db };
});

async function cookieFor(email, ver = 0) {
  const value = await signSession(AUTH_SECRET, email, ver);
  return `${SESSION_COOKIE}=${value}`;
}

function req(url, opts = {}) {
  return new Request(url, opts);
}

// Recursively check that no object key is literally "email" anywhere in a
// parsed JSON body. Catches a future accidental spread of a raw DB row even
// if the value itself doesn't match the test email string.
function hasEmailKey(value) {
  if (Array.isArray(value)) return value.some(hasEmailKey);
  if (value && typeof value === 'object') {
    return Object.keys(value).some(k => k === 'email') ||
      Object.values(value).some(hasEmailKey);
  }
  return false;
}

describe('signed-out requests', () => {
  it('GET /api/community/me returns 401 with no profile data', async () => {
    const res = await meGet({ request: req('https://morphicsmusic.com/api/community/me'), env });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('POST /api/community/update returns 401 with no profile data', async () => {
    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: 'Someone' }),
      }),
      env,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('GET /api/community/profile returns 401 with no profile data', async () => {
    const res = await profileGet({
      request: req('https://morphicsmusic.com/api/community/profile?handle=anyone'),
      env,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('GET /api/community/directory returns 401 with no profile data', async () => {
    const res = await directoryGet({
      request: req('https://morphicsmusic.com/api/community/directory'),
      env,
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });
});

describe('no email in any response body', () => {
  let cookie, handle;

  beforeEach(async () => {
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000) - 86400, displayName: 'Endpoint Fan',
    });
    handle = profile.handle;
    cookie = await cookieFor(FAN_EMAIL);
  });

  it('GET /api/community/me', async () => {
    const res = await meGet({
      request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }),
      env,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(FAN_EMAIL);
    expect(hasEmailKey(JSON.parse(text))).toBe(false);
  });

  it('GET /api/community/profile', async () => {
    const res = await profileGet({
      request: req(`https://morphicsmusic.com/api/community/profile?handle=${handle}`, {
        headers: { Cookie: cookie },
      }),
      env,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(FAN_EMAIL);
    expect(hasEmailKey(JSON.parse(text))).toBe(false);
  });

  it('GET /api/community/directory', async () => {
    const res = await directoryGet({
      request: req('https://morphicsmusic.com/api/community/directory', { headers: { Cookie: cookie } }),
      env,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(FAN_EMAIL);
    expect(hasEmailKey(JSON.parse(text))).toBe(false);
  });
});

// toPublicProfile() sends the tier-ladder recipe fields for an equipped
// avatar (style/colourway/artwork_key/tier) so tiers 1/2/4 can render for
// anyone, not just the signed-in fan looking at themselves — but never a
// per-fan glyph letter (that derivation, and the KV lookup behind it, has
// been removed: the pixel-sprite creature is every fan's public avatar now).
// The login username must still never appear in a public payload.
describe('public avatar payload — tier recipe fields, never the username', () => {
  const SEEDED_TIER1_ID = 'tier:test-cyan-1';

  function seedTier1(rawDb) {
    rawDb.exec(`INSERT INTO avatar_catalogue
      (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order,style,colourway,artwork_key,tier)
      VALUES ('${SEEDED_TIER1_ID}','special',NULL,'Cyan I','(procedural)',
              '{"type":"tier1_default"}','Everyone starts here',2,'glyph_solid','cyan',NULL,1)`);
  }

  it('a public profile carries style/colourway/artwork_key/tier, never a glyph field or the username', async () => {
    seedTier1(raw);
    const email = 'secretname-fan@example.com';
    await kv.put(`customer:${email}`, JSON.stringify({
      username: 'secretname', first_seen_at: Math.floor(Date.now() / 1000), purchases: [],
    }));
    await ensureProfile(db, {
      email, fanSince: Math.floor(Date.now() / 1000), displayName: 'Secret Fan', username: 'secretname',
    });
    // ensureProfile seeds BOTH the handle and the display_name FROM the
    // username at creation (by design — see repo.ts), so a freshly-created
    // profile's handle and display_name would themselves literally be the
    // string "secretname" here, defeating this test's purpose. Move both
    // somewhere unrelated first, exactly as a real fan can via
    // /api/community/update, so a pass here actually proves the login
    // username stays off the wire — not just that the coincidental defaults
    // haven't been touched yet.
    await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: await cookieFor(email) },
        body: JSON.stringify({
          handle: 'public-handle-unrelated', display_name: 'Public Display Name',
          equipped_avatar_id: SEEDED_TIER1_ID,
        }),
      }),
      env,
    });

    const viewerCookie = await cookieFor(FAN_EMAIL);
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Viewer' });

    const res = await profileGet({
      request: req('https://morphicsmusic.com/api/community/profile?handle=public-handle-unrelated', {
        headers: { Cookie: viewerCookie },
      }),
      env,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);

    expect(body.profile.handle).toBe('public-handle-unrelated');
    expect(body.profile.avatar.style).toBe('glyph_solid');
    expect(body.profile.avatar.colourway).toBe('cyan');
    expect(body.profile.avatar.tier).toBe(1);
    expect('glyph' in body.profile.avatar).toBe(false);

    // The hard constraint: the login username must never appear anywhere in
    // the serialised body.
    expect(text).not.toContain('secretname');
  });

  it('the directory carries the same avatar shape as the profile endpoint', async () => {
    seedTier1(raw);
    const email = 'shape-fan@example.com';
    await kv.put(`customer:${email}`, JSON.stringify({
      username: 'shapefan', first_seen_at: Math.floor(Date.now() / 1000), purchases: [],
    }));
    const profile = await ensureProfile(db, {
      email, fanSince: Math.floor(Date.now() / 1000), displayName: 'Shape Fan', username: 'shapefan',
    });
    await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: await cookieFor(email) },
        body: JSON.stringify({ equipped_avatar_id: SEEDED_TIER1_ID }),
      }),
      env,
    });

    const viewerCookie = await cookieFor(FAN_EMAIL);
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Viewer' });

    const profileRes = await profileGet({
      request: req(`https://morphicsmusic.com/api/community/profile?handle=${profile.handle}`, {
        headers: { Cookie: viewerCookie },
      }),
      env,
    });
    const dirRes = await directoryGet({
      request: req('https://morphicsmusic.com/api/community/directory', { headers: { Cookie: viewerCookie } }),
      env,
    });
    const profileBody = await profileRes.json();
    const dirBody = await dirRes.json();
    const dirEntry = dirBody.fans.find(f => f.handle === profile.handle);

    expect(Object.keys(dirEntry.avatar).sort()).toEqual(Object.keys(profileBody.profile.avatar).sort());
    expect(dirEntry.avatar).toEqual(profileBody.profile.avatar);
  });
});

describe('POST /api/community/update — equipping a locked avatar', () => {
  it('is refused with 403 and does not change the stored profile', async () => {
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ equipped_avatar_id: LOCKED_AVATAR_ID }),
      }),
      env,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'not_unlocked' });

    const stored = raw.prepare('SELECT equipped_avatar_id FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(stored.equipped_avatar_id).toBeNull();
  });

  it('succeeds once the avatar has actually been unlocked', async () => {
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    await grantUnlocks(db, profile.id, [
      { avatarId: LOCKED_AVATAR_ID, source: 'tenure_days', sourceRef: null },
    ]);
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ equipped_avatar_id: LOCKED_AVATAR_ID }),
      }),
      env,
    });
    expect(res.status).toBe(200);
    const stored = raw.prepare('SELECT equipped_avatar_id FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(stored.equipped_avatar_id).toBe(LOCKED_AVATAR_ID);
  });
});

describe('POST /api/community/update — blocked display names', () => {
  it('rejects a name like "admin" with 400', async () => {
    await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ display_name: 'admin' }),
      }),
      env,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'blocked_name' });
  });
});

// The blocklist exists to stop FANS from impersonating the artist. The site
// owner himself must still be able to use his own name — gated strictly on
// an authenticated admin session (env.ADMIN_EMAILS + a verified cookie),
// never on anything the request claims about itself.
describe('POST /api/community/update — admin name bypass', () => {
  const ADMIN_EMAIL = 'owner@example.com';

  it('a non-admin session is still refused a blocked display name and handle', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL; // admin exists, but THIS caller isn't them
    await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    const cookie = await cookieFor(FAN_EMAIL);

    const nameRes = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ display_name: 'moderator' }),
      }),
      env,
    });
    expect(nameRes.status).toBe(400);
    expect((await nameRes.json()).error).toBe('blocked_name');

    const handleRes = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: 'moderator' }),
      }),
      env,
    });
    expect(handleRes.status).toBe(400);
    expect((await handleRes.json()).error).toBe('blocked_handle');
  });

  it('an admin session may set a blocked display name and handle', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL;
    await ensureProfile(db, {
      email: ADMIN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Owner',
    });
    const cookie = await cookieFor(ADMIN_EMAIL);

    const nameRes = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ display_name: 'Morphics' }),
      }),
      env,
    });
    expect(nameRes.status).toBe(200);

    const handleRes = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: 'morphicsmusic' }),
      }),
      env,
    });
    expect(handleRes.status).toBe(200);

    const row = raw.prepare('SELECT display_name, handle FROM fan_profiles WHERE email = ?').get(ADMIN_EMAIL);
    expect(row.display_name).toBe('Morphics');
    expect(row.handle).toBe('morphicsmusic');
  });

  it('an admin is still subject to length/char-set validation and the handle cooldown', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL;
    const profile = await ensureProfile(db, {
      email: ADMIN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Owner',
    });
    const cookie = await cookieFor(ADMIN_EMAIL);

    // Display name too short still fails, admin or not.
    const tooShort = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ display_name: 'x' }),
      }),
      env,
    });
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).error).toBe('invalid_name');

    // First (blocked) handle change succeeds and starts the cooldown...
    const first = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: 'admin' }),
      }),
      env,
    });
    expect(first.status).toBe(200);

    // ...so a second change, even to another blocked name, is still
    // cooldown-limited exactly like a fan's would be.
    const second = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: 'official' }),
      }),
      env,
    });
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe('handle_cooldown');

    const row = raw.prepare('SELECT handle FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle).toBe('admin');
  });

  it('with ADMIN_EMAILS unset, nobody is an admin and blocked names stay blocked', async () => {
    delete env.ADMIN_EMAILS;
    await ensureProfile(db, {
      email: ADMIN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Owner',
    });
    const cookie = await cookieFor(ADMIN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ display_name: 'moderator' }),
      }),
      env,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('blocked_name');
  });
});

// The admin-only permanent sprite override (migration 0008) — lets the site
// owner wear any of the 401 sprites regardless of his own stage. Gated on
// the exact same requireAdmin session check as the name/handle bypass
// above, reused rather than duplicated (see update.ts).
describe('POST /api/community/update — override_sprite (admin-only)', () => {
  const ADMIN_EMAIL = 'owner-sprite@example.com';

  it('a non-admin session is refused, and the stored value is unchanged', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL; // admin exists, but THIS caller isn't them
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ override_sprite: 'A001' }),
      }),
      env,
    });
    expect(res.status).toBe(403);

    // Assert against the database, not just the response.
    const row = raw.prepare('SELECT override_sprite FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.override_sprite).toBeNull();
  });

  it('a non-admin cannot even clear an override with null — same refusal', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL;
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    raw.prepare('UPDATE fan_profiles SET override_sprite = ? WHERE id = ?').run('A001', profile.id);
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ override_sprite: null }),
      }),
      env,
    });
    expect(res.status).toBe(403);
    const row = raw.prepare('SELECT override_sprite FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.override_sprite).toBe('A001');
  });

  it('an admin can set an override, and can clear it again with null', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL;
    const profile = await ensureProfile(db, {
      email: ADMIN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Owner',
    });
    const cookie = await cookieFor(ADMIN_EMAIL);

    const setRes = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ override_sprite: 'A001' }),
      }),
      env,
    });
    expect(setRes.status).toBe(200);
    expect(raw.prepare('SELECT override_sprite FROM fan_profiles WHERE id = ?').get(profile.id).override_sprite)
      .toBe('A001');

    const clearRes = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ override_sprite: null }),
      }),
      env,
    });
    expect(clearRes.status).toBe(200);
    expect(raw.prepare('SELECT override_sprite FROM fan_profiles WHERE id = ?').get(profile.id).override_sprite)
      .toBeNull();
  });

  it('an admin gets refused for a made-up or non-existent sprite ref', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL;
    const profile = await ensureProfile(db, {
      email: ADMIN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Owner',
    });
    const cookie = await cookieFor(ADMIN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ override_sprite: 'NOT-A-REAL-REF' }),
      }),
      env,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_sprite');
    expect(raw.prepare('SELECT override_sprite FROM fan_profiles WHERE id = ?').get(profile.id).override_sprite)
      .toBeNull();
  });

  it('the override changes the rendered sprite but not the rank label, and XP mode follows the override sprite\'s own stage', async () => {
    env.ADMIN_EMAILS = ADMIN_EMAIL;
    const nowSec = Math.floor(Date.now() / 1000);
    const profile = await ensureProfile(db, { email: ADMIN_EMAIL, fanSince: nowSec, displayName: 'Owner' });
    // Force the admin's REAL stage to 'egg' — an adult override on an egg
    // fan is exactly the "look grown, still ranked Egg" scenario the spec
    // calls out.
    raw.prepare("UPDATE fan_profiles SET stage = 'egg', ep = 0 WHERE id = ?").run(profile.id);
    const cookie = await cookieFor(ADMIN_EMAIL);

    await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ override_sprite: 'A001' }), // A001 = adult stage sprite
      }),
      env,
    });

    const res = await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env });
    const body = await res.json();
    // Sprite shown is the adult override...
    expect(body.profile.creature.sprite_ref).toBe('A001');
    // ...but the rank/stage the fan has actually earned is untouched.
    expect(body.profile.creature.stage).toBe('egg');
    // XP mode itself (crack vs grow) is derived client-side from the
    // rendered sprite's OWN `stage` field (see recipes.js's frame(), which
    // reads sprite.stage, not the fan's) once the client fetches the full
    // sprite record by this ref — the server's only job is to hand back the
    // correct ref, which this asserts.
  });
});

// Whole-branch review Fix 1: record.name in the KV customer blob is the
// Stripe cardholder's LEGAL NAME (customer_details.name). It must never
// reach display_name or, through the handle derivation, a public URL — and
// once a fan does pick their own name, the handle should regenerate exactly
// once so they are not stuck on a placeholder like "fan-7" forever.
describe('GET /api/community/me — Stripe name never becomes a public identifier', () => {
  it('does not use the KV record name for display_name or handle', async () => {
    await kv.put(`customer:${FAN_EMAIL}`, JSON.stringify({
      name: 'Jane Smith',
      first_seen_at: Math.floor(Date.now() / 1000) - 86400,
      purchases: [],
    }));
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await meGet({
      request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }),
      env,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.profile.display_name).not.toBe('Jane Smith');
    expect(body.profile.display_name).toBe('Fan');
    expect(body.profile.handle).not.toContain('jane');
    expect(body.profile.handle).not.toContain('smith');

    const stored = raw.prepare('SELECT display_name, handle FROM fan_profiles WHERE email = ?').get(FAN_EMAIL);
    expect(stored.display_name).toBe('Fan');
    expect(stored.handle).not.toContain('jane');
    expect(stored.handle).not.toContain('smith');
  });
});

// Old model: changing display_name auto-regenerated the handle once, gated
// by the now-removed handle_locked flag. New model: username/handle/
// display_name are three independent things — a display_name change must
// never move the handle, and the handle only ever changes through an
// explicit `handle` field on this same endpoint, subject to a cooldown
// rather than a one-shot permanent lock.
describe('POST /api/community/update — display_name changes never touch the handle', () => {
  it('does not regenerate the handle when a fan first sets a display name', async () => {
    // Mirrors how /api/community/me creates a purchase-only profile: no
    // username, so it lands on the untouched default 'Fan' and a
    // placeholder handle.
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: null,
    });
    expect(profile.display_name).toBe('Fan');
    const placeholderHandle = profile.handle;
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ display_name: 'Ana Vex' }),
      }),
      env,
    });
    expect(res.status).toBe(200);

    const stored = raw.prepare('SELECT display_name, handle FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(stored.display_name).toBe('Ana Vex');
    expect(stored.handle).toBe(placeholderHandle);
  });

  it('does not move the handle across repeated renames, including back to "Fan"', async () => {
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: null,
    });
    const originalHandle = profile.handle;
    const cookie = await cookieFor(FAN_EMAIL);
    const rename = async (name) => updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ display_name: name }),
      }),
      env,
    });

    await rename('First Real Name');
    await rename('Fan');
    await rename('Totally New Identity');

    const row = raw.prepare('SELECT handle FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle).toBe(originalHandle);
  });
});

// Regression coverage for the glyph-derivation removal: directory.ts used to
// perform up to one `customer:` KV get per fan on the page (deriving a
// letter nothing displays), which on a 40-fan page pushed close to
// Cloudflare Free's 50-subrequest cap. That lookup is gone — this suite
// proves it stays gone by counting `customer:` KV gets directly through the
// stub, for a full page of fans wearing every avatar shape (none, legacy
// release art, tier-1 glyph-styled, tier-3 duotone) rather than asserting on
// timing.
describe('GET /api/community/directory — no per-fan KV reads', () => {
  const TIER1_AVATAR_ID = 'tier:test-glyph-1';
  const DUOTONE_AVATAR_ID = 'tier:test-duotone-3';

  function seedTier1AndDuotone(rawDb) {
    rawDb.exec(`INSERT INTO avatar_catalogue
      (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order,style,colourway,artwork_key,tier)
      VALUES ('${TIER1_AVATAR_ID}','special',NULL,'Cyan I','(procedural)',
              '{"type":"tier1_default"}','Everyone starts here',2,'glyph_solid','cyan',NULL,1)`);
    rawDb.exec(`INSERT INTO avatar_catalogue
      (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order,style,colourway,artwork_key,tier)
      VALUES ('${DUOTONE_AVATAR_ID}','special',NULL,'Duotone III','(procedural)',
              '{"type":"tenure_days","days":0}','Tier 3',3,'duotone','cyan','some-art',3)`);
  }

  // Wraps the shared KV stub so `customer:` gets are counted separately from
  // rate-limit / session-version traffic on the same binding.
  function countingKv(base) {
    let customerGets = 0;
    return {
      async get(key) {
        if (key.startsWith('customer:')) customerGets++;
        return base.get(key);
      },
      async put(key, value, opts) { return base.put(key, value, opts); },
      async delete(key) { return base.delete(key); },
      get customerGets() { return customerGets; },
    };
  }

  async function makeFan(email, username, avatarId) {
    await kv.put(`customer:${email}`, JSON.stringify({
      username, first_seen_at: Math.floor(Date.now() / 1000), purchases: [],
    }));
    const profile = await ensureProfile(db, {
      email, fanSince: Math.floor(Date.now() / 1000), displayName: username, username,
    });
    // Equipping is gated on holding the avatar (see update.ts's not_unlocked
    // check) — grant it directly rather than satisfying its real unlock
    // rule, which is irrelevant to what this test is checking.
    await grantUnlocks(db, profile.id, [{ avatarId, source: 'test', sourceRef: null }]);
    await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: await cookieFor(email) },
        body: JSON.stringify({ equipped_avatar_id: avatarId }),
      }),
      env,
    });
  }

  it('a full page of fans, wearing every avatar shape, performs zero customer KV reads', async () => {
    seedTier1AndDuotone(raw);
    await makeFan('tier1-a@example.com', 'tier1a', TIER1_AVATAR_ID);
    await makeFan('tier1-b@example.com', 'tier1b', TIER1_AVATAR_ID);
    await makeFan('duotone-a@example.com', 'duotonea', DUOTONE_AVATAR_ID);
    for (let i = 0; i < 3; i++) {
      await ensureProfile(db, {
        email: `noavatar-${i}@example.com`, fanSince: Math.floor(Date.now() / 1000), displayName: `Fan${i}`,
      });
    }
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Viewer' });

    const wrappedKv = countingKv(kv);
    const testEnv = { ...env, DOWNLOADS: wrappedKv };
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await directoryGet({
      request: req('https://morphicsmusic.com/api/community/directory', { headers: { Cookie: cookie } }),
      env: testEnv,
    });
    expect(res.status).toBe(200);
    const { fans } = await res.json();
    expect(fans.some(f => f.avatar?.id === TIER1_AVATAR_ID)).toBe(true);
    expect(fans.some(f => f.avatar?.id === DUOTONE_AVATAR_ID)).toBe(true);
    expect(wrappedKv.customerGets).toBe(0);
  });

  it('a limit above the cap is clamped to the maximum page size', async () => {
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Viewer' });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await directoryGet({
      request: req('https://morphicsmusic.com/api/community/directory?limit=100', { headers: { Cookie: cookie } }),
      env,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBeLessThanOrEqual(40);
  });
});

describe('POST /api/community/update — handle changes (30-day cooldown, not a permanent lock)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a first handle change succeeds and stamps handle_changed_at', async () => {
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    expect(profile.handle_changed_at).toBeNull();
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: 'ana-vex' }),
      }),
      env,
    });
    expect(res.status).toBe(200);

    const row = raw.prepare('SELECT handle, handle_changed_at FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle).toBe('ana-vex');
    expect(row.handle_changed_at).not.toBeNull();
  });

  it('rejects a second change within 30 days, with the next-allowed date in the error', async () => {
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    let cookie = await cookieFor(FAN_EMAIL);
    const change = async (handle) => updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle }),
      }),
      env,
    });

    await change('first-handle');
    const afterFirst = raw.prepare('SELECT handle, handle_changed_at FROM fan_profiles WHERE id = ?').get(profile.id);

    vi.useFakeTimers();
    vi.setSystemTime((afterFirst.handle_changed_at + 5 * 24 * 60 * 60) * 1000); // 5 days later
    // Re-sign so the session's own 30-day expiry (unrelated to the handle
    // cooldown) tracks the injected clock instead of going stale.
    cookie = await cookieFor(FAN_EMAIL);

    const res = await change('second-handle');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('handle_cooldown');
    expect(body.next_change_at).toBe(afterFirst.handle_changed_at + HANDLE_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60);

    const row = raw.prepare('SELECT handle FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle).toBe('first-handle');
  });

  it('succeeds again once the cooldown has fully elapsed', async () => {
    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    let cookie = await cookieFor(FAN_EMAIL);
    const change = async (handle) => updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle }),
      }),
      env,
    });

    await change('first-handle');
    const afterFirst = raw.prepare('SELECT handle_changed_at FROM fan_profiles WHERE id = ?').get(profile.id);

    vi.useFakeTimers();
    vi.setSystemTime((afterFirst.handle_changed_at + HANDLE_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 + 1) * 1000);
    // Re-sign so the session's own 30-day expiry (unrelated to the handle
    // cooldown) tracks the injected clock instead of going stale.
    cookie = await cookieFor(FAN_EMAIL);

    const res = await change('second-handle');
    expect(res.status).toBe(200);
    const row = raw.prepare('SELECT handle FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle).toBe('second-handle');
  });

  it('rejects taking a handle someone else already holds, rather than suffixing it', async () => {
    await ensureProfile(db, { email: 'other@b.com', fanSince: 0, displayName: 'Someone Else' });
    const otherHandle = raw.prepare('SELECT handle FROM fan_profiles WHERE email = ?').get('other@b.com').handle;

    const profile = await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: otherHandle }),
      }),
      env,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('handle_taken');

    const row = raw.prepare('SELECT handle FROM fan_profiles WHERE id = ?').get(profile.id);
    expect(row.handle).toBe(profile.handle);
  });

  it('rejects a blocked handle like "admin"', async () => {
    await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
    });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: 'admin' }),
      }),
      env,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('blocked_handle');
  });

  it('changing the handle leaves the login username untouched', async () => {
    await kv.put(`customer:${FAN_EMAIL}`, JSON.stringify({
      username: 'original_username',
      first_seen_at: Math.floor(Date.now() / 1000),
      purchases: [],
    }));
    await ensureProfile(db, {
      email: FAN_EMAIL, fanSince: Math.floor(Date.now() / 1000), displayName: 'Endpoint Fan',
      username: 'original_username',
    });
    const cookie = await cookieFor(FAN_EMAIL);

    const res = await updatePost({
      request: req('https://morphicsmusic.com/api/community/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ handle: 'a-brand-new-handle' }),
      }),
      env,
    });
    expect(res.status).toBe(200);

    // The customer KV record — where the login username actually lives — is
    // untouched by a community handle change.
    const record = JSON.parse(await kv.get(`customer:${FAN_EMAIL}`));
    expect(record.username).toBe('original_username');
  });
});

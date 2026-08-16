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

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeD1Shim } from './helpers/d1-shim.js';
import { signSession, SESSION_COOKIE } from '../../functions/_lib/auth';
import { ensureProfile, grantUnlocks } from '../../functions/_lib/community/repo';

import { onRequestGet as meGet } from '../../functions/api/community/me';
import { onRequestPost as updatePost } from '../../functions/api/community/update';
import { onRequestGet as profileGet } from '../../functions/api/community/profile';
import { onRequestGet as directoryGet } from '../../functions/api/community/directory';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');

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

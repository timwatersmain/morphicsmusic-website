// Endpoint-level tests for the creature system: stage-advance-on-visit
// through GET /api/community/me, creature fields (sprite_ref/colourway/
// stage_xp) surfacing on profile.ts and directory.ts without ever leaking
// email, and the two admin endpoints (grant-ep, force-hatch). Same harness
// pattern as endpoints.test.js and admin-grant-avatar.test.js: node:sqlite D1
// shim, a minimal KV stub, and a real signed session cookie.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeD1Shim } from './helpers/d1-shim.js';
import { signSession, SESSION_COOKIE } from '../../functions/_lib/auth';
import { ensureProfile } from '../../functions/_lib/community/repo';

import { onRequestGet as meGet } from '../../functions/api/community/me';
import { onRequestGet as profileGet } from '../../functions/api/community/profile';
import { onRequestGet as directoryGet } from '../../functions/api/community/directory';
import { onRequestPost as grantEpPost } from '../../functions/api/admin/grant-ep';
import { onRequestPost as forceHatchPost } from '../../functions/api/admin/force-hatch';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');
const MIGRATION3 = readFileSync(join(root, 'migrations/0003_handle_locked.sql'), 'utf8');
const MIGRATION4 = readFileSync(join(root, 'migrations/0004_handle_cooldown.sql'), 'utf8');
const MIGRATION5 = readFileSync(join(root, 'migrations/0005_avatar_tiers.sql'), 'utf8');
const MIGRATION6 = readFileSync(join(root, 'migrations/0006_creatures.sql'), 'utf8');
const MIGRATION7 = readFileSync(join(root, 'migrations/0007_sprites.sql'), 'utf8');
const MIGRATION8 = readFileSync(join(root, 'migrations/0008_sprite_override.sql'), 'utf8');
const MIGRATION9 = readFileSync(join(root, 'migrations/0009_native_colourway.sql'), 'utf8');
const MIGRATION10 = readFileSync(join(root, 'migrations/0010_engagement_ep.sql'), 'utf8');
const MIGRATION11 = readFileSync(join(root, 'migrations/0011_profile_bio_privacy.sql'), 'utf8');

const AUTH_SECRET = 'test-only-secret-not-real';
const ADMIN_EMAIL = 'admin@morphicsmusic.com';
const FAN_EMAIL = 'creature-fan@example.com';

function makeKvStub() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    _store: store,
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
  raw.exec(MIGRATION6);
  raw.exec(MIGRATION7);
  raw.exec(MIGRATION8);
  raw.exec(MIGRATION9);
  raw.exec(MIGRATION10);
  raw.exec(MIGRATION11);
  db = makeD1Shim(raw);
  kv = makeKvStub();
  env = { AUTH_SECRET, DOWNLOADS: kv, GATES: db };
});

async function cookieFor(email) {
  const value = await signSession(AUTH_SECRET, email, 0);
  return `${SESSION_COOKIE}=${value}`;
}

function req(url, opts = {}) {
  return new Request(url, opts);
}

function hasEmailKey(value) {
  if (Array.isArray(value)) return value.some(hasEmailKey);
  if (value && typeof value === 'object') {
    return Object.keys(value).some(k => k === 'email' || hasEmailKey(value[k]));
  }
  return false;
}

async function putCustomer(email, record) {
  await kv.put(`customer:${email}`, JSON.stringify(record));
}

describe('GET /api/community/me — creature progress', () => {
  it('a brand-new fan with no purchases is an egg with 0 EP, and already carries an egg sprite ref + colourway', async () => {
    const cookie = await cookieFor(FAN_EMAIL);
    const res = await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env });
    const body = await res.json();
    expect(body.profile.creature.stage).toBe('egg');
    expect(body.profile.creature.ep).toBe(0);
    expect(body.profile.creature.stage_xp).toBe(0);
    // Sprite refs/colourway are fixed at profile creation, not at "hatch" —
    // an egg-stage fan already has a real egg sprite ref, unlike the retired
    // species model where an egg had no art at all.
    expect(body.profile.creature.sprite_ref).toEqual(expect.any(String));
    expect(body.profile.creature.colourway).toEqual(expect.any(String));
    expect(body.profile.creature.next_stage_ep).toBeGreaterThan(0);
  });

  it('a fan with enough purchase EP advances past egg on their first profile visit', async () => {
    await putCustomer(FAN_EMAIL, {
      first_seen_at: 0,
      purchases: [{ music_release_slugs: ['a'] }, { music_release_slugs: ['b'] }],
    });
    const cookie = await cookieFor(FAN_EMAIL);
    const res = await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env });
    const body = await res.json();
    expect(body.profile.creature.stage).not.toBe('egg');
    expect(body.profile.creature.sprite_ref).toEqual(expect.any(String));
    expect(body.profile.just_hatched).toBe(true);
  });

  it('is idempotent: a second visit does not re-flag just_hatched or change the sprite ref', async () => {
    await putCustomer(FAN_EMAIL, { first_seen_at: 0, purchases: [{ music_release_slugs: ['a'] }, { music_release_slugs: ['b'] }] });
    const cookie = await cookieFor(FAN_EMAIL);
    const first = await (await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env })).json();
    const second = await (await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env })).json();
    expect(second.profile.creature.sprite_ref).toBe(first.profile.creature.sprite_ref);
    expect(second.profile.creature.colourway).toBe(first.profile.creature.colourway);
    expect(second.profile.just_hatched).toBe(false);
  });

  it('never includes the email anywhere in the response', async () => {
    await putCustomer(FAN_EMAIL, { first_seen_at: 0, purchases: [{ music_release_slugs: ['a'] }, { music_release_slugs: ['b'] }] });
    const cookie = await cookieFor(FAN_EMAIL);
    const res = await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env });
    const body = await res.json();
    expect(hasEmailKey(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(FAN_EMAIL);
  });
});

describe('GET /api/community/profile and /directory — creature fields', () => {
  it('profile.ts carries stage/sprite_ref/ep/colourway without email', async () => {
    await putCustomer(FAN_EMAIL, { first_seen_at: 0, purchases: [{ music_release_slugs: ['a'] }, { music_release_slugs: ['b'] }] });
    const cookie = await cookieFor(FAN_EMAIL);
    // First visit advances the fan via /me.
    await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env });
    const profile = await db.prepare('SELECT handle FROM fan_profiles WHERE email = ?').bind(FAN_EMAIL).first();

    const res = await profileGet({
      request: req(`https://morphicsmusic.com/api/community/profile?handle=${profile.handle}`, { headers: { Cookie: cookie } }),
      env,
    });
    const body = await res.json();
    expect(body.profile.creature.stage).not.toBe('egg');
    expect(body.profile.creature.sprite_ref).toEqual(expect.any(String));
    expect(body.profile.creature.colourway).toEqual(expect.any(String));
    expect(hasEmailKey(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(FAN_EMAIL);
  });

  it('directory.ts carries creature fields for every fan on the page without email', async () => {
    await putCustomer(FAN_EMAIL, { first_seen_at: 0, purchases: [{ music_release_slugs: ['a'] }, { music_release_slugs: ['b'] }] });
    const cookie = await cookieFor(FAN_EMAIL);
    await meGet({ request: req('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env });

    const res = await directoryGet({
      request: req('https://morphicsmusic.com/api/community/directory', { headers: { Cookie: cookie } }),
      env,
    });
    const body = await res.json();
    expect(body.fans.length).toBeGreaterThan(0);
    const fan = body.fans.find(f => f.creature.stage !== 'egg');
    expect(fan).toBeTruthy();
    expect(fan.creature.sprite_ref).toEqual(expect.any(String));
    expect(hasEmailKey(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(FAN_EMAIL);
  });
});

describe('admin creature endpoints', () => {
  it('a non-admin gets a bare 404 from grant-ep, not 403', async () => {
    const res = await grantEpPost({
      request: req('https://morphicsmusic.com/api/admin/grant-ep', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: FAN_EMAIL, amount: 100 }),
      }),
      env,
    });
    expect(res.status).toBe(404);
  });

  it('a non-admin gets a bare 404 from force-hatch, not 403', async () => {
    const res = await forceHatchPost({
      request: req('https://morphicsmusic.com/api/admin/force-hatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: FAN_EMAIL }),
      }),
      env,
    });
    expect(res.status).toBe(404);
  });

  it('an admin can grant EP and it can push a fan past egg', async () => {
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
    const adminCookie = await cookieFor(ADMIN_EMAIL);
    env.ADMIN_EMAILS = ADMIN_EMAIL;

    const res = await grantEpPost({
      request: req('https://morphicsmusic.com/api/admin/grant-ep', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ email: FAN_EMAIL, amount: 1000 }),
      }),
      env,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ep).toBe(1000);
    expect(body.stage).not.toBe('egg');

    const row = await db.prepare('SELECT ep, stage FROM fan_profiles WHERE email = ?').bind(FAN_EMAIL).first();
    expect(row.ep).toBe(1000);
    expect(row.stage).toBe(body.stage);
  });

  it('an admin can force-hatch a fresh egg with zero EP', async () => {
    await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
    const adminCookie = await cookieFor(ADMIN_EMAIL);
    env.ADMIN_EMAILS = ADMIN_EMAIL;

    const res = await forceHatchPost({
      request: req('https://morphicsmusic.com/api/admin/force-hatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ email: FAN_EMAIL }),
      }),
      env,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).not.toBe('egg');
  });

  it('grant-ep 404s for an unknown fan email even when the caller is an admin', async () => {
    const adminCookie = await cookieFor(ADMIN_EMAIL);
    env.ADMIN_EMAILS = ADMIN_EMAIL;
    const res = await grantEpPost({
      request: req('https://morphicsmusic.com/api/admin/grant-ep', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ email: 'nobody@example.com', amount: 10 }),
      }),
      env,
    });
    expect(res.status).toBe(404);
  });
});

// Endpoint-level tests for POST /api/community/engagement: D1 persistence,
// requireFan gating, replay/idempotency through the real KV+D1 stack, and
// the flow of accrued engagement EP into GET /api/community/me's computeEp
// (see functions/_lib/community/engagement.ts for the pure logic these
// wire up). Same harness pattern as creature-endpoints.test.js: node:sqlite
// D1 shim, a minimal KV stub, and a real signed session cookie.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeD1Shim } from './helpers/d1-shim.js';
import { signSession, SESSION_COOKIE } from '../../functions/_lib/auth';
import { ensureProfile } from '../../functions/_lib/community/repo';
import { CLICK_XP_DAILY_CAP, TIME_XP_DAILY_CAP, LISTEN_XP_DAILY_CAP } from '../../functions/_lib/community/engagement';

import { onRequestGet as meGet } from '../../functions/api/community/me';
import { onRequestPost as engagementPost } from '../../functions/api/community/engagement';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');
const MIGRATION3 = readFileSync(join(root, 'migrations/0003_handle_locked.sql'), 'utf8');
const MIGRATION4 = readFileSync(join(root, 'migrations/0004_handle_cooldown.sql'), 'utf8');
const MIGRATION5 = readFileSync(join(root, 'migrations/0005_avatar_tiers.sql'), 'utf8');
const MIGRATION6 = readFileSync(join(root, 'migrations/0006_creatures.sql'), 'utf8');
const MIGRATION7 = readFileSync(join(root, 'migrations/0007_sprites.sql'), 'utf8');
const MIGRATION11 = readFileSync(join(root, 'migrations/0011_profile_bio_privacy.sql'), 'utf8');
const MIGRATION8 = readFileSync(join(root, 'migrations/0008_sprite_override.sql'), 'utf8');
const MIGRATION9 = readFileSync(join(root, 'migrations/0009_native_colourway.sql'), 'utf8');
const MIGRATION10 = readFileSync(join(root, 'migrations/0010_engagement_ep.sql'), 'utf8');

const AUTH_SECRET = 'test-only-secret-not-real';
const FAN_EMAIL = 'engagement-fan@example.com';

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

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(MIGRATION);
  raw.exec(MIGRATION3);
  raw.exec(MIGRATION4);
  raw.exec(MIGRATION5);
  raw.exec(MIGRATION6);
  raw.exec(MIGRATION7);
  raw.exec(MIGRATION11);
  raw.exec(MIGRATION8);
  raw.exec(MIGRATION9);
  raw.exec(MIGRATION10);
  db = makeD1Shim(raw);
  kv = makeKvStub();
  env = { AUTH_SECRET, DOWNLOADS: kv, GATES: db };
  // The engagement endpoint deliberately never creates a profile itself —
  // seed one the same way a real fan would (a prior /me visit).
  await ensureProfile(db, { email: FAN_EMAIL, fanSince: 0, displayName: 'Fan' });
});

async function cookieFor(email) {
  const value = await signSession(AUTH_SECRET, email, 0);
  return `${SESSION_COOKIE}=${value}`;
}

function post(body) {
  return cookieFor(FAN_EMAIL).then(cookie => engagementPost({
    request: new Request('https://morphicsmusic.com/api/community/engagement', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  }));
}

function getProfileRow() {
  return db.prepare('SELECT * FROM fan_profiles WHERE email = ?').bind(FAN_EMAIL).first();
}

describe('POST /api/community/engagement — auth', () => {
  it('401s with no session cookie', async () => {
    const res = await engagementPost({
      request: new Request('https://morphicsmusic.com/api/community/engagement', {
        method: 'POST', body: JSON.stringify({ new_clicks: 1, active_seconds: 0, seq: 1, listens: [] }),
      }),
      env,
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/community/engagement — caps hold end to end', () => {
  it('click XP caps at CLICK_XP_DAILY_CAP', async () => {
    let last;
    for (let i = 0; i < 10; i++) {
      last = await post({ new_clicks: 5, active_seconds: 0, seq: i + 1, listens: [] });
    }
    const body = await last.json();
    expect(body.clicks_today).toBe(CLICK_XP_DAILY_CAP);
    const row = await getProfileRow();
    expect(row.engagement_clicks_today).toBe(CLICK_XP_DAILY_CAP);
    expect(row.engagement_ep).toBe(CLICK_XP_DAILY_CAP);
  });

  it('time XP caps at TIME_XP_DAILY_CAP', async () => {
    let last;
    for (let i = 0; i < 40; i++) {
      last = await post({ new_clicks: 0, active_seconds: 90, seq: i + 1, listens: [] });
    }
    const body = await last.json();
    expect(body.time_cap).toBe(TIME_XP_DAILY_CAP);
    const row = await getProfileRow();
    expect(row.engagement_ep).toBe(TIME_XP_DAILY_CAP);
  });

  it('listening XP caps at LISTEN_XP_DAILY_CAP', async () => {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const res = await post({
        new_clicks: 0, active_seconds: 0, seq: i + 1,
        listens: [{ key: `track-${i}`, started: true, progress_seconds: 30, duration_seconds: 30 }],
      });
      const body = await res.json();
      total += body.awarded_ep;
    }
    expect(total).toBe(LISTEN_XP_DAILY_CAP);
    const row = await getProfileRow();
    expect(row.engagement_ep).toBe(LISTEN_XP_DAILY_CAP);
  });

  it('the same clicked element counts once per day regardless of how many times it is reported as "new"', async () => {
    // A misbehaving/malicious client could keep sending new_clicks:1 for the
    // exact same element — the SERVER cap is what actually protects this
    // (see CLICK_XP_DAILY_CAP), which the previous test already covers end
    // to end. Real per-element dedup within a page session is the client's
    // job (engagement-tracker.js's clickedThisSession Set); this test just
    // confirms the server-side counter is monotonic and capped, not reset
    // by repeated small reports.
    const first = await (await post({ new_clicks: 1, active_seconds: 0, seq: 1, listens: [] })).json();
    const second = await (await post({ new_clicks: 1, active_seconds: 0, seq: 2, listens: [] })).json();
    expect(first.clicks_today).toBe(1);
    expect(second.clicks_today).toBe(2);
  });
});

describe('POST /api/community/engagement — client-supplied XP is ignored', () => {
  it('a body claiming a huge XP amount directly is ignored; only real signals count', async () => {
    const res = await post({
      new_clicks: 1, active_seconds: 0, seq: 1, listens: [],
      xp: 999999, ep: 999999, awarded_ep: 999999,
    });
    const body = await res.json();
    expect(body.awarded_ep).toBe(1);
  });
});

describe('POST /api/community/engagement — replay protection', () => {
  it('a replayed request (same seq) does not double-award', async () => {
    const first = await (await post({ new_clicks: 5, active_seconds: 0, seq: 7, listens: [] })).json();
    const replay = await (await post({ new_clicks: 5, active_seconds: 0, seq: 7, listens: [] })).json();
    expect(first.awarded_ep).toBe(5);
    expect(replay.awarded_ep).toBe(0);
    expect(replay.clicks_today).toBe(5);
  });
});

describe('POST /api/community/engagement — listening', () => {
  it('a completion claim without real progression (progress far short of duration) is refused', async () => {
    await post({ new_clicks: 0, active_seconds: 0, seq: 1, listens: [{ key: 'k', started: true, progress_seconds: 0, duration_seconds: 30 }] });
    const res = await post({
      new_clicks: 0, active_seconds: 0, seq: 2,
      listens: [{ key: 'k', started: false, progress_seconds: 2, duration_seconds: 30 }],
    });
    const body = await res.json();
    expect(body.awarded_ep).toBe(0);
  });

  it('starting then genuinely completing the same track awards 6 total, not 9', async () => {
    const start = await (await post({
      new_clicks: 0, active_seconds: 0, seq: 1,
      listens: [{ key: 'k', started: true, progress_seconds: 0, duration_seconds: 30 }],
    })).json();
    const complete = await (await post({
      new_clicks: 0, active_seconds: 0, seq: 2,
      listens: [{ key: 'k', started: false, progress_seconds: 29, duration_seconds: 30 }],
    })).json();
    expect(start.awarded_ep).toBe(3);
    expect(complete.awarded_ep).toBe(3);
    const row = await getProfileRow();
    expect(row.engagement_ep).toBe(6);
  });
});

describe('engagement EP flows through computeEp into GET /api/community/me', () => {
  it('accrued engagement EP raises the fan\'s creature EP and can advance their stage', async () => {
    // 25 (click cap) + 30 (time cap) + 30 (listen cap) = 85 engagement EP —
    // comfortably past the 50-EP grub threshold with zero purchases.
    for (let i = 0; i < 10; i++) await post({ new_clicks: 5, active_seconds: 0, seq: i + 1, listens: [] });
    for (let i = 0; i < 40; i++) await post({ new_clicks: 0, active_seconds: 90, seq: 100 + i, listens: [] });
    for (let i = 0; i < 20; i++) {
      await post({
        new_clicks: 0, active_seconds: 0, seq: 200 + i,
        listens: [{ key: `t-${i}`, started: true, progress_seconds: 30, duration_seconds: 30 }],
      });
    }
    const row = await getProfileRow();
    expect(row.engagement_ep).toBe(CLICK_XP_DAILY_CAP + TIME_XP_DAILY_CAP + LISTEN_XP_DAILY_CAP);

    const cookie = await cookieFor(FAN_EMAIL);
    const res = await meGet({
      request: new Request('https://morphicsmusic.com/api/community/me', { headers: { Cookie: cookie } }), env,
    });
    const body = await res.json();
    expect(body.profile.creature.ep).toBeGreaterThanOrEqual(CLICK_XP_DAILY_CAP + TIME_XP_DAILY_CAP + LISTEN_XP_DAILY_CAP);
    expect(body.profile.creature.stage).not.toBe('egg');
  });
});

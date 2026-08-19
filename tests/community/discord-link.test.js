// End-to-end tests for the Discord<->website ladder merge: the link
// handshake (POST /api/discord/link-code -> POST /api/community/link-discord)
// and the award path (POST /api/discord/award), including the invariant the
// merge exists for — that Discord EP and site EP produce ONE rank.
//
// Same harness as engagement-endpoint.test.js: node:sqlite D1 shim, a
// minimal KV stub, and a real signed session cookie for the fan half.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeD1Shim } from './helpers/d1-shim.js';
import { signSession, SESSION_COOKIE } from '../../functions/_lib/auth';
import { ensureProfile } from '../../functions/_lib/community/repo';
import { BOT_TOKEN_HEADER } from '../../functions/_lib/community/discord';

import { onRequestPost as linkCodePost } from '../../functions/api/discord/link-code';
import { onRequestPost as awardPost } from '../../functions/api/discord/award';
import {
  onRequestPost as linkPost, onRequestDelete as unlinkDelete,
} from '../../functions/api/community/link-discord';
import { onRequestGet as meGet } from '../../functions/api/community/me';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = [
  // Numeric order, matching how wrangler actually applies them. This is not
  // cosmetic: 0010 REBUILDS fan_profiles with an explicit column list, so
  // applying 0011 before it silently drops `bio` and `hidden_from_wall`.
  '0002_fan_profiles', '0003_handle_locked', '0004_handle_cooldown',
  '0005_avatar_tiers', '0006_creatures', '0007_sprites', '0008_sprite_override',
  '0009_native_colourway', '0010_engagement_ep', '0011_profile_bio_privacy',
  '0012_profile_soft_delete', '0013_discord_links', '0014_xp_events',
  '0015_discord_award_events',
].map(n => readFileSync(join(root, `migrations/${n}.sql`), 'utf8'));

const AUTH_SECRET = 'test-only-secret-not-real';
const BOT_SECRET = 'test-only-bot-secret';
const FAN_EMAIL = 'discord-fan@example.com';
const DISCORD_ID = '1234567890';

function makeKvStub() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

// A fan_since of 0 is 1970, which computeEp scores as ~4000 EP of tenure
// (PER_TENURE_DAY 0.2) and lands every fixture at 'adult' before any Discord
// activity at all. Seed "signed up today" so the tests measure the thing
// they claim to measure.
const NOW = Math.floor(Date.now() / 1000);

let raw, db, kv, env, fanId;

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS) raw.exec(m);
  db = makeD1Shim(raw);
  kv = makeKvStub();
  env = { AUTH_SECRET, DOWNLOADS: kv, GATES: db, DISCORD_BOT_SECRET: BOT_SECRET };
  const profile = await ensureProfile(db, { email: FAN_EMAIL, fanSince: NOW, displayName: 'Fan' });
  fanId = profile.id;
});

function botReq(path, body, token = BOT_SECRET) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers[BOT_TOKEN_HEADER] = token;
  return new Request(`https://morphicsmusic.com${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

async function cookieFor(email = FAN_EMAIL) {
  return `${SESSION_COOKIE}=${await signSession(AUTH_SECRET, email, 0)}`;
}

async function issueCode(discordId = DISCORD_ID) {
  const res = await linkCodePost({ request: botReq('/api/discord/link-code', { discord_user_id: discordId }), env });
  return { res, body: await res.json() };
}

async function redeem(code, email = FAN_EMAIL) {
  return linkPost({
    request: new Request('https://morphicsmusic.com/api/community/link-discord', {
      method: 'POST',
      headers: { Cookie: await cookieFor(email), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
    env,
  });
}

async function link(discordId = DISCORD_ID, email = FAN_EMAIL) {
  const { body } = await issueCode(discordId);
  return redeem(body.code, email);
}

async function award(amount, discordId = DISCORD_ID, eventKey = undefined) {
  const payload = { discord_user_id: discordId, amount };
  if (eventKey) payload.event_key = eventKey;
  const res = await awardPost({ request: botReq('/api/discord/award', payload), env });
  return { res, body: await res.json() };
}


// --- bot authentication ------------------------------------------------

describe('bot auth', () => {
  it('404s — not 403 — without the shared secret, on both bot endpoints', async () => {
    // 403 would confirm the endpoint exists; 404 is what an unknown route gives.
    for (const path of ['/api/discord/link-code', '/api/discord/award']) {
      const handler = path.endsWith('link-code') ? linkCodePost : awardPost;
      const res = await handler({ request: botReq(path, { discord_user_id: DISCORD_ID, amount: 5 }, null), env });
      expect(res.status).toBe(404);
    }
  });

  it('404s with a wrong secret', async () => {
    const res = await linkCodePost({
      request: botReq('/api/discord/link-code', { discord_user_id: DISCORD_ID }, 'wrong-secret'),
      env,
    });
    expect(res.status).toBe(404);
  });

  it('fails CLOSED when DISCORD_BOT_SECRET is unset', async () => {
    // An env-var typo must not silently leave an EP-granting endpoint open.
    const res = await linkCodePost({
      request: botReq('/api/discord/link-code', { discord_user_id: DISCORD_ID }),
      env: { ...env, DISCORD_BOT_SECRET: undefined },
    });
    expect(res.status).toBe(404);
  });
});


// --- the link handshake -------------------------------------------------

describe('link handshake', () => {
  it('issues a code the fan can redeem', async () => {
    const { res, body } = await issueCode();
    expect(res.status).toBe(200);
    expect(body.code).toMatch(/^[A-Z2-9]{8}$/);

    const redeemed = await redeem(body.code);
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json()).discord_user_id).toBe(DISCORD_ID);
  });

  it('accepts a code the fan retyped with spaces and lowercase', async () => {
    const { body } = await issueCode();
    const messy = ` ${body.code.slice(0, 4).toLowerCase()}-${body.code.slice(4).toLowerCase()} `;
    expect((await redeem(messy)).status).toBe(200);
  });

  it('rejects a code that was already used — single use', async () => {
    const { body } = await issueCode();
    expect((await redeem(body.code)).status).toBe(200);

    // Second fan, same code.
    await ensureProfile(db, { email: 'other@example.com', fanSince: NOW, displayName: 'Other' });
    const again = await redeem(body.code, 'other@example.com');
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('invalid_code');
  });

  it('gives the same answer for an unknown code as for an expired one', async () => {
    // Distinguishing them would tell someone guessing whether a code existed.
    const { body } = await issueCode();
    raw.exec(`UPDATE discord_link_codes SET expires_at = 1 WHERE code = '${body.code}'`);
    const expired = await redeem(body.code);
    const unknown = await redeem('ABCDEFGH');
    expect(expired.status).toBe(unknown.status);
    expect(await expired.json()).toEqual(await unknown.json());
  });

  it('re-running /link invalidates the previous code', async () => {
    const first = (await issueCode()).body;
    await issueCode();
    expect((await redeem(first.code)).status).toBe(400);
  });

  it('refuses to issue a code for an already-linked Discord account', async () => {
    await link();
    const { res, body } = await issueCode();
    expect(res.status).toBe(409);
    expect(body.error).toBe('already_linked');
  });

  it('refuses a second link for a fan who already has one', async () => {
    await link();
    // A different Discord account, same fan.
    const { body } = await issueCode('9999');
    const res = await redeem(body.code);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_linked');
  });

  it('refuses when the Discord account got linked to someone else mid-handshake', async () => {
    // Both codes issued before either is redeemed — the window link-code.ts's
    // own check cannot see, since they are separate requests.
    const { body } = await issueCode();
    await ensureProfile(db, { email: 'other@example.com', fanSince: NOW, displayName: 'Other' });
    raw.exec(`INSERT INTO discord_links (fan_id, discord_user_id, linked_at, discord_ep)
              SELECT id, '${DISCORD_ID}', 0, 0 FROM fan_profiles WHERE email = 'other@example.com'`);

    const res = await redeem(body.code);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('discord_account_already_linked');
  });

  it('401s when a signed-out caller tries to redeem', async () => {
    const { body } = await issueCode();
    const res = await linkPost({
      request: new Request('https://morphicsmusic.com/api/community/link-discord', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: body.code }),
      }),
      env,
    });
    expect(res.status).toBe(401);
  });
});


// --- awarding ------------------------------------------------------------

describe('POST /api/discord/award', () => {
  it('404s for an unlinked Discord account without erroring', async () => {
    // Most of the server is unlinked; this is a normal state, not a failure.
    const { res, body } = await award(10, '404040');
    expect(res.status).toBe(404);
    expect(body.error).toBe('not_linked');
  });

  it('accumulates EP and returns the stage the bot should paint', async () => {
    await link();
    const first = await award(30);
    expect(first.res.status).toBe(200);
    expect(first.body.discord_ep).toBe(30);
    expect(first.body.stage).toBe('egg');

    const second = await award(30);
    expect(second.body.discord_ep).toBe(60);
    // 60 EP crosses ep.ts's grub threshold of 50.
    expect(second.body.stage).toBe('grub');
    expect(second.body.label).toBe('Larva');
    expect(second.body.just_hatched).toBe(true);
  });

  it('clamps an absurd award instead of trusting the caller', async () => {
    await link();
    const { body } = await award(999999);
    expect(body.discord_ep).toBe(100);
  });

  it('rejects a zero or non-numeric amount', async () => {
    await link();
    for (const amount of [0, 'lots', null]) {
      const { res } = await award(amount);
      expect(res.status).toBe(400);
    }
  });

  it('never lets Discord EP go negative', async () => {
    await link();
    await award(10);
    const { body } = await award(-50);
    expect(body.discord_ep).toBe(0);
  });

  it('never demotes a stage the fan already reached', async () => {
    // resolveStage is one-way on purpose — see ep.ts. Losing EP must not
    // take a creature backwards.
    await link();
    await award(100);
    await award(100);
    const grown = await award(50);   // 250 EP — past pupa's threshold of 200
    expect(grown.body.stage).toBe('pupa');

    // 150 EP scores as grub in isolation, but the fan was already a pupa.
    const stripped = await award(-100);
    expect(stripped.body.stage).toBe('pupa');
  });
});


// --- the merge invariant ------------------------------------------------

describe('one ladder, two surfaces', () => {
  async function me(email = FAN_EMAIL) {
    const res = await meGet({
      request: new Request('https://morphicsmusic.com/api/community/me', {
        headers: { Cookie: await cookieFor(email) },
      }),
      env,
    });
    return res.json();
  }

  it('Discord EP moves the creature the website shows', async () => {
    await link();
    expect((await me()).profile.creature.stage).toBe('egg');

    await award(60);

    // Same fan, same number, read through the site's own endpoint.
    expect((await me()).profile.creature.stage).toBe('grub');
  });

  it('site EP and Discord EP add up rather than competing', async () => {
    await link();
    // 30 EP of site engagement, 30 of Discord: neither alone reaches the
    // grub threshold of 50, but together they do. If the two were separate
    // ladders this fan would still be an egg.
    raw.exec(`UPDATE fan_profiles SET engagement_ep = 30 WHERE id = ${fanId}`);
    await award(30);
    expect((await me()).profile.creature.stage).toBe('grub');
  });

  it('the award endpoint and /me agree on the resulting EP', async () => {
    await link();
    raw.exec(`UPDATE fan_profiles SET engagement_ep = 17 WHERE id = ${fanId}`);
    const { body } = await award(23);
    expect((await me()).profile.creature.ep).toBe(body.ep);
  });

  it('unlinking stops Discord EP counting but never demotes', async () => {
    await link();
    await award(60);
    expect((await me()).profile.creature.stage).toBe('grub');

    const res = await unlinkDelete({
      request: new Request('https://morphicsmusic.com/api/community/link-discord', {
        method: 'DELETE', headers: { Cookie: await cookieFor() },
      }),
      env,
    });
    expect(res.status).toBe(200);

    const after = await me();
    expect(after.profile.creature.ep).toBe(0);
    expect(after.profile.creature.stage).toBe('grub');
  });
});


describe('GET /api/community/me — discord_linked flag', () => {
  async function me() {
    const res = await meGet({
      request: new Request('https://morphicsmusic.com/api/community/me', {
        headers: { Cookie: await cookieFor() },
      }),
      env,
    });
    return res.json();
  }

  it('is false before linking and true after', async () => {
    expect((await me()).profile.discord_linked).toBe(false);
    await link();
    expect((await me()).profile.discord_linked).toBe(true);
  });

  it('never exposes the Discord user id to the browser', async () => {
    // The account page only needs to know WHETHER a link exists; the id is
    // an identifier for another platform and has no business in this payload.
    await link();
    expect(JSON.stringify(await me())).not.toContain(DISCORD_ID);
  });
});


describe('a fan inside the delete grace window', () => {
  // Migration 0012 (soft delete) landed in parallel with this feature, which
  // turned "a link pointing at a profile getProfileById won't return" from an
  // impossible state into a routine one lasting up to 30 days. award.ts wrote
  // the EP before it checked the profile, so every award in that window was
  // charged and then 404'd — and with no outbox on the bot side, the local
  // ledger marks it paid with a permanent dedup key and can never retry.
  async function softDelete() {
    raw.exec(`UPDATE fan_profiles SET deleted_at = ${Math.floor(Date.now() / 1000)}
                WHERE email = '${FAN_EMAIL}'`);
  }

  function discordEpNow() {
    return raw.prepare(
      `SELECT discord_ep FROM discord_links WHERE discord_user_id = ?`
    ).get(DISCORD_ID)?.discord_ep;
  }

  it('is treated as unlinked, and is never charged EP it cannot be credited', async () => {
    await link();
    await award(30);
    expect(discordEpNow()).toBe(30);

    await softDelete();

    const { res, body } = await award(30);
    expect(res.status).toBe(404);
    expect(body.error).toBe('not_linked');
    expect(discordEpNow(), 'EP must not be written for a fan who cannot be credited').toBe(30);
  });

  it('resumes earning cleanly once restored', async () => {
    await link();
    await softDelete();
    await award(30);

    raw.exec(`UPDATE fan_profiles SET deleted_at = NULL WHERE email = '${FAN_EMAIL}'`);

    const { res, body } = await award(30);
    expect(res.status).toBe(200);
    expect(body.discord_ep).toBe(30);
  });
});


describe('POST /api/discord/status — delete grace window', () => {
  it('agrees with award.ts that a soft-deleted fan is not_linked', async () => {
    const { onRequestPost: statusPost } = await import('../../functions/api/discord/status');
    await link();
    raw.exec(`UPDATE fan_profiles SET deleted_at = ${Math.floor(Date.now() / 1000)}
                WHERE email = '${FAN_EMAIL}'`);

    const res = await statusPost({
      request: botReq('/api/discord/status', { discord_user_id: DISCORD_ID }),
      env,
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_linked');
  });
});


describe('award idempotency (migration 0015)', () => {
  // addDiscordEp is a RELATIVE increment, so a replayed award adds again —
  // and since resolveStage never demotes, the resulting rank is permanent.
  // This is what lets the bot retry an award it could not deliver.
  it('applies an award once no matter how many times it is replayed', async () => {
    await link();
    const first = await award(30, DISCORD_ID, 'msg:111:abc');
    expect(first.body.discord_ep).toBe(30);
    expect(first.body.duplicate).toBe(false);

    for (let i = 0; i < 4; i++) {
      const replay = await award(30, DISCORD_ID, 'msg:111:abc');
      expect(replay.res.status).toBe(200);
      expect(replay.body.discord_ep).toBe(30);
      expect(replay.body.duplicate).toBe(true);
    }
  });

  it('reports 200 on a duplicate, not an error', async () => {
    // The bot treats non-2xx as "still undelivered" and would keep the award
    // queued forever — a retry storm becoming a failure storm.
    await link();
    await award(30, DISCORD_ID, 'msg:222:abc');
    const replay = await award(30, DISCORD_ID, 'msg:222:abc');
    expect(replay.res.status).toBe(200);
    expect(replay.body.ok).toBe(true);
    expect(replay.body.stage).toBeTruthy();
  });

  it('treats different keys as different awards', async () => {
    await link();
    await award(30, DISCORD_ID, 'msg:333:abc');
    const second = await award(30, DISCORD_ID, 'rx:333:abc');
    expect(second.body.discord_ep).toBe(60);
    expect(second.body.duplicate).toBe(false);
  });

  it('still works with no event_key, for an older bot build', async () => {
    await link();
    await award(30);
    const again = await award(30);
    // No key means no dedup — which is exactly why the bot refuses to queue
    // an award it has no key for.
    expect(again.body.discord_ep).toBe(60);
  });

  it('a replay returns the stage the fan is actually at', async () => {
    await link();
    await award(60, DISCORD_ID, 'msg:444:abc');
    const replay = await award(60, DISCORD_ID, 'msg:444:abc');
    expect(replay.body.stage).toBe('grub');
    expect(replay.body.discord_ep).toBe(60);
  });
});


describe('event_key bounds', () => {
  it('rejects an over-long key instead of truncating it', async () => {
    // Truncating would let two keys sharing a prefix collide, and a collision
    // reads as "already applied" — silently dropping the second award.
    await link();
    const res = await award(30, DISCORD_ID, 'k'.repeat(500));
    expect(res.res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/);
  });

  it('does not apply EP for a rejected key', async () => {
    await link();
    await award(30, DISCORD_ID, 'k'.repeat(500));
    const good = await award(30, DISCORD_ID, 'msg:999:abc');
    expect(good.body.discord_ep).toBe(30);
  });
});

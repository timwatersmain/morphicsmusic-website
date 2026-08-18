// Free-song token: granted once on email verification, spendable once on
// any single track, and additive to (never a replacement for) the existing
// paying-customer download path. Same KV-stub pattern as
// tests/auth/verify-email.test.ts and tests/auth/endpoints.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { onRequestGet as verifyEmailGet } from '../../functions/api/auth/verify-email';
import { onRequestPost as freeTokenPost } from '../../functions/api/free-token';
import { onRequestGet as downloadGet } from '../../functions/api/download';
import {
  issueVerifyEmailToken,
  signSession,
  getSessionVer,
  SESSION_COOKIE,
} from '../../functions/_lib/auth';
import { getCustomerRecord, saveCustomerRecord } from '../../functions/_lib/customer';

// Two real, released tracks from two different releases in the actual
// catalogue/manifest data — free-token entitlement logic reads those files
// directly, so the test data has to be real entries, not fixtures.
const TRACK_A = 'masters/befuddled/Morphics_-_Befuddled.wav'; // release: befuddled
const TRACK_B = 'masters/crave/Morphics_-_Crave.wav'; // release: crave (different release, also released)

function makeKvStub() {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.has(key) ? store.get(key)! : null; },
    async put(key: string, value: string) { store.set(key, String(value)); },
    async delete(key: string) { store.delete(key); },
    _store: store,
  };
}

function makeMastersStub() {
  // Any key resolves to a tiny fake object — we're asserting entitlement
  // decisions (which status code, which headers), not exercising a real R2
  // bucket's byte-streaming.
  return { async get(_key: string) { return { body: new Response('fake-audio-bytes').body, size: 17 }; } };
}

const AUTH_SECRET = 'test-only-auth-secret-not-real';

let kv: ReturnType<typeof makeKvStub>;
let env: any;
let waited: Promise<any>[];

beforeEach(() => {
  kv = makeKvStub();
  waited = [];
  env = {
    DOWNLOADS: kv,
    MASTERS: makeMastersStub(),
    AUTH_SECRET,
    PASSWORD_PEPPER: 'test-only-pepper-not-real-do-not-use',
  };
});

function waitUntil(p: Promise<any>) { waited.push(p); }

async function seedCustomer(email: string, extra: Record<string, any> = {}) {
  await saveCustomerRecord(env, {
    email,
    name: null,
    first_seen_at: 1,
    last_seen_at: 1,
    purchases: [{
      purchased_at: 1,
      stripe_session_id: 'sess_existing',
      music_release_slugs: ['dark-side-of-the-mind'],
      merch_items: [],
      amount_total: 500,
      currency: 'usd',
    }],
    ...extra,
  });
}

function verifyEmailReq(token: string | null) {
  const url = new URL('https://morphicsmusic.com/api/auth/verify-email');
  if (token) url.searchParams.set('token', token);
  return verifyEmailGet({ request: new Request(url.toString()), env } as any);
}

async function sessionCookieFor(email: string) {
  const ver = await getSessionVer(env, email);
  return signSession(AUTH_SECRET, email, ver);
}

async function spendReq(email: string, key: string) {
  const cookie = await sessionCookieFor(email);
  return freeTokenPost({
    request: new Request('https://morphicsmusic.com/api/free-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://morphicsmusic.com', Cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` },
      body: JSON.stringify({ key }),
    }),
    env,
    waitUntil,
  } as any);
}

async function downloadByCookie(email: string, key: string) {
  const cookie = await sessionCookieFor(email);
  const url = new URL('https://morphicsmusic.com/api/download');
  url.searchParams.set('key', key);
  return downloadGet({
    request: new Request(url.toString(), { headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } }),
    env,
    waitUntil,
  } as any);
}

describe('email verification grants exactly one free-song token', () => {
  it('grants a token on first verification', async () => {
    const email = 'fresh@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token);

    const record = await getCustomerRecord(env, email);
    expect(record?.free_token_granted_at).toEqual(expect.any(Number));
    expect(record?.free_token_spent_key).toBeUndefined();
  });

  it('verifying again (fresh link, same account) does not grant a second token', async () => {
    const email = 'reverify@example.com';
    await seedCustomer(email);

    const token1 = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token1);
    const first = await getCustomerRecord(env, email);
    const grantedAt = first?.free_token_granted_at;
    expect(grantedAt).toEqual(expect.any(Number));

    const token2 = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token2);
    const second = await getCustomerRecord(env, email);
    expect(second?.free_token_granted_at).toBe(grantedAt);
  });

  it('preserves purchases through the grant', async () => {
    const email = 'purchasesafe@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token);

    const record = await getCustomerRecord(env, email);
    expect(record?.purchases).toHaveLength(1);
    expect(record?.purchases[0].stripe_session_id).toBe('sess_existing');
  });
});

describe('POST /api/free-token — spending', () => {
  async function verifiedCustomer(email: string) {
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token);
  }

  it('a granted, unspent token can be spent on a chosen track', async () => {
    const email = 'spender@example.com';
    await verifiedCustomer(email);

    const res = await spendReq(email, TRACK_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, key: TRACK_A });

    const record = await getCustomerRecord(env, email);
    expect(record?.free_token_spent_key).toBe(TRACK_A);
  });

  it('the choice sticks — a replay of the SAME key succeeds idempotently', async () => {
    const email = 'replay@example.com';
    await verifiedCustomer(email);
    await spendReq(email, TRACK_A);

    const res = await spendReq(email, TRACK_A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, key: TRACK_A });

    const record = await getCustomerRecord(env, email);
    expect(record?.free_token_spent_key).toBe(TRACK_A);
  });

  it('a second spend attempt on a DIFFERENT track is refused', async () => {
    const email = 'doublespend@example.com';
    await verifiedCustomer(email);
    await spendReq(email, TRACK_A);

    const res = await spendReq(email, TRACK_B);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already spent');

    // The original choice is untouched.
    const record = await getCustomerRecord(env, email);
    expect(record?.free_token_spent_key).toBe(TRACK_A);
  });

  it('a customer with no granted token is refused', async () => {
    const email = 'ungranted@example.com';
    await seedCustomer(email); // never verified — no token

    const res = await spendReq(email, TRACK_A);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('no token');
  });

  it('a signed-out caller is 401', async () => {
    const res = await freeTokenPost({
      request: new Request('https://morphicsmusic.com/api/free-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://morphicsmusic.com' },
        body: JSON.stringify({ key: TRACK_A }),
      }),
      env,
      waitUntil,
    } as any);
    expect(res.status).toBe(401);
  });

  it('an unrecognized key is refused, never partially spending the token', async () => {
    const email = 'badkey@example.com';
    await verifiedCustomer(email);

    const res = await spendReq(email, 'masters/../../etc/passwd');
    expect(res.status).toBe(400);

    const record = await getCustomerRecord(env, email);
    expect(record?.free_token_spent_key).toBeUndefined();
  });

  it('preserves purchases through the spend', async () => {
    const email = 'purchasesafe2@example.com';
    await verifiedCustomer(email);
    await spendReq(email, TRACK_A);

    const record = await getCustomerRecord(env, email);
    expect(record?.purchases).toHaveLength(1);
    expect(record?.purchases[0].stripe_session_id).toBe('sess_existing');
  });
});

describe('GET /api/download — free-song entitlement is additive, never a substitute', () => {
  it('the chosen track downloads successfully via the logged-in cookie path', async () => {
    const email = 'downloader@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token);
    await spendReq(email, TRACK_A);

    const res = await downloadByCookie(email, TRACK_A);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
  });

  it('a track that was NOT chosen is still refused, even for a verified customer with a token', async () => {
    const email = 'wrongtrack@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token);
    await spendReq(email, TRACK_A);

    const res = await downloadByCookie(email, TRACK_B);
    expect(res.status).toBe(403);
  });

  it('a verified customer who has NOT spent their token yet still cannot download an unowned track', async () => {
    const email = 'notyetspent@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token);

    const res = await downloadByCookie(email, TRACK_A);
    expect(res.status).toBe(403);
  });

  it("an existing paying customer's download of an owned release is completely unaffected by any of this", async () => {
    // dark-side-of-the-mind is the release this customer actually purchased
    // in seedCustomer() above — no free-song token involved at all.
    const email = 'payingcustomer@example.com';
    await seedCustomer(email);
    const ownedKey = 'masters/dark-side-of-the-mind/Morphics_-_Eartoy.wav';

    const res = await downloadByCookie(email, ownedKey);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');

    // Purchases are untouched by the request.
    const record = await getCustomerRecord(env, email);
    expect(record?.purchases).toHaveLength(1);
    expect(record?.purchases[0].music_release_slugs).toEqual(['dark-side-of-the-mind']);
  });

  it("a paying customer downloading a track they do NOT own is still refused, identically to before this feature", async () => {
    const email = 'payingcustomer2@example.com';
    await seedCustomer(email); // owns dark-side-of-the-mind only

    const res = await downloadByCookie(email, TRACK_A); // befuddled — not purchased
    expect(res.status).toBe(403);
  });
});

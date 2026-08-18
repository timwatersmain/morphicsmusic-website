// Endpoint-level tests for email verification: token issue/consume,
// GET /api/auth/verify-email, and POST /api/auth/resend-verification.
// Same KV-stub pattern as tests/auth/endpoints.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { onRequestGet as verifyEmailGet } from '../../functions/api/auth/verify-email';
import { onRequestPost as resendVerificationPost } from '../../functions/api/auth/resend-verification';
import { onRequestPost as passwordLoginPost } from '../../functions/api/auth/password-login';
import {
  issueVerifyEmailToken,
  consumeVerifyEmailToken,
  signSession,
  verifySession,
  getSessionVer,
  SESSION_COOKIE,
} from '../../functions/_lib/auth';
import { getCustomerRecord, saveCustomerRecord, saveUsernameIndex } from '../../functions/_lib/customer';

function makeKvStub() {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.has(key) ? store.get(key)! : null; },
    async put(key: string, value: string) { store.set(key, String(value)); },
    async delete(key: string) { store.delete(key); },
    _store: store,
  };
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
    AUTH_SECRET,
    PASSWORD_PEPPER: 'test-only-pepper-not-real-do-not-use',
    PASSWORD_KDF_ITERATIONS: '1000',
    // RESEND_API_KEY intentionally unset — no outbound email in tests.
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
      stripe_session_id: 'sess_1',
      music_release_slugs: ['some-ep'],
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

async function resendReq(cookie?: string, origin = 'https://morphicsmusic.com') {
  const headers: Record<string, string> = { Origin: origin };
  if (cookie) headers.Cookie = `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
  return resendVerificationPost({
    request: new Request('https://morphicsmusic.com/api/auth/resend-verification', { method: 'POST', headers }),
    env,
    waitUntil,
  } as any);
}

describe('email verification token lifecycle (functions/_lib/auth.ts)', () => {
  it('a fresh token consumes to the grant and is deleted from KV (single-use)', async () => {
    const token = await issueVerifyEmailToken(env, 'Fan@Example.com');
    expect(kv._store.has(`verifyemail:${token}`)).toBe(true);

    const grant = await consumeVerifyEmailToken(env, token);
    expect(grant).toEqual({ email: 'fan@example.com', created_at: expect.any(Number) });
    expect(kv._store.has(`verifyemail:${token}`)).toBe(false);
  });

  it('a consumed token cannot be reused', async () => {
    const token = await issueVerifyEmailToken(env, 'reuse@example.com');
    const first = await consumeVerifyEmailToken(env, token);
    expect(first).not.toBeNull();
    const second = await consumeVerifyEmailToken(env, token);
    expect(second).toBeNull();
  });

  it('an unknown/never-issued token is refused', async () => {
    const grant = await consumeVerifyEmailToken(env, 'not-a-real-token');
    expect(grant).toBeNull();
  });

  it('is a separate KV keyspace from login tokens — no key collision even at "same token string"', async () => {
    const token = await issueVerifyEmailToken(env, 'separate@example.com');
    expect(kv._store.has(`login:${token}`)).toBe(false);
    expect(kv._store.has(`verifyemail:${token}`)).toBe(true);
  });
});

describe('GET /api/auth/verify-email', () => {
  it('stamps email_verified_at on the customer record and redirects to the verified confirmation', async () => {
    const email = 'buyer@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);

    const res = await verifyEmailReq(token);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://morphicsmusic.com/account?verified=1');

    const record = await getCustomerRecord(env, email);
    expect(record?.email_verified_at).toEqual(expect.any(Number));
  });

  it('preserves purchases through the verification write (full read-modify-write, not a blind put)', async () => {
    const email = 'buyer2@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);
    await verifyEmailReq(token);

    const record = await getCustomerRecord(env, email);
    expect(record?.purchases).toHaveLength(1);
    expect(record?.purchases[0].stripe_session_id).toBe('sess_1');
  });

  it('a second use of the same token fails and lands on the friendly expired page, not an error', async () => {
    const email = 'onceonly@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);

    const first = await verifyEmailReq(token);
    expect(first.status).toBe(302);
    expect(first.headers.get('Location')).toBe('https://morphicsmusic.com/account?verified=1');

    const second = await verifyEmailReq(token);
    expect(second.status).toBe(302);
    expect(second.headers.get('Location')).toBe('https://morphicsmusic.com/account?verify_expired=1');
  });

  it('an expired/unknown token is refused with the friendly redirect, not a 4xx/5xx error', async () => {
    const res = await verifyEmailReq('this-token-was-never-issued');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://morphicsmusic.com/account?verify_expired=1');
  });

  it('missing token param is a plain 400, not a redirect', async () => {
    const res = await verifyEmailReq(null);
    expect(res.status).toBe(400);
  });

  it('never sets a session cookie and cannot authenticate the caller', async () => {
    const email = 'notasession@example.com';
    await seedCustomer(email);
    const token = await issueVerifyEmailToken(env, email);

    const res = await verifyEmailReq(token);
    expect(res.headers.get('Set-Cookie')).toBeNull();

    // Even if an attacker tried to use the (consumed, one-shot) token value
    // itself as a cookie, verifySession must reject it — it was never HMAC
    // signed as a session in the first place.
    const bogus = await verifySession(AUTH_SECRET, token, env);
    expect(bogus).toBeNull();
  });
});

describe('POST /api/auth/resend-verification', () => {
  it('401s a signed-out caller', async () => {
    const res = await resendReq();
    expect(res.status).toBe(401);
  });

  it('a signed-in unverified customer gets ok:true (email would be sent via waitUntil)', async () => {
    const email = 'unverified@example.com';
    await seedCustomer(email);
    const ver = await getSessionVer(env, email);
    const cookie = await signSession(AUTH_SECRET, email, ver);

    const res = await resendReq(cookie);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
  });

  it('an already-verified customer gets ok:true, already_verified:true, and no fresh token is minted', async () => {
    const email = 'alreadyverified@example.com';
    await seedCustomer(email, { email_verified_at: 12345 });
    const ver = await getSessionVer(env, email);
    const cookie = await signSession(AUTH_SECRET, email, ver);

    const beforeKeys = [...kv._store.keys()].filter((k) => k.startsWith('verifyemail:')).length;
    const res = await resendReq(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, already_verified: true });
    const afterKeys = [...kv._store.keys()].filter((k) => k.startsWith('verifyemail:')).length;
    expect(afterKeys).toBe(beforeKeys);
  });

  it('is rate-limited per email', async () => {
    const email = 'ratelimited@example.com';
    await seedCustomer(email);
    const ver = await getSessionVer(env, email);
    const cookie = await signSession(AUTH_SECRET, email, ver);

    let last;
    for (let i = 0; i < 4; i++) last = await resendReq(cookie);
    expect(last!.status).toBe(429);
  });

  it('is rate-limited per IP even across different accounts', async () => {
    for (let i = 0; i < 10; i++) {
      const email = `ipvictim${i}@example.com`;
      await seedCustomer(email);
      const ver = await getSessionVer(env, email);
      const cookie = await signSession(AUTH_SECRET, email, ver);
      await resendReq(cookie);
    }
    const email = 'ipvictim10@example.com';
    await seedCustomer(email);
    const ver = await getSessionVer(env, email);
    const cookie = await signSession(AUTH_SECRET, email, ver);
    const res = await resendReq(cookie);
    expect(res.status).toBe(429);
  });

  it('never mints a session — response carries no Set-Cookie', async () => {
    const email = 'nosessionfromresend@example.com';
    await seedCustomer(email);
    const ver = await getSessionVer(env, email);
    const cookie = await signSession(AUTH_SECRET, email, ver);

    const res = await resendReq(cookie);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});

describe('regression: unverified customers are ungated', () => {
  it('a magic-link-only, never-verified existing customer can still sign in and would still be able to download — verification adds no gate to password-login', async () => {
    // Simulate a pre-existing customer with a password but no verification
    // (every real customer today), matching the shape signup.ts writes.
    const email = 'preexisting@example.com';
    const { hashPassword } = await import('../../functions/_lib/password');
    await saveCustomerRecord(env, {
      email,
      name: null,
      first_seen_at: 1,
      last_seen_at: 1,
      purchases: [{
        purchased_at: 1,
        stripe_session_id: 'sess_old',
        music_release_slugs: ['old-release'],
        merch_items: [],
        amount_total: 999,
        currency: 'usd',
      }],
      username: 'preexisting',
      username_lower: 'preexisting',
      password: await hashPassword(env, 'originalpassword1'),
      password_updated_at: 1,
      // email_verified_at intentionally absent — this is the regression case.
    });
    await saveUsernameIndex(env, 'preexisting', email);

    const res = await passwordLoginPost({
      request: new Request('https://morphicsmusic.com/api/auth/password-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://morphicsmusic.com' },
        body: JSON.stringify({ identifier: 'preexisting', password: 'originalpassword1' }),
      }),
      env,
      waitUntil,
    } as any);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeTruthy();
    const m = setCookie!.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    const signedEmail = await verifySession(AUTH_SECRET, decodeURIComponent(m![1]), env);
    expect(signedEmail).toBe(email);

    // The purchase this customer already has is untouched by any of this.
    const record = await getCustomerRecord(env, email);
    expect(record?.purchases).toHaveLength(1);
    expect(record?.email_verified_at).toBeUndefined();
  });
});

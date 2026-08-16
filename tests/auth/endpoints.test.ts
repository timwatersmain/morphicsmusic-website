// Endpoint-level tests for the new username/password auth routes, modeled
// on tests/community/endpoints.test.js — a KV stub plus plain function
// calls, no workers runtime needed since these are exported PagesFunctions.

import { describe, it, expect, beforeEach } from 'vitest';
import { onRequestPost as signupPost } from '../../functions/api/auth/signup';
import { onRequestPost as passwordLoginPost } from '../../functions/api/auth/password-login';
import { verifySession, SESSION_COOKIE } from '../../functions/_lib/auth';

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
const PASSWORD_PEPPER = 'test-only-pepper-not-real-do-not-use';

let kv: ReturnType<typeof makeKvStub>;
let env: any;
let waited: Promise<any>[];

beforeEach(() => {
  kv = makeKvStub();
  waited = [];
  env = {
    DOWNLOADS: kv,
    AUTH_SECRET,
    PASSWORD_PEPPER,
    PASSWORD_KDF_ITERATIONS: '1000', // fast for tests
    // RESEND_API_KEY intentionally unset — no outbound email in tests.
  };
});

function req(url: string, body: any) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function waitUntil(p: Promise<any>) { waited.push(p); }

function cookieValue(res: Response): string | null {
  const raw = res.headers.get('Set-Cookie');
  if (!raw) return null;
  const m = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

async function signup(body: any) {
  return signupPost({ request: req('https://morphicsmusic.com/api/auth/signup', body), env, waitUntil } as any);
}
async function passwordLogin(body: any) {
  return passwordLoginPost({ request: req('https://morphicsmusic.com/api/auth/password-login', body), env, waitUntil } as any);
}

describe('POST /api/auth/signup validation', () => {
  it('rejects short passwords', async () => {
    const res = await signup({ username: 'shortpw', email: 'a@example.com', password: 'short1', confirm: 'short1' });
    expect(res.status).toBe(400);
  });

  it('rejects mismatched confirm', async () => {
    const res = await signup({ username: 'mismatch', email: 'b@example.com', password: 'longenoughpw1', confirm: 'longenoughpw2' });
    expect(res.status).toBe(400);
  });

  it('rejects bad usernames', async () => {
    const res = await signup({ username: 'a', email: 'c@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(res.status).toBe(400);
  });

  it('rejects usernames with disallowed characters', async () => {
    const res = await signup({ username: 'not valid!', email: 'd@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(res.status).toBe(400);
  });

  it('rejects blocked usernames', async () => {
    const res = await signup({ username: 'admin', email: 'e@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/signup success + duplicates', () => {
  it('creates an account and mints a session cookie', async () => {
    const res = await signup({ username: 'newfan', email: 'newfan@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    const cookie = cookieValue(res);
    expect(cookie).toBeTruthy();
    const email = await verifySession(AUTH_SECRET, cookie!, env);
    expect(email).toBe('newfan@example.com');
  });

  it('duplicate email returns the same generic body/status as success, without a new session', async () => {
    const first = await signup({ username: 'origuser', email: 'dup@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(first.status).toBe(200);

    const second = await signup({ username: 'differentname', email: 'dup@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await (await signup({ username: 'irrelevant2', email: 'brandnew2@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' })).json());
    // The original username must still resolve — the duplicate attempt did not overwrite it.
    const login = await passwordLogin({ identifier: 'origuser', password: 'longenoughpw1' });
    expect(login.status).toBe(200);
  });

  it('duplicate username returns the same generic body/status as success', async () => {
    const first = await signup({ username: 'takenname', email: 'owner@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(first.status).toBe(200);

    const second = await signup({ username: 'takenname', email: 'someoneelse@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });

    // The second email must NOT have gotten an account.
    const login = await passwordLogin({ identifier: 'someoneelse@example.com', password: 'longenoughpw1' });
    expect(login.status).toBe(401);
  });
});

describe('POST /api/auth/password-login', () => {
  beforeEach(async () => {
    const res = await signup({ username: 'loginfan', email: 'loginfan@example.com', password: 'correctpassword1', confirm: 'correctpassword1' });
    expect(res.status).toBe(200);
  });

  it('succeeds with username', async () => {
    const res = await passwordLogin({ identifier: 'loginfan', password: 'correctpassword1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('succeeds with email', async () => {
    const res = await passwordLogin({ identifier: 'loginfan@example.com', password: 'correctpassword1' });
    expect(res.status).toBe(200);
  });

  it('fails on wrong password', async () => {
    const res = await passwordLogin({ identifier: 'loginfan', password: 'totallywrongpassword' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('returns the SAME body and status for a nonexistent account as for a wrong password', async () => {
    const wrongPw = await passwordLogin({ identifier: 'loginfan', password: 'totallywrongpassword' });
    const noAccount = await passwordLogin({ identifier: 'nobody-here-at-all', password: 'whatever12345' });
    expect(noAccount.status).toBe(wrongPw.status);
    expect(await noAccount.json()).toEqual(await wrongPw.json());
  });
});

describe('session TTL / remember me', () => {
  beforeEach(async () => {
    const res = await signup({ username: 'rememberfan', email: 'rememberfan@example.com', password: 'correctpassword1', confirm: 'correctpassword1' });
    expect(res.status).toBe(200);
  });

  function expFromCookie(cookie: string): number {
    const payloadPart = cookie.split('.')[0];
    const pad = '='.repeat((4 - (payloadPart.length % 4)) % 4);
    const json = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
    return parseInt(json.split('|')[1], 10);
  }

  function maxAgeFromHeader(setCookie: string): number {
    const m = setCookie.match(/Max-Age=(\d+)/);
    return m ? parseInt(m[1], 10) : NaN;
  }

  it('remember produces a longer expiry than the default, and cookie Max-Age matches the token expiry', async () => {
    const normal = await passwordLogin({ identifier: 'rememberfan', password: 'correctpassword1' });
    const remembered = await passwordLogin({ identifier: 'rememberfan', password: 'correctpassword1', remember: true });

    const normalCookie = cookieValue(normal)!;
    const rememberedCookie = cookieValue(remembered)!;
    const normalExp = expFromCookie(normalCookie);
    const rememberedExp = expFromCookie(rememberedCookie);
    expect(rememberedExp).toBeGreaterThan(normalExp);

    const normalSetCookie = normal.headers.get('Set-Cookie')!;
    const rememberedSetCookie = remembered.headers.get('Set-Cookie')!;
    const normalMaxAge = maxAgeFromHeader(normalSetCookie);
    const rememberedMaxAge = maxAgeFromHeader(rememberedSetCookie);
    expect(rememberedMaxAge).toBeGreaterThan(normalMaxAge);

    // Cookie Max-Age and token expiry must agree (within a couple seconds
    // of test execution time) so the cookie never outlives — or dies before
    // — the token it carries.
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs((now + normalMaxAge) - normalExp)).toBeLessThan(5);
    expect(Math.abs((now + rememberedMaxAge) - rememberedExp)).toBeLessThan(5);
  });
});

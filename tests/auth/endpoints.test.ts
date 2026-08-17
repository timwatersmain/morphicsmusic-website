// Endpoint-level tests for the new username/password auth routes, modeled
// on tests/community/endpoints.test.js — a KV stub plus plain function
// calls, no workers runtime needed since these are exported PagesFunctions.

import { describe, it, expect, beforeEach } from 'vitest';
import { onRequestPost as signupPost } from '../../functions/api/auth/signup';
import { onRequestPost as passwordLoginPost } from '../../functions/api/auth/password-login';
import { onRequestPost as setPasswordPost } from '../../functions/api/auth/set-password';
import { onRequestGet as authStatusGet } from '../../functions/api/auth/status';
import { signSession, verifySession, getSessionVer, SESSION_COOKIE } from '../../functions/_lib/auth';

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

  // The hole this whole change is designed to avoid: signup has no verified
  // session, so trusting "the submitted email is the admin email" would let
  // ANYONE who merely knows the owner's address claim a reserved name. The
  // admin bypass must never reach this endpoint — this test fails loudly if
  // someone later "helpfully" wires it in here.
  it('rejects a blocked username even when the submitted email is the admin email', async () => {
    env.ADMIN_EMAILS = 'e2@example.com';
    const res = await signup({ username: 'moderator', email: 'e2@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/signup success + duplicates', () => {
  it('creates an account, issues NO session cookie, and the credentials work via password-login', async () => {
    const res = await signup({ username: 'newfan', email: 'newfan@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Set-Cookie')).toBeNull();

    // The signup page's follow-up call — this is how a new user actually
    // ends up signed in, never signup.ts itself.
    const login = await passwordLogin({ identifier: 'newfan', password: 'longenoughpw1' });
    expect(login.status).toBe(200);
    const cookie = cookieValue(login);
    expect(cookie).toBeTruthy();
    const email = await verifySession(AUTH_SECRET, cookie!, env);
    expect(email).toBe('newfan@example.com');
  });

  it('duplicate email (already has a password) returns the same generic body/status as success, issues no cookie', async () => {
    const first = await signup({ username: 'origuser', email: 'dup@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(first.status).toBe(200);

    const second = await signup({ username: 'differentname', email: 'dup@example.com', password: 'attackerpassword1', confirm: 'attackerpassword1' });
    const control = await signup({ username: 'irrelevant2', email: 'brandnew2@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(second.status).toBe(control.status);
    expect(await second.json()).toEqual(await control.json());
    expect(second.headers.get('Set-Cookie')).toBeNull();

    // The original credentials must still work — the duplicate attempt did
    // not overwrite the password.
    const login = await passwordLogin({ identifier: 'origuser', password: 'longenoughpw1' });
    expect(login.status).toBe(200);
    // The attacker's password must NOT work against this account.
    const attackerLogin = await passwordLogin({ identifier: 'origuser', password: 'attackerpassword1' });
    expect(attackerLogin.status).toBe(401);
  });

  it('duplicate username returns the same generic body/status as success, issues no cookie', async () => {
    const first = await signup({ username: 'takenname', email: 'owner@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(first.status).toBe(200);

    const second = await signup({ username: 'takenname', email: 'someoneelse@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    expect(second.headers.get('Set-Cookie')).toBeNull();

    // The second email must NOT have gotten an account.
    const login = await passwordLogin({ identifier: 'someoneelse@example.com', password: 'longenoughpw1' });
    expect(login.status).toBe(401);
  });

  // C1 regression test — the most important one in this file. Before the
  // fix, signup's duplicate guard was `!!existingRecord?.password`, so a
  // purchase-only customer record (real, from a past Stripe purchase, but
  // with no password ever set) fell through to the "create/merge" branch.
  // An attacker who knew a real customer's email could submit their own
  // password for that email and be handed a live session for that
  // customer's purchase history and downloads. The fix guards on the
  // record's mere EXISTENCE, not on whether it has a password.
  it('a purchase-only customer record cannot be claimed by signup, and no session is issued', async () => {
    const victimEmail = 'victim@example.com';
    // Simulate what stripe-webhook.ts's recordCustomerPurchase would have
    // written for a real buyer who has never signed up for a password.
    await kv.put(`customer:${victimEmail}`, JSON.stringify({
      email: victimEmail,
      name: 'Real Customer',
      first_seen_at: 1000,
      last_seen_at: 1000,
      purchases: [{
        purchased_at: 1000,
        stripe_session_id: 'sess_real_purchase',
        music_release_slugs: ['perception'],
        merch_items: [],
        amount_total: 500,
        currency: 'usd',
      }],
      // no username / password fields — purchase-only.
    }));

    const attack = await signup({ username: 'attacker', email: victimEmail, password: 'attackerchosen1', confirm: 'attackerchosen1' });

    // Generic response — indistinguishable from a real success.
    expect(attack.status).toBe(200);
    expect(await attack.json()).toEqual({ ok: true });
    // No session for the attacker, under any name.
    expect(attack.headers.get('Set-Cookie')).toBeNull();

    // The customer record itself must be untouched — no password, no
    // username, purchase history intact.
    const raw = await kv.get(`customer:${victimEmail}`);
    const record = JSON.parse(raw!);
    expect(record.password).toBeUndefined();
    expect(record.username).toBeUndefined();
    expect(record.purchases).toHaveLength(1);

    // The attacker's chosen username must not resolve to this account (or
    // any account) — the reverse index was never written.
    expect(await kv.get('username:attacker')).toBeNull();

    // Neither the attacker's username nor the victim's email can log in
    // with the attacker's password — there is no password on the account.
    const byUsername = await passwordLogin({ identifier: 'attacker', password: 'attackerchosen1' });
    expect(byUsername.status).toBe(401);
    const byEmail = await passwordLogin({ identifier: victimEmail, password: 'attackerchosen1' });
    expect(byEmail.status).toBe(401);
  });

  it('signup issues no Set-Cookie in ANY case: success, duplicate email, duplicate username', async () => {
    const success = await signup({ username: 'cookiecheck1', email: 'cookiecheck1@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(success.headers.get('Set-Cookie')).toBeNull();

    const dupEmail = await signup({ username: 'cookiecheck2', email: 'cookiecheck1@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(dupEmail.headers.get('Set-Cookie')).toBeNull();

    const dupUsername = await signup({ username: 'cookiecheck1', email: 'someoneelsecookie@example.com', password: 'longenoughpw1', confirm: 'longenoughpw1' });
    expect(dupUsername.headers.get('Set-Cookie')).toBeNull();
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

  it('locks out after repeated failures, rejecting even the CORRECT password once tripped (C5)', async () => {
    // 5 wrong-password attempts trips the FAIL_LIMIT lockout. Stay within
    // the per-identifier attempt-velocity limiter's budget (6/10min) so the
    // 6th call is rejected by the LOCKOUT specifically, not by that limiter.
    for (let i = 0; i < 5; i++) {
      const res = await passwordLogin({ identifier: 'loginfan', password: 'wrongattempt' + i });
      expect(res.status).toBe(401);
    }
    const stillLocked = await passwordLogin({ identifier: 'loginfan', password: 'correctpassword1' });
    expect(stillLocked.status).toBe(401);
    expect(await stillLocked.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('locks out a username+email pair as ONE account, not two separate buckets (C5)', async () => {
    // Alternate identifier form across failures — if the lockout were keyed
    // on the raw identifier (pre-fix), this would take 10 failures (5 per
    // bucket) instead of 5 to trip.
    for (let i = 0; i < 5; i++) {
      const identifier = i % 2 === 0 ? 'loginfan' : 'loginfan@example.com';
      const res = await passwordLogin({ identifier, password: 'wrongattempt' + i });
      expect(res.status).toBe(401);
    }
    const stillLocked = await passwordLogin({ identifier: 'loginfan', password: 'correctpassword1' });
    expect(stillLocked.status).toBe(401);
  });
});

describe('POST /api/auth/password-login with Turnstile enabled', () => {
  beforeEach(async () => {
    const res = await signup({ username: 'tsfan', email: 'tsfan@example.com', password: 'correctpassword1', confirm: 'correctpassword1' });
    expect(res.status).toBe(200);
  });

  // Pins the exact production bug from the security review: signup.astro
  // used to follow a successful signup with an immediate password-login
  // call carrying no `turnstile` field (the signup token is single-use and
  // already spent). With TURNSTILE_SECRET_KEY configured, verifyTurnstile
  // rejects an empty token before any network call — so that follow-up
  // call failed 100% of the time on the live site, telling every real
  // signup it had failed. The fix (signup.astro) redirects to /login
  // instead of making this call; this test guards the server behavior the
  // fix depends on: an empty token must be rejected when Turnstile is on.
  it('rejects a login with no turnstile token when a secret is configured, with no network call', async () => {
    const withSecret = { ...env, TURNSTILE_SECRET_KEY: 'test-secret-not-real' };
    const res = await passwordLoginPost({
      request: req('https://morphicsmusic.com/api/auth/password-login', { identifier: 'tsfan', password: 'correctpassword1' }),
      env: withSecret,
      waitUntil,
    } as any);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('still succeeds with no turnstile secret configured (local dev shape used by the rest of this suite)', async () => {
    const res = await passwordLogin({ identifier: 'tsfan', password: 'correctpassword1' });
    expect(res.status).toBe(200);
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

describe('POST /api/auth/set-password (C3, C4)', () => {
  async function setPassword(body: any, cookie: string) {
    return setPasswordPost({
      request: new Request('https://morphicsmusic.com/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` },
        body: JSON.stringify(body),
      }),
      env,
      waitUntil,
    } as any);
  }

  it('rejects a password change without current_password when one is already set, and does not touch the account', async () => {
    const signupRes = await signup({ username: 'setpwfan', email: 'setpwfan@example.com', password: 'originalpassword1', confirm: 'originalpassword1' });
    expect(signupRes.status).toBe(200);
    const loginRes = await passwordLogin({ identifier: 'setpwfan', password: 'originalpassword1' });
    const cookie = cookieValue(loginRes)!;

    const attempt = await setPassword({ username: 'setpwfan', password: 'newpassword1', confirm: 'newpassword1' }, cookie);
    expect(attempt.status).toBe(401);

    // The original password must still work.
    const stillWorks = await passwordLogin({ identifier: 'setpwfan', password: 'originalpassword1' });
    expect(stillWorks.status).toBe(200);
  });

  it('accepts the change with the correct current_password, bumps session_ver, and re-issues a working cookie', async () => {
    const signupRes = await signup({ username: 'setpwfan2', email: 'setpwfan2@example.com', password: 'originalpassword1', confirm: 'originalpassword1' });
    expect(signupRes.status).toBe(200);
    const loginRes = await passwordLogin({ identifier: 'setpwfan2', password: 'originalpassword1' });
    const oldCookie = cookieValue(loginRes)!;
    const verBefore = await getSessionVer(env, 'setpwfan2@example.com');

    const changed = await setPassword(
      { username: 'setpwfan2', password: 'newpassword1', confirm: 'newpassword1', current_password: 'originalpassword1' },
      oldCookie,
    );
    expect(changed.status).toBe(200);
    const newCookie = cookieValue(changed)!;
    expect(newCookie).toBeTruthy();

    const verAfter = await getSessionVer(env, 'setpwfan2@example.com');
    expect(verAfter).toBeGreaterThan(verBefore);

    // The OLD cookie (pre-change session) must now be rejected...
    const oldStillValid = await verifySession(AUTH_SECRET, oldCookie, env);
    expect(oldStillValid).toBeNull();
    // ...but the NEW cookie issued by this response must work.
    const newValid = await verifySession(AUTH_SECRET, newCookie, env);
    expect(newValid).toBe('setpwfan2@example.com');

    // New password logs in; old one no longer does.
    const withNewPw = await passwordLogin({ identifier: 'setpwfan2', password: 'newpassword1' });
    expect(withNewPw.status).toBe(200);
    const withOldPw = await passwordLogin({ identifier: 'setpwfan2', password: 'originalpassword1' });
    expect(withOldPw.status).toBe(401);
  });

  it('a customer with no password yet is exempt from the current_password requirement (first-time set)', async () => {
    // Simulate a magic-link-only customer with a real session but no
    // password field on their record at all.
    const email = 'magiclinkonly@example.com';
    await kv.put(`customer:${email}`, JSON.stringify({
      email, name: null, first_seen_at: 1, last_seen_at: 1, purchases: [],
    }));
    const ver = await getSessionVer(env, email);
    const cookie = await signSession(AUTH_SECRET, email, ver);

    const res = await setPassword({ username: 'firsttimer', password: 'brandnewpassword1', confirm: 'brandnewpassword1' }, cookie);
    expect(res.status).toBe(200);
  });

  it('deletes the old username reverse-index entry on rename (C4)', async () => {
    const email = 'renamer@example.com';
    const signupRes = await signup({ username: 'oldname', email, password: 'originalpassword1', confirm: 'originalpassword1' });
    expect(signupRes.status).toBe(200);
    const loginRes = await passwordLogin({ identifier: 'oldname', password: 'originalpassword1' });
    const cookie = cookieValue(loginRes)!;

    const renamed = await setPassword(
      { username: 'newname', password: 'anotherpassword1', confirm: 'anotherpassword1', current_password: 'originalpassword1' },
      cookie,
    );
    expect(renamed.status).toBe(200);

    expect(await kv.get('username:oldname')).toBeNull();
    expect(await kv.get('username:newname')).toBe(email);

    const oldNameLogin = await passwordLogin({ identifier: 'oldname', password: 'anotherpassword1' });
    expect(oldNameLogin.status).toBe(401);
    const newNameLogin = await passwordLogin({ identifier: 'newname', password: 'anotherpassword1' });
    expect(newNameLogin.status).toBe(200);
  });

  describe('admin name bypass', () => {
    it('a non-admin session is still refused a blocked username', async () => {
      env.ADMIN_EMAILS = 'someoneelse@example.com'; // admin exists, but not this caller
      const signupRes = await signup({ username: 'notadmin1', email: 'notadmin1@example.com', password: 'originalpassword1', confirm: 'originalpassword1' });
      expect(signupRes.status).toBe(200);
      const loginRes = await passwordLogin({ identifier: 'notadmin1', password: 'originalpassword1' });
      const cookie = cookieValue(loginRes)!;

      const res = await setPassword(
        { username: 'moderator', password: 'anotherpassword1', confirm: 'anotherpassword1', current_password: 'originalpassword1' },
        cookie,
      );
      expect(res.status).toBe(400);
    });

    it('an admin session may take a blocked username', async () => {
      const email = 'realowner@example.com';
      env.ADMIN_EMAILS = email;
      const signupRes = await signup({ username: 'tempname', email, password: 'originalpassword1', confirm: 'originalpassword1' });
      expect(signupRes.status).toBe(200);
      const loginRes = await passwordLogin({ identifier: 'tempname', password: 'originalpassword1' });
      const cookie = cookieValue(loginRes)!;

      const res = await setPassword(
        { username: 'moderator', password: 'anotherpassword1', confirm: 'anotherpassword1', current_password: 'originalpassword1' },
        cookie,
      );
      expect(res.status).toBe(200);

      const login = await passwordLogin({ identifier: 'moderator', password: 'anotherpassword1' });
      expect(login.status).toBe(200);
    });

    it('an admin is still subject to the username character-set rule and to uniqueness', async () => {
      const email = 'realowner2@example.com';
      env.ADMIN_EMAILS = email;
      const signupRes = await signup({ username: 'tempname2', email, password: 'originalpassword1', confirm: 'originalpassword1' });
      expect(signupRes.status).toBe(200);
      const loginRes = await passwordLogin({ identifier: 'tempname2', password: 'originalpassword1' });
      const cookie = cookieValue(loginRes)!;

      // Fails the USERNAME_RE character-set/length rule regardless of admin status.
      const badChars = await setPassword(
        { username: 'not valid!', password: 'anotherpassword1', confirm: 'anotherpassword1', current_password: 'originalpassword1' },
        cookie,
      );
      expect(badChars.status).toBe(400);

      // Someone else already owns this exact (non-blocked) username — still
      // rejected for an admin, uniqueness is not part of the bypass.
      const otherSignup = await signup({ username: 'alreadytaken', email: 'other@example.com', password: 'originalpassword1', confirm: 'originalpassword1' });
      expect(otherSignup.status).toBe(200);
      const taken = await setPassword(
        { username: 'alreadytaken', password: 'anotherpassword1', confirm: 'anotherpassword1', current_password: 'originalpassword1' },
        cookie,
      );
      expect(taken.status).toBe(400);
    });

    it('with ADMIN_EMAILS unset, nobody is an admin and blocked usernames stay blocked', async () => {
      delete env.ADMIN_EMAILS;
      const email = 'realowner3@example.com';
      const signupRes = await signup({ username: 'tempname3', email, password: 'originalpassword1', confirm: 'originalpassword1' });
      expect(signupRes.status).toBe(200);
      const loginRes = await passwordLogin({ identifier: 'tempname3', password: 'originalpassword1' });
      const cookie = cookieValue(loginRes)!;

      const res = await setPassword(
        { username: 'moderator', password: 'anotherpassword1', confirm: 'anotherpassword1', current_password: 'originalpassword1' },
        cookie,
      );
      expect(res.status).toBe(400);
    });
  });
});

describe('GET /api/auth/status', () => {
  function statusReq(cookie?: string) {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = `${SESSION_COOKIE}=${encodeURIComponent(cookie)}`;
    return authStatusGet({
      request: new Request('https://morphicsmusic.com/api/auth/status', { headers }),
      env,
      waitUntil,
    } as any);
  }

  it('401s a signed-out caller', async () => {
    const res = await statusReq();
    expect(res.status).toBe(401);
  });

  // The whole reason this endpoint exists: /account needs to tell a
  // purchase-only, magic-link-signed-in customer apart from one who already
  // has a password, using a signal /api/community/me's handle can't give it
  // (every fan gets a handle, password or not).
  it('reports has_password: false and username: null for a magic-link-only customer with no password', async () => {
    const email = 'magiclinkonly2@example.com';
    await kv.put(`customer:${email}`, JSON.stringify({
      email, name: null, first_seen_at: 1, last_seen_at: 1, purchases: [],
    }));
    const ver = await getSessionVer(env, email);
    const cookie = await signSession(AUTH_SECRET, email, ver);

    const res = await statusReq(cookie);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ email, has_password: false, username: null });
  });

  it('reports has_password: true and the username once one is set', async () => {
    const signupRes = await signup({ username: 'statusfan', email: 'statusfan@example.com', password: 'originalpassword1', confirm: 'originalpassword1' });
    expect(signupRes.status).toBe(200);
    const loginRes = await passwordLogin({ identifier: 'statusfan', password: 'originalpassword1' });
    const cookie = cookieValue(loginRes)!;

    const res = await statusReq(cookie);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ email: 'statusfan@example.com', has_password: true, username: 'statusfan' });
  });
});

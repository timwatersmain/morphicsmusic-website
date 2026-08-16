// POST /api/auth/set-password  { username, password, confirm, current_password? }
// Session required (cookie from either magic-link or password login). Lets
// an existing customer — most commonly a magic-link-only buyer — add or
// change their username/password. Same validation as signup.
//
// If the account already has a password, current_password must match it —
// otherwise a stolen/borrowed session cookie could silently convert into
// permanent full ownership of the account (change the password, keep the
// old session, lock the real owner out of new logins while their other
// sessions quietly keep working). A customer who has never set a password
// is exempt — this endpoint IS how they get their first one.
//
// On a successful change we bump session_ver, which invalidates every other
// outstanding session for this account (including whatever cookie an
// attacker who triggered this had), then re-issue a fresh cookie for the
// caller so they aren't logged out by their own change.
import {
  readCookie,
  verifySession,
  signSession,
  sessionCookieHeader,
  bumpSessionVer,
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
} from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit } from '../../_lib/ratelimit';
import { hashPassword, verifyPassword } from '../../_lib/password';
import { isBlockedName } from '../../_lib/community/handle';
import {
  getCustomerRecord,
  getCustomerByUsername,
  saveCustomerRecord,
  saveUsernameIndex,
  deleteUsernameIndex,
  CustomerRecord,
} from '../../_lib/customer';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  PASSWORD_PEPPER: string;
  PASSWORD_KDF_ITERATIONS?: string;
}

const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
const MIN_PASSWORD = 10;

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const rl = await rateLimit(env, 'setpw', 'em', email, 5, 600); // 5 / 10 min per account
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'rate_limited', retry_after: rl.retryAfter }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter) },
    });
  }

  let body: { username?: string; password?: string; confirm?: string; current_password?: string };
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const usernameRaw = (body.username || '').trim();
  const usernameLower = usernameRaw.toLowerCase();
  const password = body.password || '';
  const confirm = body.confirm || '';
  const currentPassword = body.current_password || '';

  if (!USERNAME_RE.test(usernameLower)) {
    return new Response(JSON.stringify({ error: 'username must be 3-24 characters: a-z, 0-9, underscore, hyphen' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (isBlockedName(usernameLower)) {
    return new Response(JSON.stringify({ error: 'that username is not available' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (password.length < MIN_PASSWORD) {
    return new Response(JSON.stringify({ error: `password must be at least ${MIN_PASSWORD} characters` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (password !== confirm) {
    return new Response(JSON.stringify({ error: 'passwords do not match' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const existingByUsername = await getCustomerByUsername(env, usernameLower);
  if (existingByUsername && existingByUsername.email !== email) {
    return new Response(JSON.stringify({ error: 'that username is not available' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const now = Math.floor(Date.now() / 1000);
  const existing = await getCustomerRecord(env, email);
  const record: CustomerRecord = existing || {
    email,
    name: null,
    first_seen_at: now,
    last_seen_at: now,
    purchases: [],
  };

  // Require the current password whenever one is already set. A customer
  // with no password yet (magic-link-only, or a fresh purchase-only record)
  // is exempt — that's the legitimate first-time-set path.
  if (record.password) {
    if (!currentPassword) {
      return new Response(JSON.stringify({ error: 'current password required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const check = await verifyPassword(env, currentPassword, record.password);
    if (!check.ok) {
      return new Response(JSON.stringify({ error: 'current password incorrect' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const previousUsernameLower = record.username_lower;

  record.username = usernameRaw;
  record.username_lower = usernameLower;
  record.password = await hashPassword(env, password);
  record.password_updated_at = now;

  await saveCustomerRecord(env, record);
  await saveUsernameIndex(env, usernameLower, email);
  // Drop the stale reverse-index entry for the old name, if it changed, so
  // it stops resolving and someone else can eventually claim it.
  if (previousUsernameLower && previousUsernameLower !== usernameLower) {
    await deleteUsernameIndex(env, previousUsernameLower);
  }

  // Bump session_ver so every OTHER outstanding session for this account —
  // including a borrowed/stolen cookie that triggered this change — is
  // invalidated, then mint a fresh cookie so the caller stays signed in.
  const newVer = await bumpSessionVer(env, email);
  const session = await signSession(env.AUTH_SECRET, email, newVer);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('Set-Cookie', sessionCookieHeader(session));
  return new Response(JSON.stringify({ ok: true }), { headers });
});

// POST /api/auth/set-password  { username, password, confirm }
// Session required (cookie from either magic-link or password login). Lets
// an existing customer — most commonly a magic-link-only buyer — add a
// username and password so they can log in without email round-trips next
// time. Same validation as signup.
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit } from '../../_lib/ratelimit';
import { hashPassword } from '../../_lib/password';
import { isBlockedName } from '../../_lib/community/handle';
import { getCustomerRecord, getCustomerByUsername, saveCustomerRecord, saveUsernameIndex, CustomerRecord } from '../../_lib/customer';

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

  let body: { username?: string; password?: string; confirm?: string };
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const usernameRaw = (body.username || '').trim();
  const usernameLower = usernameRaw.toLowerCase();
  const password = body.password || '';
  const confirm = body.confirm || '';

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
  record.username = usernameRaw;
  record.username_lower = usernameLower;
  record.password = await hashPassword(env, password);
  record.password_updated_at = now;

  await saveCustomerRecord(env, record);
  await saveUsernameIndex(env, usernameLower, email);

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});

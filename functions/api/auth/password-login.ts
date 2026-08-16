// POST /api/auth/password-login  { identifier, password, remember?, turnstile? }
// identifier is a username OR an email. Generic 401 for "no such account"
// and "wrong password" alike — see verifyPassword/dummyVerify for the
// matching timing-parity work.
import {
  signSession,
  sessionCookieHeader,
  getSessionVer,
  SESSION_TTL_SECONDS,
  REMEMBER_TTL_SECONDS,
} from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, clientIp } from '../../_lib/ratelimit';
import { verifyTurnstile } from '../../_lib/turnstile';
import { verifyPassword, dummyVerify, hashPassword } from '../../_lib/password';
import { getCustomerRecord, getCustomerByUsername, saveCustomerRecord } from '../../_lib/customer';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  PASSWORD_PEPPER: string;
  PASSWORD_KDF_ITERATIONS?: string;
  TURNSTILE_SECRET_KEY?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FAIL_LIMIT = 5;
const FAIL_WINDOW_SEC = 900; // 15 min

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

function genericFail(): Response {
  return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Peek at the failure-lockout counter without incrementing it — rateLimit()
// always increments on read, which isn't what a "how many failures so far"
// check needs. Same key shape as ratelimit.ts (`rl:<scope>:<bucket>:<id>`)
// so the two stay compatible if this ever gets folded back in.
async function failureCount(env: Env, identifier: string): Promise<number> {
  const raw = await env.DOWNLOADS.get(`rl:pwlogin_fail:id:${identifier}`);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

async function recordFailure(env: Env, identifier: string): Promise<void> {
  const count = await failureCount(env, identifier);
  await env.DOWNLOADS.put(`rl:pwlogin_fail:id:${identifier}`, String(count + 1), { expirationTtl: FAIL_WINDOW_SEC });
}

async function clearFailures(env: Env, identifier: string): Promise<void> {
  await env.DOWNLOADS.delete(`rl:pwlogin_fail:id:${identifier}`);
}

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  let body: { identifier?: string; password?: string; remember?: boolean; turnstile?: string };
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const identifier = (body.identifier || '').trim();
  const password = body.password || '';
  const remember = body.remember === true;
  if (!identifier || !password) return genericFail();

  const identifierLower = identifier.toLowerCase();
  const ip = clientIp(request);

  const tsOk = await verifyTurnstile(env, body.turnstile || '', ip);
  if (!tsOk) return genericFail();

  // Stricter than magic-link login.ts (5/10min IP, 3/hour email): password
  // guessing is a velocity attack in a way a magic-link request per se isn't.
  const ipOk = await rateLimit(env, 'pwlogin', 'ip', ip, 8, 600); // 8 / 10 min per IP
  const idOk = await rateLimit(env, 'pwlogin', 'id', identifierLower, 6, 600); // 6 / 10 min per identifier
  if (!ipOk.ok || !idOk.ok) return genericFail();

  // Failed-attempt lockout, tracked separately from the attempt-velocity
  // limiter above so a handful of legitimate retries (typo'd password)
  // don't trip it, but a sustained guessing run against one account does.
  if ((await failureCount(env, identifierLower)) >= FAIL_LIMIT) {
    await dummyVerify(env); // keep response timing identical to the normal fail path
    return genericFail();
  }

  const record = identifier.includes('@') && EMAIL_RE.test(identifierLower)
    ? await getCustomerRecord(env, identifierLower)
    : await getCustomerByUsername(env, identifierLower);

  if (!record || !record.password) {
    // No such account (or a purchase-only record with no password set yet).
    // Run the same-cost dummy hash so response time doesn't distinguish
    // "no account" from "wrong password" below.
    await dummyVerify(env);
    await recordFailure(env, identifierLower);
    return genericFail();
  }

  const result = await verifyPassword(env, password, record.password);
  if (!result.ok) {
    await recordFailure(env, identifierLower);
    return genericFail();
  }

  await clearFailures(env, identifierLower);

  // Standard rehash-on-login upgrade path: if the stored hash used fewer
  // iterations than currently configured, re-hash at the new cost and save
  // — transparent to the user, no forced password reset.
  if (result.needsRehash) {
    record.password = await hashPassword(env, password);
    record.password_updated_at = Math.floor(Date.now() / 1000);
    await saveCustomerRecord(env, record);
  }

  const ttlDays = remember ? 365 : 30;
  const maxAge = remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS;
  const ver = await getSessionVer(env, record.email);
  const session = await signSession(env.AUTH_SECRET, record.email, ver, ttlDays);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  // maxAge must match the token's own expiry (also ttlDays) — a cookie that
  // outlives its token, or the reverse, is a silent, confusing logout.
  headers.set('Set-Cookie', sessionCookieHeader(session, { maxAge }));
  return new Response(JSON.stringify({ ok: true }), { headers });
});

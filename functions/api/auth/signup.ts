// POST /api/auth/signup  { username, email, password, confirm, turnstile? }
// Creates a username+password account. Reuses an existing customer record
// (from a past purchase) for the same email rather than clobbering it —
// see functions/_lib/customer.ts.
import { signSession, sessionCookieHeader, getSessionVer } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, clientIp } from '../../_lib/ratelimit';
import { verifyTurnstile } from '../../_lib/turnstile';
import { hashPassword } from '../../_lib/password';
import { isBlockedName } from '../../_lib/community/handle';
import {
  getCustomerRecord,
  getCustomerByUsername,
  saveCustomerRecord,
  saveUsernameIndex,
  CustomerRecord,
} from '../../_lib/customer';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  PASSWORD_PEPPER: string;
  PASSWORD_KDF_ITERATIONS?: string;
  RESEND_API_KEY: string;
  ORDER_FROM_EMAIL?: string;
  PUBLIC_SITE_URL?: string;
  TURNSTILE_SECRET_KEY?: string;
}

const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 10;

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

async function sendAccountEmail(env: Env, to: string, kind: 'created' | 'duplicate'): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const configured = env.ORDER_FROM_EMAIL;
  const from = (!configured || configured.endsWith('@resend.dev')) ? 'orders@morphicsmusic.com' : configured;
  const site = env.PUBLIC_SITE_URL || 'https://morphicsmusic.com';
  const subject = kind === 'created' ? 'Your Morphics account' : 'Someone tried to sign up with your email';
  const html = kind === 'created'
    ? `<div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
        <h1 style="font-weight:700;letter-spacing:-0.02em">Account created</h1>
        <p>Your Morphics account is ready. Sign in any time with your username and password at <a href="${site}/login" style="color:#e8e8ec">${site}/login</a>.</p>
        <p style="opacity:0.4;font-size:11px;margin-top:32px">If you didn't create this account, contact us right away.</p>
      </div>`
    : `<div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
        <h1 style="font-weight:700;letter-spacing:-0.02em">Someone tried to sign up with your email</h1>
        <p>You already have a Morphics account with this address. If this was you, sign in instead — if you forgot your password, use the "forgot password" link to get a sign-in email.</p>
        <p style="opacity:0.4;font-size:11px;margin-top:32px">If this wasn't you, no action is needed — no account changes were made.</p>
      </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Morphics <${from}>`, to: [to], subject, html }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('signup email send failed:', e);
  }
}

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env, waitUntil }) => {
  let body: { username?: string; email?: string; password?: string; confirm?: string; turnstile?: string };
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const email = (body.email || '').trim().toLowerCase();
  const usernameRaw = (body.username || '').trim();
  const usernameLower = usernameRaw.toLowerCase();
  const password = body.password || '';
  const confirm = body.confirm || '';

  // Format validation is not an enumeration oracle — it doesn't reveal
  // whether any account exists, just whether the input is well-formed.
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: 'invalid email' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
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

  const ip = clientIp(request);
  const tsOk = await verifyTurnstile(env, body.turnstile || '', ip);
  if (!tsOk) {
    // Same silent-success shape as a rate-limit hit — don't tell a bot
    // whether the challenge or the account state is what failed it.
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const ipOk = await rateLimit(env, 'signup', 'ip', ip, 8, 600); // 8 / 10 min per IP
  const emailOk = await rateLimit(env, 'signup', 'em', email, 4, 3600); // 4 / hour per email
  if (!ipOk.ok || !emailOk.ok) {
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Generic-response body used for BOTH real success and every duplicate
  // case below — an attacker probing emails/usernames can't tell them apart
  // from the HTTP response.
  const genericOk = () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });

  const existingByUsername = await getCustomerByUsername(env, usernameLower);
  if (existingByUsername) {
    // Username taken (by anyone). Don't create an account, don't mint a
    // session. No email is sent — the address on this request may not even
    // own the conflicting username, so we have nothing true to tell it.
    return genericOk();
  }

  const existingRecord = await getCustomerRecord(env, email);
  const alreadyHasAccount = !!existingRecord?.password;
  if (alreadyHasAccount) {
    waitUntil(sendAccountEmail(env, email, 'duplicate'));
    return genericOk();
  }

  // New account, or a purchase-only record gaining credentials for the
  // first time — merge onto the existing record so purchase history
  // survives, per functions/_lib/customer.ts.
  const now = Math.floor(Date.now() / 1000);
  const record: CustomerRecord = existingRecord || {
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

  const ver = await getSessionVer(env, email);
  const session = await signSession(env.AUTH_SECRET, email, ver);
  waitUntil(sendAccountEmail(env, email, 'created'));

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('Set-Cookie', sessionCookieHeader(session));
  return new Response(JSON.stringify({ ok: true }), { headers });
});

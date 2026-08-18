// POST /api/auth/signup  { username, email, password, confirm, turnstile? }
// Creates a username+password account for a brand-new email. Deliberately
// NEVER mints a session, in any branch — see the security-review fix notes
// in the accounts-server-report.md for why. The signup page is expected to
// immediately call /api/auth/password-login with the credentials the user
// just typed, so a genuinely new signup still ends up signed in with no
// extra step from the user's point of view.
//
// A customer record that already exists for the email — INCLUDING a
// purchase-only record with no password set — is never claimed by this
// endpoint. That upgrade path is set-password.ts, reached only after
// authenticating (magic link or existing password). Guarding on "does a
// record exist" rather than "does the record have a password" is load
// bearing: guarding on password-presence let an attacker submit a stranger's
// email + their own chosen password and get handed a live session for that
// customer's purchase history and downloads.
import { issueLoginToken } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, clientIp } from '../../_lib/ratelimit';
import { verifyTurnstile } from '../../_lib/turnstile';
import { hashPassword } from '../../_lib/password';
import { isBlockedName } from '../../_lib/community/handle';
import { sendVerificationEmail } from '../../_lib/send-verify-email';
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

async function sendCreatedEmail(env: Env, to: string): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const configured = env.ORDER_FROM_EMAIL;
  const from = (!configured || configured.endsWith('@resend.dev')) ? 'orders@morphicsmusic.com' : configured;
  const site = env.PUBLIC_SITE_URL || 'https://morphicsmusic.com';
  const html = `<div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
      <h1 style="font-weight:700;letter-spacing:-0.02em">Account created</h1>
      <p>Your Morphics account is ready. Sign in any time with your username and password at <a href="${site}/login" style="color:#e8e8ec">${site}/login</a>.</p>
      <p style="opacity:0.4;font-size:11px;margin-top:32px">If you didn't create this account, contact us right away.</p>
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Morphics <${from}>`, to: [to], subject: 'Your Morphics account', html }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('signup created-email send failed:', e);
  }
}

// Sent when the email already has a customer record (with or without a
// password) — includes a real magic link so a purchase-only customer, who
// has no password to sign in with yet, can actually get back in from this
// email rather than being told to do something they can't do.
async function sendDuplicateEmail(env: Env, request: Request, to: string): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const configured = env.ORDER_FROM_EMAIL;
  const from = (!configured || configured.endsWith('@resend.dev')) ? 'orders@morphicsmusic.com' : configured;
  const origin = env.PUBLIC_SITE_URL || new URL(request.url).origin;
  let url = `${origin}/login`;
  try {
    const token = await issueLoginToken(env, to);
    url = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  } catch (e) {
    console.error('signup duplicate-email token issue failed:', e);
  }
  const html = `<div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
      <h1 style="font-weight:700;letter-spacing:-0.02em">You already have an account</h1>
      <p>This email already has a Morphics account. Click below to sign in — no password needed.</p>
      <p style="margin:24px 0">
        <a href="${url}" style="background:#fff;color:#000;padding:14px 24px;text-decoration:none;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:11px">Sign in</a>
      </p>
      <p>Once you're signed in, you can set a username and password at <a href="${origin}/account" style="color:#e8e8ec">${origin}/account</a> so you don't need a mailed link next time.</p>
      <p style="opacity:0.4;font-size:11px;margin-top:32px">If this wasn't you, no action is needed — no account changes were made. Link expires in 15 minutes.</p>
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Morphics <${from}>`, to: [to], subject: 'Someone tried to sign up with your email', html }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('signup duplicate-email send failed:', e);
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

  // Generic-response body used for EVERY branch below (both duplicate cases
  // and real success) — an attacker probing emails/usernames can't tell them
  // apart from the HTTP response. Both lookups run unconditionally, on every
  // request, so the KV-read count is also identical across branches; only
  // the account-creation branch and the two duplicate branches differ, and
  // each of those does exactly one hashPassword-equivalent PBKDF2 run before
  // responding, so wall-clock time doesn't leak it either.
  const genericOk = () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });

  const existingByUsername = await getCustomerByUsername(env, usernameLower);
  const existingByEmail = await getCustomerRecord(env, email);

  if (existingByEmail) {
    // ANY existing record for this email — purchase-only or already fully
    // signed up — blocks this endpoint from touching it. A dummy hash keeps
    // this branch's cost equal to the real signup branch's hashPassword
    // call, closing the timing gap a plain KV-read-only rejection would leave.
    await hashPassword(env, password);
    waitUntil(sendDuplicateEmail(env, request, email));
    return genericOk();
  }

  if (existingByUsername) {
    // Username taken by some other email. Nothing true to email this
    // address about (it may not be the username's owner), so no email goes
    // out — but still pay the same dummy-hash cost as every other branch.
    await hashPassword(env, password);
    return genericOk();
  }

  // Brand-new email and username — create the account. No session is
  // minted here; the client immediately follows up with password-login
  // using the credentials just submitted.
  const now = Math.floor(Date.now() / 1000);
  const record: CustomerRecord = {
    email,
    name: null,
    first_seen_at: now,
    last_seen_at: now,
    purchases: [],
    username: usernameRaw,
    username_lower: usernameLower,
    password: await hashPassword(env, password),
    password_updated_at: now,
  };

  await saveCustomerRecord(env, record);
  await saveUsernameIndex(env, usernameLower, email);
  waitUntil(sendCreatedEmail(env, email));
  // Alongside the welcome mail, not instead of it — verification records a
  // fact about the address, it doesn't gate this signup in any way.
  const origin = env.PUBLIC_SITE_URL || new URL(request.url).origin;
  waitUntil(sendVerificationEmail(env, origin, email));

  return genericOk();
});

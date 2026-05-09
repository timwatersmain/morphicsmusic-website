// POST /api/auth/login  { email, redirect? }
// Sends a magic-link email. Token expires after 15 min, single-use.
import { issueLoginToken } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';

interface Env {
  DOWNLOADS: KVNamespace;
  RESEND_API_KEY: string;
  ORDER_FROM_EMAIL?: string;
  PUBLIC_SITE_URL?: string;
  TURNSTILE_SECRET_KEY?: string;
}

// Verify a Turnstile token against Cloudflare's siteverify endpoint.
// Returns true on success, false on any failure. If TURNSTILE_SECRET_KEY
// is unset (e.g. local dev) we treat the challenge as disabled — login
// works without it but rate limits still apply.
async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET_KEY);
    form.append('response', token);
    if (ip && ip !== 'unknown') form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data: any = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

// Only accept same-origin path redirects to prevent the magic link from
// being weaponized into an authed open-redirect for phishing.
function safeRedirect(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input !== 'string') return undefined;
  if (input.length > 256) return undefined;
  if (!input.startsWith('/')) return undefined;
  if (input.startsWith('//') || input.startsWith('/\\')) return undefined;
  return input;
}

async function checkRateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const raw = await env.DOWNLOADS.get(`rl:${key}`);
  const count = raw ? parseInt(raw, 10) || 0 : 0;
  if (count >= limit) return false;
  await env.DOWNLOADS.put(`rl:${key}`, String(count + 1), { expirationTtl: windowSec });
  return true;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env, waitUntil }) => {
  let body: { email?: string; redirect?: string; turnstile?: string };
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  const email = (body.email || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'invalid email' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // Turnstile gate: the site key in the page must produce a token that
  // siteverify accepts. Treated like a rate-limit hit — silent 200 — so
  // bots can't probe whether the challenge is failing them or whether
  // the email exists.
  const tsOk = await verifyTurnstile(env, body.turnstile || '', ip);
  if (!tsOk) {
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Rate limit: 5 / 10 min per IP, 3 / hour per email. Always-200 below means
  // we silently succeed when limits hit so we don't leak enumeration signals.
  const ipOk = await checkRateLimit(env, `login:ip:${ip}`, 5, 600);
  const emailOk = await checkRateLimit(env, `login:em:${email}`, 3, 3600);
  if (!ipOk || !emailOk) {
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const redirect = safeRedirect(body.redirect);
  const token = await issueLoginToken(env, email, redirect);
  const origin = env.PUBLIC_SITE_URL || new URL(request.url).origin;
  const url = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  // Fire-and-forget the email via waitUntil so the response time on the
  // happy path matches the rate-limited path — closes a timing oracle that
  // would otherwise let an attacker tell whether the limit had triggered.
  // 5s timeout so a slow Resend doesn't hang the worker indefinitely.
  if (env.RESEND_API_KEY) {
    const from = env.ORDER_FROM_EMAIL || 'onboarding@resend.dev';
    waitUntil((async () => {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: `Morphics <${from}>`,
            to: [email],
            subject: 'Your Morphics login link',
            html: `
              <div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
                <h1 style="font-weight:700;letter-spacing:-0.02em">Sign in to Morphics</h1>
                <p>Click below to access your library — purchases, downloads, and future updates.</p>
                <p style="margin:24px 0">
                  <a href="${url}" style="background:#fff;color:#000;padding:14px 24px;text-decoration:none;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:11px">Sign in</a>
                </p>
                <p style="opacity:0.4;font-size:11px;margin-top:32px">Link expires in 15 minutes. If you didn't request this, ignore the email.</p>
              </div>`,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        console.error('login email send failed:', e);
      }
    })());
  }
  // Always 200 — don't leak whether the email exists in any system.
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});

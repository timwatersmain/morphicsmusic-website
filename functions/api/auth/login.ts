// POST /api/auth/login  { email, redirect? }
// Sends a magic-link email. Token expires after 15 min, single-use.
import { issueLoginToken } from '../../_lib/auth';

interface Env {
  DOWNLOADS: KVNamespace;
  RESEND_API_KEY: string;
  ORDER_FROM_EMAIL?: string;
  PUBLIC_SITE_URL?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { email?: string; redirect?: string };
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'invalid email' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const token = await issueLoginToken(env, email, body.redirect);
  const origin = env.PUBLIC_SITE_URL || new URL(request.url).origin;
  const url = `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  if (env.RESEND_API_KEY) {
    const from = env.ORDER_FROM_EMAIL || 'onboarding@resend.dev';
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
    });
  }
  // Always 200 — don't leak whether the email exists in any system.
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};

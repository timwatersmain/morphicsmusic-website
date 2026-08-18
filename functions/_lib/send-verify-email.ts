// Shared "confirm your email" transactional mail. Used by signup.ts (sent
// alongside the existing welcome mail on signup) and resend-verification.ts
// (sent on demand for a signed-in but unverified customer). Kept in one
// place so the link-building and house HTML styling stay identical no
// matter which endpoint fired it — mirrors the dark-card/mono-uppercase-CTA
// look used by login.ts's magic-link email.
import { issueVerifyEmailToken } from './auth';

interface Env {
  DOWNLOADS: KVNamespace;
  RESEND_API_KEY: string;
  ORDER_FROM_EMAIL?: string;
}

export async function sendVerificationEmail(env: Env, origin: string, to: string): Promise<void> {
  // Issue the token unconditionally — same order as login.ts's
  // issueLoginToken — so local dev (no RESEND_API_KEY) still produces a
  // consumable token in KV; only the actual network send is gated below.
  const token = await issueVerifyEmailToken(env, to);
  if (!env.RESEND_API_KEY) return;
  // onboarding@resend.dev only delivers to the account owner (see login.ts) —
  // same guard here so a stale ORDER_FROM_EMAIL never silently swallows a
  // real customer's verification mail.
  const configured = env.ORDER_FROM_EMAIL;
  const from = (!configured || configured.endsWith('@resend.dev')) ? 'orders@morphicsmusic.com' : configured;
  const url = `${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const html = `
    <div style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8ec;padding:32px;max-width:560px;margin:auto">
      <h1 style="font-weight:700;letter-spacing:-0.02em">Confirm your email</h1>
      <p>One click confirms this address is yours.</p>
      <p style="margin:24px 0">
        <a href="${url}" style="background:#fff;color:#000;padding:14px 24px;text-decoration:none;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;font-size:11px">Verify email</a>
      </p>
      <p style="opacity:0.4;font-size:11px;margin-top:32px">Link expires in 24 hours. If you didn't create a Morphics account, no action is needed — nothing happens unless this link is clicked.</p>
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Morphics <${from}>`, to: [to], subject: 'Confirm your email — Morphics', html }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('verification email send failed:', e);
  }
}

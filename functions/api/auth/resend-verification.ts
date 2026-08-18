// POST /api/auth/resend-verification
// Session required (same cookie check as set-password.ts / status.ts).
// Re-sends the "confirm your email" link for the CALLER's own address —
// there is no email field in the request body, so this can never be pointed
// at anyone else's inbox, closing off both enumeration and spam-someone-
// else's-mailbox abuse.
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { getCustomerRecord } from '../../_lib/customer';
import { sendVerificationEmail } from '../../_lib/send-verify-email';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  RESEND_API_KEY: string;
  ORDER_FROM_EMAIL?: string;
  PUBLIC_SITE_URL?: string;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request, 'POST, OPTIONS');

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env, waitUntil }) => {
  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // Per-email AND per-IP: per-email stops a borrowed/looping session from
  // hammering Resend for one account; per-IP stops one IP from grinding
  // through many signed-in sessions' resend allowances.
  const ip = clientIp(request);
  const emailLimit = await rateLimit(env, 'resendverify', 'em', email, 3, 3600); // 3 / hour per account
  const ipLimit = await rateLimit(env, 'resendverify', 'ip', ip, 10, 600); // 10 / 10 min per IP
  if (!emailLimit.ok) return rateLimitedJson(emailLimit);
  if (!ipLimit.ok) return rateLimitedJson(ipLimit);

  const record = await getCustomerRecord(env, email);
  if (record?.email_verified_at) {
    // Nothing to send — still 200 so the client treats this as success,
    // not an error state.
    return new Response(JSON.stringify({ ok: true, already_verified: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const origin = env.PUBLIC_SITE_URL || new URL(request.url).origin;
  waitUntil(sendVerificationEmail(env, origin, email));

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});

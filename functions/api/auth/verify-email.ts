// GET /api/auth/verify-email?token=xxx
// Consumes an email-verification token and stamps the customer record with
// email_verified_at. Deliberately does NOT authenticate anything — no
// session cookie is ever set here, and this handler is reachable with no
// cookie at all. Per the brief, clicking this link may only mark an address
// verified; it must never be usable to sign in or take over an account.
//
// The write is a full read-modify-write on the existing customer record
// (never a blind put of a partial object), so purchases and every other
// field pass through untouched — same discipline as customer.ts's other
// writers.
import { consumeVerifyEmailToken } from '../../_lib/auth';
import { rateLimit, clientIp } from '../../_lib/ratelimit';
import { getCustomerRecord, saveCustomerRecord } from '../../_lib/customer';

interface Env {
  DOWNLOADS: KVNamespace;
  PUBLIC_SITE_URL?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const origin = env.PUBLIC_SITE_URL || url.origin;

  // Same shape as verify.ts's magic-link rate limit — tokens are 192-bit
  // cryptographic randoms so brute force is infeasible, this just stops
  // grinding attacks against KV. On hit, land on the same friendly
  // "get a fresh one" state as an expired/used token rather than an error.
  const rl = await rateLimit(env, 'verifyemail', 'ip', clientIp(request), 30, 60);
  if (!rl.ok) {
    return Response.redirect(`${origin}/account?verify_expired=1`, 302);
  }

  const token = url.searchParams.get('token');
  if (!token) return new Response('missing token', { status: 400 });

  const grant = await consumeVerifyEmailToken(env, token);
  if (!grant) {
    // Expired or already-used — friendly "here's a fresh one" landing, never
    // a bare error page, mirroring magic-link verify.ts's ?expired=1.
    return Response.redirect(`${origin}/account?verify_expired=1`, 302);
  }

  const record = await getCustomerRecord(env, grant.email);
  if (!record) {
    // Nothing to stamp (record vanished between issue and consume) — still
    // treat as "expired", never a bare error.
    return Response.redirect(`${origin}/account?verify_expired=1`, 302);
  }

  // Full read-modify-write: only email_verified_at changes. Idempotent if a
  // link is somehow re-delivered before this response lands — re-stamping
  // the same field is harmless.
  record.email_verified_at = Math.floor(Date.now() / 1000);
  await saveCustomerRecord(env, record);

  return Response.redirect(`${origin}/account?verified=1`, 302);
};

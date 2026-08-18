// GET /api/auth/status — for the signed-in caller, whether their customer
// record already has a username/password set, and if so what username.
//
// Exists for the /account page: it needs to decide between the "set up
// sign-in" (first-time) form and the "update" (requires current_password)
// form BEFORE the visitor submits anything, and set-password.ts itself is
// POST-only and read-nothing. /api/community/me's `profile.handle` looks
// tempting for this but is NOT a reliable signal — every fan gets a handle
// (falling back to a "fan-NNNN" placeholder) whether or not they have a
// password, so it can't distinguish the two states. This endpoint reads the
// same customer record set-password.ts writes and reports the one field
// (password presence) that actually answers the question.
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { getCustomerRecord } from '../../_lib/customer';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  const rl = await rateLimit(env, 'authstatus', 'ip', clientIp(request), 60, 60);
  if (!rl.ok) return rateLimitedJson(rl);

  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const record = await getCustomerRecord(env, email);
  const hasPassword = !!(record && record.password);
  const username = (record && hasPassword && record.username) || null;
  const emailVerified = !!(record && record.email_verified_at);

  return new Response(JSON.stringify({
    email,
    has_password: hasPassword,
    username,
    email_verified: emailVerified,
    email_verified_at: (record && record.email_verified_at) || null,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

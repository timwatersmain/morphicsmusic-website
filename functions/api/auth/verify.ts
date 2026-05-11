// GET /api/auth/verify?token=xxx
// Consumes a magic-link token, sets the session cookie, redirects to /library
// (or to whatever ?redirect= path was originally requested).
import { consumeLoginToken, signSession, sessionCookieHeader, getSessionVer } from '../../_lib/auth';
import { rateLimit, clientIp } from '../../_lib/ratelimit';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  PUBLIC_SITE_URL?: string;
}

// Same allow-list as login.ts safeRedirect — re-validate post-consume in
// case any future code path writes a LoginGrant with an unsanitized
// redirect, so the magic link can never be turned into an open redirect.
function safeRedirect(input: string | undefined): string | undefined {
  if (!input || typeof input !== 'string') return undefined;
  if (input.length > 256) return undefined;
  if (!input.startsWith('/')) return undefined;
  if (input.startsWith('//') || input.startsWith('/\\')) return undefined;
  return input;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  // 30 verifies per IP per minute. Tokens are 256-bit cryptographic randoms
  // so brute-force is infeasible; this just stops grinding attacks against KV.
  // On hit we redirect to /login?expired=1 — same UX as a stale token.
  const rl = await rateLimit(env, 'verify', 'ip', clientIp(request), 30, 60);
  if (!rl.ok) {
    return Response.redirect(`${env.PUBLIC_SITE_URL || url.origin}/login?expired=1`, 302);
  }
  const token = url.searchParams.get('token');
  if (!token) return new Response('missing token', { status: 400 });
  const grant = await consumeLoginToken(env, token);
  if (!grant) {
    return Response.redirect(`${env.PUBLIC_SITE_URL || url.origin}/login?expired=1`, 302);
  }
  const ver = await getSessionVer(env, grant.email);
  const session = await signSession(env.AUTH_SECRET, grant.email, ver);
  const dest = safeRedirect(grant.redirect) || '/library';
  // Use a 303 response body to set Set-Cookie reliably (Response.redirect
  // doesn't preserve headers consistently across edge runtimes). Strip
  // Referer so the consumed token can't leak to anything on /library.
  return new Response(null, {
    status: 303,
    headers: {
      Location: dest,
      'Set-Cookie': sessionCookieHeader(session),
      'Referrer-Policy': 'no-referrer',
    },
  });
};

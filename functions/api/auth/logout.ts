// POST /api/auth/logout — bumps the user's session_ver (invalidates every
// outstanding cookie minted before this point) and clears both the
// __Host-prefixed cookie and the legacy unprefixed one.
import {
  bumpSessionVer,
  readCookie,
  sessionCookieHeader,
  verifySession,
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
} from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';

interface Env {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  // Read either cookie name so transition logout works.
  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  // Bump server-side version so the cookie value, even if exfiltrated, is
  // immediately rejected on next /api/* call. Best-effort: KV write may
  // race with concurrent verify reads.
  if (email) await bumpSessionVer(env, email);
  // Clear both cookie names so a stale unprefixed cookie can't linger.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', sessionCookieHeader('', { clear: true }));
  headers.append('Set-Cookie', sessionCookieHeader('', { clear: true, legacy: true }));
  return new Response(JSON.stringify({ ok: true }), { headers });
});

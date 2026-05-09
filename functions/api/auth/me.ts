// GET /api/auth/me — returns { email } if cookie valid, { email: null } otherwise.
import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';

interface Env {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) return new Response(JSON.stringify({ email: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ email }), { headers: { 'Content-Type': 'application/json' } });
});

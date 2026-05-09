// GET /api/auth/me — returns { email } if cookie valid, { email: null } otherwise.
import { readCookie, verifySession } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';

interface Env { AUTH_SECRET: string; }

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<Env> = corsHandler<Env>(async ({ request, env }) => {
  const cookie = readCookie(request, 'morphics_auth') || '';
  const email = await verifySession(env.AUTH_SECRET, cookie);
  if (!email) return new Response(JSON.stringify({ email: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ email }), { headers: { 'Content-Type': 'application/json' } });
});

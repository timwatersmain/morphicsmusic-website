// GET /api/auth/verify?token=xxx
// Consumes a magic-link token, sets the session cookie, redirects to /library
// (or to whatever ?redirect= path was originally requested).
import { consumeLoginToken, signSession, sessionCookieHeader } from '../../_lib/auth';

interface Env {
  DOWNLOADS: KVNamespace;
  AUTH_SECRET: string;
  PUBLIC_SITE_URL?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return new Response('missing token', { status: 400 });
  const grant = await consumeLoginToken(env, token);
  if (!grant) {
    return Response.redirect(`${env.PUBLIC_SITE_URL || url.origin}/login?expired=1`, 302);
  }
  const session = await signSession(env.AUTH_SECRET, grant.email);
  const dest = grant.redirect || '/library';
  // Use a 303 response body to set Set-Cookie reliably (Response.redirect
  // doesn't preserve headers consistently across edge runtimes).
  return new Response(null, {
    status: 303,
    headers: {
      Location: dest,
      'Set-Cookie': sessionCookieHeader(session),
    },
  });
};

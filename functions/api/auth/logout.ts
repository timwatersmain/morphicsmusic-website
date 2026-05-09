// POST /api/auth/logout — clears the session cookie.
import { sessionCookieHeader } from '../../_lib/auth';
import { corsHandler, preflight } from '../../_lib/cors';

export const onRequestOptions: PagesFunction = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction = corsHandler(async () => {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookieHeader('', { clear: true }),
    },
  });
});

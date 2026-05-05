// POST /api/auth/logout — clears the session cookie.
import { sessionCookieHeader } from '../../_lib/auth';

export const onRequestPost: PagesFunction = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookieHeader('', { clear: true }),
    },
  });
};

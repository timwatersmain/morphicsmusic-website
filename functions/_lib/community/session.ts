// Every /api/community endpoint is fans-only. This is the single place that
// decides "is there a signed-in fan here", reusing the existing session
// cookie machinery in functions/_lib/auth.ts unchanged.

import {
  readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE,
} from '../auth';

export interface CommunityEnv {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
  GATES: D1Database;
}

/** Signed-in fan's email, or null. Never send this value to a client. */
export async function requireFan(request: Request, env: CommunityEnv): Promise<string | null> {
  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  return verifySession(env.AUTH_SECRET, cookie, env);
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Minimal admin gate. There is no admin system on this site yet — this is
// the smallest thing that works: a comma-separated allow-list of emails in
// ADMIN_EMAILS, checked against the caller's session email using the
// existing requireFan/verifySession machinery (functions/_lib/auth.ts)
// unchanged, same as every /api/community endpoint.

import { readCookie, verifySession, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from './auth';

export interface AdminEnv {
  AUTH_SECRET: string;
  DOWNLOADS: KVNamespace;
  ADMIN_EMAILS?: string;
}

/** Signed-in admin's email, or null if signed out, not a fan, or not listed. */
export async function requireAdmin(request: Request, env: AdminEnv): Promise<string | null> {
  const cookie =
    readCookie(request, SESSION_COOKIE) ||
    readCookie(request, LEGACY_SESSION_COOKIE) ||
    '';
  const email = await verifySession(env.AUTH_SECRET, cookie, env);
  if (!email) return null;

  const admins = (env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.toLowerCase()) ? email : null;
}

/**
 * A non-admin (including a signed-out caller) must get exactly what an
 * unknown route would — a bare 404 — never a 403, which would confirm the
 * endpoint exists at all.
 */
export function adminNotFound(): Response {
  return new Response('Not found', { status: 404 });
}

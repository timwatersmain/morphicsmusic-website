// POST   /api/admin/grant-avatar   { email, avatar_id }  — grant tiers 3-4
// DELETE /api/admin/grant-avatar   { email, avatar_id }  — revoke
//
// The only path that can ever put a tier-3/4 (duotone / glyph_overlay)
// avatar into fan_avatar_unlocks — no automatic rule ever awards them (see
// the 'manual' UnlockRule case in unlocks.ts). Also works for release/
// special avatars if ever needed; nothing here is tier-specific by design,
// since an admin manually correcting any grant is a legitimate use.
//
// A caller who is not a listed admin gets the same 404 an unknown route
// would — see requireAdmin/adminNotFound in _lib/admin.ts. Never a 403,
// which would confirm this endpoint exists.

import { corsHandler, preflight } from '../../_lib/cors';
import { requireAdmin, adminNotFound, type AdminEnv } from '../../_lib/admin';
import { getProfileByEmail, getAvatarById, grantUnlocks, revokeUnlock } from '../../_lib/community/repo';

interface Env extends AdminEnv {
  GATES: D1Database;
}

// Advertise DELETE alongside POST — this endpoint accepts both (grant/
// revoke), and a cross-origin DELETE preflight would otherwise fail against
// the shared default of "GET, POST, OPTIONS".
export const onRequestOptions: PagesFunction<Env> = async ({ request }) => preflight(request, 'POST, DELETE, OPTIONS');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function handle(request: Request, env: Env, action: 'grant' | 'revoke'): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (!admin) return adminNotFound();

  let body: { email?: string; avatar_id?: string };
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const email = (body.email || '').trim().toLowerCase();
  const avatarId = (body.avatar_id || '').trim();
  if (!email || !avatarId) return json({ error: 'email and avatar_id are required' }, 400);

  const avatar = await getAvatarById(env.GATES, avatarId);
  if (!avatar) return json({ error: 'unknown avatar' }, 404);

  const profile = await getProfileByEmail(env.GATES, email);
  if (!profile) return json({ error: 'no fan profile for that email' }, 404);

  if (action === 'grant') {
    // source_ref carries the granting admin's email, purely for audit —
    // never surfaced to any client response.
    await grantUnlocks(env.GATES, profile.id, [{ avatarId, source: 'admin_grant', sourceRef: admin }]);
  } else {
    await revokeUnlock(env.GATES, profile.id, avatarId);
  }

  return json({ ok: true });
}

export const onRequestPost: PagesFunction<Env> = corsHandler<Env>(
  async ({ request, env }) => handle(request, env, 'grant'),
);

export const onRequestDelete: PagesFunction<Env> = corsHandler<Env>(
  async ({ request, env }) => handle(request, env, 'revoke'),
);

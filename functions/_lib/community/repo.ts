// All D1 access for the community feature. Every function takes the database
// as its first argument so tests can inject a node:sqlite shim.

import { nextAvailableHandle, isValidDisplayName } from './handle';
import type { AvatarCatalogueRow, FanProfileRow, PublicProfile, UnlockGrant } from './types';

const now = () => Math.floor(Date.now() / 1000);

export async function getProfileByHandle(
  db: D1Database, handle: string,
): Promise<FanProfileRow | null> {
  return db.prepare('SELECT * FROM fan_profiles WHERE handle = ?')
    .bind(handle).first<FanProfileRow>();
}

export async function getProfileByEmail(
  db: D1Database, email: string,
): Promise<FanProfileRow | null> {
  return db.prepare('SELECT * FROM fan_profiles WHERE email = ?')
    .bind(email.toLowerCase().trim()).first<FanProfileRow>();
}

/**
 * Fetch the fan's profile, creating it if this is their first visit.
 *
 * `displayName` is only used at creation — it never overwrites a name the fan
 * has since chosen. The handle is derived from the display name and is never
 * derived from the email, which must not leak into a fan-facing identifier.
 */
export async function ensureProfile(
  db: D1Database,
  opts: { email: string; fanSince: number; displayName?: string | null },
): Promise<FanProfileRow> {
  const email = opts.email.toLowerCase().trim();
  const existing = await getProfileByEmail(db, email);
  if (existing) return existing;

  const name = isValidDisplayName(opts.displayName || '') ? opts.displayName!.trim() : 'Fan';
  const handle = await nextAvailableHandle(name, async h => !!(await getProfileByHandle(db, h)));
  const t = now();

  await db.prepare(
    `INSERT INTO fan_profiles (email, handle, display_name, fan_since, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(email, handle, name, opts.fanSince, t, t, t).run();

  // Re-read rather than construct: a concurrent request may have won the race,
  // in which case the unique index means our insert failed and theirs stands.
  const created = await getProfileByEmail(db, email);
  if (!created) throw new Error('profile creation failed');
  return created;
}

/** Insert grants, ignoring ones already held. Returns how many were new. */
export async function grantUnlocks(
  db: D1Database, fanId: number, grants: UnlockGrant[],
): Promise<number> {
  if (!grants.length) return 0;
  const held = new Set(await getUnlockedAvatarIds(db, fanId));
  const fresh = grants.filter(g => !held.has(g.avatarId));
  if (!fresh.length) return 0;
  const t = now();
  for (const g of fresh) {
    // ON CONFLICT DO NOTHING makes this safe against a concurrent grant too —
    // the pre-filter above is an optimisation, not the correctness guarantee.
    await db.prepare(
      `INSERT INTO fan_avatar_unlocks (fan_id, avatar_id, unlocked_at, source, source_ref)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (fan_id, avatar_id) DO NOTHING`,
    ).bind(fanId, g.avatarId, t, g.source, g.sourceRef).run();
  }
  return fresh.length;
}

export async function getUnlockedAvatarIds(db: D1Database, fanId: number): Promise<string[]> {
  const { results } = await db.prepare(
    'SELECT avatar_id FROM fan_avatar_unlocks WHERE fan_id = ? ORDER BY unlocked_at',
  ).bind(fanId).all<{ avatar_id: string }>();
  return (results || []).map(r => r.avatar_id);
}

export async function getCatalogue(db: D1Database): Promise<AvatarCatalogueRow[]> {
  const { results } = await db.prepare(
    'SELECT * FROM avatar_catalogue ORDER BY sort_order, id',
  ).all<AvatarCatalogueRow>();
  return results || [];
}

/** avatarId -> fraction of all fans holding it (0..1). Empty when no fans. */
export async function getRarity(db: D1Database): Promise<Record<string, number>> {
  const total = await db.prepare('SELECT COUNT(*) AS c FROM fan_profiles')
    .first<{ c: number }>();
  const fans = total?.c || 0;
  if (!fans) return {};
  const { results } = await db.prepare(
    'SELECT avatar_id, COUNT(*) AS c FROM fan_avatar_unlocks GROUP BY avatar_id',
  ).all<{ avatar_id: string; c: number }>();
  const out: Record<string, number> = {};
  for (const r of results || []) out[r.avatar_id] = r.c / fans;
  return out;
}

/**
 * Directory page. Ordered by rank_points then tenure — rank_points is a
 * placeholder (always 0) until the loyalty sub-project lands, so in practice
 * this currently orders by who has been a fan longest.
 */
export async function getDirectory(
  db: D1Database, opts: { limit: number; offset: number },
): Promise<FanProfileRow[]> {
  const limit = Math.min(Math.max(opts.limit | 0, 1), 100);
  const offset = Math.max(opts.offset | 0, 0);
  const { results } = await db.prepare(
    `SELECT * FROM fan_profiles ORDER BY rank_points DESC, fan_since ASC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<FanProfileRow>();
  return results || [];
}

export async function updateProfile(
  db: D1Database,
  fanId: number,
  fields: { displayName?: string; equippedAvatarId?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.displayName !== undefined) { sets.push('display_name = ?'); args.push(fields.displayName); }
  if (fields.equippedAvatarId !== undefined) { sets.push('equipped_avatar_id = ?'); args.push(fields.equippedAvatarId); }
  if (!sets.length) return;
  sets.push('updated_at = ?'); args.push(now());
  args.push(fanId);
  await db.prepare(`UPDATE fan_profiles SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
}

export async function setCollectionCount(db: D1Database, fanId: number, count: number): Promise<void> {
  await db.prepare('UPDATE fan_profiles SET collection_count = ?, updated_at = ? WHERE id = ?')
    .bind(count, now(), fanId).run();
}

/**
 * The ONLY shape that may be sent to a client. Constructed by explicit
 * allow-list rather than by deleting fields, so a column added to
 * fan_profiles later cannot leak by default.
 */
export function toPublicProfile(
  row: FanProfileRow,
  avatar: AvatarCatalogueRow | null,
): PublicProfile {
  return {
    handle: row.handle,
    display_name: row.display_name,
    fan_since: row.fan_since,
    rank_points: row.rank_points,
    collection_count: row.collection_count,
    avatar: avatar ? { id: avatar.id, name: avatar.name, art_path: avatar.art_path } : null,
  };
}

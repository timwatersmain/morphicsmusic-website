// All D1 access for the community feature. Every function takes the database
// as its first argument so tests can inject a node:sqlite shim.

import { nextAvailableHandle, isValidDisplayName, isBlockedName } from './handle';
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

  // Defence in depth: update.ts is the normal path that enforces
  // isBlockedName, but a seeded/imported displayName should never be able to
  // slip a reserved word (e.g. "admin") straight into a handle either.
  const rawName = opts.displayName || '';
  const name = (isValidDisplayName(rawName) && !isBlockedName(rawName)) ? rawName.trim() : 'Fan';
  const handle = await nextAvailableHandle(name, async h => !!(await getProfileByHandle(db, h)));
  const t = now();

  try {
    await db.prepare(
      `INSERT INTO fan_profiles (email, handle, display_name, fan_since, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(email, handle, name, opts.fanSince, t, t, t).run();
  } catch (err) {
    // A concurrent request created this profile between our read above and
    // this insert. The unique index on email makes that insert THROW — it
    // does not fail silently — so the recovery has to live in a catch. Their
    // row stands; return it. If no row is there, the error was something
    // else entirely and must not be swallowed.
    const raced = await getProfileByEmail(db, email);
    if (raced) return raced;
    throw err;
  }

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
 * Directory page. Matches the copy on /community — "ranked by rarity and
 * tenure" — by ordering on the number of avatars each fan has actually
 * unlocked (descending), then tenure (ascending) as the tiebreaker.
 * `rank_points` is a placeholder column (always 0) until the loyalty
 * sub-project lands, so it cannot be the sort key yet.
 */
export async function getDirectory(
  db: D1Database, opts: { limit: number; offset: number },
): Promise<FanProfileRow[]> {
  const limit = Math.min(Math.max(opts.limit | 0, 1), 100);
  const offset = Math.max(opts.offset | 0, 0);
  const { results } = await db.prepare(
    `SELECT fp.*, COUNT(u.avatar_id) AS unlock_count
       FROM fan_profiles fp
       LEFT JOIN fan_avatar_unlocks u ON u.fan_id = fp.id
       GROUP BY fp.id
       ORDER BY unlock_count DESC, fp.fan_since ASC
       LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<FanProfileRow>();
  return results || [];
}

function buildProfileSets(
  fields: { displayName?: string; equippedAvatarId?: string | null; handleLocked?: boolean },
  handle: string | undefined,
): { sets: string[]; args: unknown[] } {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.displayName !== undefined) { sets.push('display_name = ?'); args.push(fields.displayName); }
  if (fields.equippedAvatarId !== undefined) { sets.push('equipped_avatar_id = ?'); args.push(fields.equippedAvatarId); }
  if (handle !== undefined) { sets.push('handle = ?'); args.push(handle); }
  if (fields.handleLocked) { sets.push('handle_locked = ?'); args.push(1); }
  return { sets, args };
}

async function runProfileUpdate(
  db: D1Database, fanId: number, built: { sets: string[]; args: unknown[] },
): Promise<void> {
  if (!built.sets.length) return;
  const args = [...built.args, now(), fanId];
  await db.prepare(`UPDATE fan_profiles SET ${built.sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...args).run();
}

export async function updateProfile(
  db: D1Database,
  fanId: number,
  fields: { displayName?: string; equippedAvatarId?: string | null; handle?: string; handleLocked?: boolean },
): Promise<void> {
  if (fields.handle === undefined) {
    await runProfileUpdate(db, fanId, buildProfileSets(fields, undefined));
    return;
  }

  try {
    await runProfileUpdate(db, fanId, buildProfileSets(fields, fields.handle));
    return;
  } catch (err) {
    // A concurrent regeneration landed on the same candidate handle first —
    // idx_fan_profiles_handle throws rather than failing silently, same
    // shape as ensureProfile's insert race. Re-derive a fresh candidate off
    // the same base name and retry exactly once.
    const retryBase = fields.displayName ?? fields.handle;
    const retryHandle = await nextAvailableHandle(
      retryBase, async h => !!(await getProfileByHandle(db, h)),
    );
    try {
      await runProfileUpdate(db, fanId, buildProfileSets(fields, retryHandle));
      return;
    } catch {
      // Still colliding. A fan renaming themselves must never get a 500 over
      // a handle collision — keep the existing handle and persist everything
      // else instead.
      await runProfileUpdate(db, fanId, buildProfileSets(fields, undefined));
    }
  }
}

/**
 * Regenerate `handle` from `newName`, but ONLY while the handle is still
 * unlocked. Locking (not the display name) is the permanent record of
 * whether this has already happened — a fan renaming themselves back to the
 * literal string "Fan" must not re-arm regeneration, so the display name
 * itself can never be part of this gate. Once locked, the handle is a
 * permanent permalink and must never move again (see the comment in
 * update.ts).
 *
 * Returns the new handle if one was generated, or null if the handle is
 * already locked (caller should leave the handle alone).
 */
export async function regenerateHandleOnFirstName(
  db: D1Database, handleLocked: number, newName: string,
): Promise<string | null> {
  if (handleLocked) return null;
  return nextAvailableHandle(newName, async h => !!(await getProfileByHandle(db, h)));
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

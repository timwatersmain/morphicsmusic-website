// All D1 access for the community feature. Every function takes the database
// as its first argument so tests can inject a node:sqlite shim.

import { nextAvailableHandle, isValidDisplayName, isBlockedName } from './handle';
import type {
  AvatarCatalogueRow, FanProfileRow, PublicProfile, UnlockGrant,
} from './types';
import { nextStageThreshold, stageXp, type CreatureStage } from './ep';
import { assignSpriteRefs } from './sprites';

const now = () => Math.floor(Date.now() / 1000);

// A fan may change their handle, but not more than once every 30 days —
// keeps profile links reasonably stable and makes name-squatting expensive,
// without freezing anyone out of their own name forever (the old
// handle_locked model this replaces).
export const HANDLE_CHANGE_COOLDOWN_DAYS = 30;
const HANDLE_CHANGE_COOLDOWN_SECONDS = HANDLE_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60;

/**
 * Whether the fan may change their handle right now. `handleChangedAt` null
 * means "never changed" — always permitted. `now` is injected (unix
 * seconds) so this stays a pure function callers can test without faking
 * the system clock.
 */
export function canChangeHandle(handleChangedAt: number | null, now: number): boolean {
  if (handleChangedAt === null) return true;
  return now - handleChangedAt >= HANDLE_CHANGE_COOLDOWN_SECONDS;
}

/** Unix seconds at which the cooldown lifts. Only meaningful when canChangeHandle is false. */
export function nextHandleChangeAt(handleChangedAt: number): number {
  return handleChangedAt + HANDLE_CHANGE_COOLDOWN_SECONDS;
}

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
 * `displayName`/`username` are only used at creation — they never overwrite
 * a name or handle the fan has since chosen. Username and handle are
 * separate concepts, but the handle defaults to the username when one
 * exists (accounts created after username/password auth shipped); customers
 * who signed up before that existed (purchase-only, no username) fall back
 * to the display-name-derived behaviour this always had. Neither is ever
 * derived from the email, which must not leak into a fan-facing identifier.
 */
export async function ensureProfile(
  db: D1Database,
  opts: { email: string; fanSince: number; displayName?: string | null; username?: string | null },
): Promise<FanProfileRow> {
  const email = opts.email.toLowerCase().trim();
  const existing = await getProfileByEmail(db, email);
  if (existing) return existing;

  // Defence in depth: update.ts is the normal path that enforces
  // isBlockedName, but a seeded/imported displayName/username should never
  // be able to slip a reserved word (e.g. "admin") straight into a handle
  // either.
  const rawName = opts.username || opts.displayName || '';
  const name = (isValidDisplayName(rawName) && !isBlockedName(rawName)) ? rawName.trim() : 'Fan';
  // Route the username case through nextAvailableHandle too: slugifyHandle
  // collapses underscores to hyphens, so two DISTINCT usernames like
  // "foo_bar" and "foo-bar" slugify to the same root "foo-bar" — the second
  // account to arrive must get a suffixed handle instead of colliding.
  const handle = await nextAvailableHandle(name, async h => !!(await getProfileByHandle(db, h)));
  const t = now();

  // Sprite refs (one per stage) and colourway are fixed HERE, at creation —
  // never re-rolled, never assigned lazily on a "hatch" moment like the
  // retired species model. See sprites.ts's module doc comment.
  const sprites = await assignSpriteRefs(email);

  try {
    await db.prepare(
      `INSERT INTO fan_profiles
         (email, handle, display_name, fan_since, created_at, updated_at, last_seen_at,
          sprite_egg, sprite_grub, sprite_pupa, sprite_adult, colourway)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      email, handle, name, opts.fanSince, t, t, t,
      sprites.sprite_egg, sprites.sprite_grub, sprites.sprite_pupa, sprites.sprite_adult, sprites.colourway,
    ).run();
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

export async function getAvatarById(db: D1Database, id: string): Promise<AvatarCatalogueRow | null> {
  return db.prepare('SELECT * FROM avatar_catalogue WHERE id = ?').bind(id).first<AvatarCatalogueRow>();
}

/**
 * Revoke a single grant (admin-only tiers 3-4). No-op if the fan never held
 * it. Does not touch `equipped_avatar_id` — a fan wearing a revoked avatar
 * falls back to the default render on next profile read, same as any other
 * avatar deleted out from under them (see the ON DELETE SET NULL fk).
 */
export async function revokeUnlock(db: D1Database, fanId: number, avatarId: string): Promise<void> {
  await db.prepare('DELETE FROM fan_avatar_unlocks WHERE fan_id = ? AND avatar_id = ?')
    .bind(fanId, avatarId).run();
  // A fan wearing the avatar being revoked must not keep displaying
  // something they no longer hold — the fk's ON DELETE SET NULL only fires
  // when the catalogue row itself is deleted, not when just the ledger
  // entry is, so that has to be handled explicitly here.
  await db.prepare(
    'UPDATE fan_profiles SET equipped_avatar_id = NULL WHERE id = ? AND equipped_avatar_id = ?',
  ).bind(fanId, avatarId).run();
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
  fields: { displayName?: string; equippedAvatarId?: string | null },
  handle: string | undefined,
  t: number,
): { sets: string[]; args: unknown[] } {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.displayName !== undefined) { sets.push('display_name = ?'); args.push(fields.displayName); }
  if (fields.equippedAvatarId !== undefined) { sets.push('equipped_avatar_id = ?'); args.push(fields.equippedAvatarId); }
  if (handle !== undefined) {
    sets.push('handle = ?'); args.push(handle);
    // Every write of the handle column — deliberate or the collision-retry
    // below — stamps the cooldown clock. update.ts is the one place that
    // decides WHETHER a handle write is allowed to happen at all (via
    // canChangeHandle); once it decides to call this, the write always
    // counts.
    sets.push('handle_changed_at = ?'); args.push(t);
  }
  return { sets, args };
}

async function runProfileUpdate(
  db: D1Database, fanId: number, built: { sets: string[]; args: unknown[] }, t: number,
): Promise<void> {
  if (!built.sets.length) return;
  const args = [...built.args, t, fanId];
  await db.prepare(`UPDATE fan_profiles SET ${built.sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...args).run();
}

export async function updateProfile(
  db: D1Database,
  fanId: number,
  fields: { displayName?: string; equippedAvatarId?: string | null; handle?: string },
): Promise<void> {
  const t = now();
  if (fields.handle === undefined) {
    await runProfileUpdate(db, fanId, buildProfileSets(fields, undefined, t), t);
    return;
  }

  try {
    await runProfileUpdate(db, fanId, buildProfileSets(fields, fields.handle, t), t);
    return;
  } catch (err) {
    // A concurrent change landed on the same candidate handle first —
    // idx_fan_profiles_handle throws rather than failing silently, same
    // shape as ensureProfile's insert race. Re-derive a fresh candidate off
    // the same base name and retry exactly once.
    const retryBase = fields.displayName ?? fields.handle;
    const retryHandle = await nextAvailableHandle(
      retryBase, async h => !!(await getProfileByHandle(db, h)),
    );
    try {
      await runProfileUpdate(db, fanId, buildProfileSets(fields, retryHandle, t), t);
      return;
    } catch {
      // Still colliding. A fan renaming themselves must never get a 500 over
      // a handle collision — keep the existing handle and persist everything
      // else instead.
      await runProfileUpdate(db, fanId, buildProfileSets(fields, undefined, t), t);
    }
  }
}

export async function setCollectionCount(db: D1Database, fanId: number, count: number): Promise<void> {
  await db.prepare('UPDATE fan_profiles SET collection_count = ?, updated_at = ? WHERE id = ?')
    .bind(count, now(), fanId).run();
}

/**
 * Persist a fan's creature stage progress — see evaluateCreature in
 * creature.ts, which computes what to write. Called on every profile read
 * (idempotent: writing the same stage twice is harmless), which is what
 * makes visiting your own profile the trigger for advancing. `hatchedAt` is
 * passed through unchanged by every caller once set — see me.ts.
 */
export async function saveCreatureProgress(
  db: D1Database,
  fanId: number,
  update: { ep: number; stage: string; hatchedAt: number | null },
): Promise<void> {
  await db.prepare(
    'UPDATE fan_profiles SET ep = ?, stage = ?, hatched_at = ?, updated_at = ? WHERE id = ?',
  ).bind(update.ep, update.stage, update.hatchedAt, now(), fanId).run();
}

/**
 * A fan's own choice — sprite refs are fate (fixed at creation, see
 * ensureProfile), colourway is the one thing they pick. update.ts is
 * responsible for validating `colourway` is one of the 12 real ids
 * (sprites.ts's isValidColourway) before this is ever called.
 */
export async function setCreatureColourway(db: D1Database, fanId: number, colourway: string): Promise<void> {
  await db.prepare('UPDATE fan_profiles SET colourway = ?, updated_at = ? WHERE id = ?')
    .bind(colourway, now(), fanId).run();
}

/**
 * Backfill sprite refs + colourway for a fan whose profile predates
 * migration 0007 (sprite_egg etc. are NULL). No-op for anyone assigned
 * already — this must never re-roll an existing assignment. Deliberately
 * NOT called from directory.ts or profile.ts (see their subrequest budget
 * comments); only me.ts's self-view calls this, since that keeps the write
 * cost to "once, ever, per legacy fan, on their own visit" rather than a
 * write fanning out across every row a directory/profile read touches.
 */
export async function ensureSpriteAssignment(db: D1Database, profile: FanProfileRow): Promise<FanProfileRow> {
  if (profile.sprite_egg) return profile;
  const sprites = await assignSpriteRefs(profile.email);
  await db.prepare(
    `UPDATE fan_profiles
       SET sprite_egg = ?, sprite_grub = ?, sprite_pupa = ?, sprite_adult = ?, colourway = ?, updated_at = ?
       WHERE id = ? AND sprite_egg IS NULL`,
  ).bind(
    sprites.sprite_egg, sprites.sprite_grub, sprites.sprite_pupa, sprites.sprite_adult, sprites.colourway,
    now(), profile.id,
  ).run();
  return { ...profile, ...sprites };
}

/**
 * The ONLY shape that may be sent to a client. Constructed by explicit
 * allow-list rather than by deleting fields, so a column added to
 * fan_profiles OR avatar_catalogue later cannot leak by default.
 *
 * `glyph` is the caller's job to derive (see glyphLetterForEmail in
 * glyph.ts) and pass in — this function stays pure/sync and never touches
 * KV itself. It is always required, even when `avatar` is null, so callers
 * can't accidentally skip deriving it and ship a stale/wrong letter.
 */
/** Which of the four per-stage columns holds the fan's current-stage sprite ref. */
function currentSpriteRef(row: FanProfileRow, stage: CreatureStage): string | null {
  switch (stage) {
    case 'egg': return row.sprite_egg;
    case 'grub': return row.sprite_grub;
    case 'pupa': return row.sprite_pupa;
    case 'adult': return row.sprite_adult;
  }
}

export function toPublicProfile(
  row: FanProfileRow,
  avatar: AvatarCatalogueRow | null,
  glyph: string,
): PublicProfile {
  // row.stage is undefined (not just null) for any plain object built before
  // migration 0006 existed — e.g. hand-built rows in older tests — so `||`
  // rather than `??` deliberately treats both as "egg".
  const stage = (row.stage || 'egg') as CreatureStage;
  return {
    handle: row.handle,
    display_name: row.display_name,
    fan_since: row.fan_since,
    rank_points: row.rank_points,
    collection_count: row.collection_count,
    avatar: avatar ? {
      id: avatar.id,
      name: avatar.name,
      art_path: avatar.art_path,
      // Tier-ladder recipe fields — see PublicAvatar's doc comment.
      // Necessary for tiers 1/2/4 to render for anyone but the signed-in
      // viewer looking at their own avatar; null on plain release/special
      // rows, which fall back to art_path exactly as before.
      style: avatar.style,
      colourway: avatar.colourway,
      artwork_key: avatar.artwork_key,
      tier: avatar.tier,
      glyph,
    } : null,
    creature: {
      stage,
      sprite_ref: currentSpriteRef(row, stage),
      colourway: row.colourway || null,
      ep: row.ep || 0,
      stage_xp: stageXp(row.ep || 0, stage),
      next_stage_ep: nextStageThreshold(stage),
    },
  };
}

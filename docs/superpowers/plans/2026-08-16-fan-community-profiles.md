# Fan Community & Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/library`'s download list into a fan identity with standing — a Community tab holding profiles, a fan directory and a leaderboard, where unlockable avatars earned from releases and behaviour drive fans to come back and to buy.

**Architecture:** Profile data lives in Cloudflare D1 (alongside the download-gate tables); purchases, sessions and identity stay in Cloudflare KV untouched. D1 holds two kinds of field — *derived* (regenerable from KV) and *fan-owned* (never derived). A pure, idempotent unlock engine grants avatars; running it the first time backfills every existing customer. Astro is static, so every Community page is a prerendered shell that fetches its data client-side from Pages Functions, exactly as `src/pages/library.astro` does today.

**Tech Stack:** Astro 6 (static), Cloudflare Pages Functions (TypeScript), Cloudflare D1 (SQLite), Cloudflare KV, Tailwind 4 (CSS-first `@theme`), Vitest 3, `node:sqlite` for schema tests.

**Spec:** `docs/superpowers/specs/2026-08-16-fan-community-profiles-design.md`

**Branch:** `feat/fan-community`

## Global Constraints

- **Zero new runtime dependencies.** Everything uses `fetch`, Web Crypto, and `node:sqlite` (Node built-in, test-only). If you think you need a package, stop and ask.
- **Never touch the money path.** `functions/api/checkout.ts`, `functions/api/stripe-webhook.ts`, `functions/api/order.ts` and `functions/api/download.ts` are off-limits. `/library` stays exactly as it is.
- **Email is never exposed** in any API response, page, or client-side payload. The `handle` is the only fan-facing identifier.
- **Never expose prices paid, purchase dates, or order history** to anyone but the owning fan.
- **All `/community` routes require a valid session and must be `noindex`.**
- **Migrations are reversible and purely additive.** Never drop or alter an existing column.
- **Tailwind tokens come from `src/styles/global.css` (`@theme`), not `tailwind.config.mjs`.** With Tailwind 4 + `@tailwindcss/vite` the CSS block is authoritative; the JS config is stale and its values have already drifted (e.g. `secondary-fixed` is `#a8f0c8` in CSS, `#ffdea8` in the JS config). Use the CSS values.
- **Border radius is `0` sitewide** except explicit `rounded-full`. Square corners are a brand rule.
- **Run D1 commands via the tooling config**, never a root `wrangler.toml`: `--config tools/d1/wrangler.toml`. A root config carrying `pages_build_output_dir` would override the dashboard-configured `DOWNLOADS`/`MASTERS` bindings and take the store down.
- **Test command:** `npm test` (Vitest). Migration/schema tests run against real SQL via `node:sqlite` — no Cloudflare account needed.

## Prerequisites

This branch depends on the D1 tooling added on `feat/download-gate` (`tools/d1/wrangler.toml`, `migrations/`, the `d1:*` npm scripts, and the `.test.ts` vitest include). Before Task 1:

```bash
git merge feat/download-gate    # or rebase this branch onto it
npm test                        # expect 110 passing
```

If that merge is undesirable, Task 1 must first re-create `tools/d1/wrangler.toml`, the `d1:*` scripts in `package.json`, and add `'tests/**/*.test.ts'` to `vitest.config.js`.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `migrations/0002_fan_profiles.sql` | The three community tables |
| `migrations/down/0002_fan_profiles.down.sql` | Rollback |
| `functions/_lib/community/types.ts` | Row types + unlock-rule vocabulary |
| `functions/_lib/community/handle.ts` | Handle slugify, validation, blocklist |
| `functions/_lib/community/unlocks.ts` | Pure unlock engine |
| `functions/_lib/community/repo.ts` | All D1 access for community |
| `functions/_lib/community/session.ts` | Shared "who is this fan" guard |
| `functions/api/community/me.ts` | Own profile: read, create, backfill unlocks |
| `functions/api/community/update.ts` | Change display name / equipped avatar |
| `functions/api/community/profile.ts` | Another fan's public-facing profile |
| `functions/api/community/directory.ts` | Directory + leaderboard + rarity |
| `src/pages/community/index.astro` | Directory + leaderboard shell |
| `src/pages/community/me.astro` | Own profile shell |
| `src/pages/community/profile.astro` | Other-fan shell (rewrite target) |
| `src/components/AvatarMedallion.astro` | Circular framed avatar |
| `scripts/sync-avatar-catalogue.mjs` | Releases → `avatar_catalogue` rows |
| `tools/d1/seed-special-avatars.sql` | Hand-authored special avatars |
| `tests/community/*.test.js` | Schema, handle, unlock-engine tests |

**Modified:** `src/components/TopNav.astro`, `src/components/BottomNav.astro`, `public/_headers`, `public/_redirects`, `package.json`.

---

### Task 1: Community schema

**Files:**
- Create: `migrations/0002_fan_profiles.sql`
- Create: `migrations/down/0002_fan_profiles.down.sql`
- Test: `tests/community/schema.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `fan_profiles`, `avatar_catalogue`, `fan_avatar_unlocks`. Column names are relied on by every later task.

- [ ] **Step 1: Write the failing test**

Create `tests/community/schema.test.js`. This mirrors the structure of `tests/gate/schema.test.js` — read that file first for the `node:sqlite` pattern.

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');
const DOWN = readFileSync(join(root, 'migrations/down/0002_fan_profiles.down.sql'), 'utf8');
const TABLES = ['fan_profiles', 'avatar_catalogue', 'fan_avatar_unlocks'];

const STUB = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT);
  INSERT INTO d1_migrations (name, applied_at) VALUES ('0002_fan_profiles.sql','now');`;

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(STUB);
  db.exec(UP);
  return db;
}
function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
}
function addAvatar(db, id, kind = 'release', slug = 'perception') {
  db.prepare(`INSERT INTO avatar_catalogue (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order)
    VALUES (?, ?, ?, 'N', '/a.webp', '{"type":"own_release","slug":"perception"}', 'Own it', 0)`)
    .run(id, kind, slug);
}
function addFan(db, email = 'a@b.com', handle = 'ana') {
  db.prepare(`INSERT INTO fan_profiles (email, handle, display_name, fan_since, created_at, updated_at)
    VALUES (?, ?, 'Ana', 0, 0, 0)`).run(email, handle);
  return db.prepare('SELECT id FROM fan_profiles WHERE email = ?').get(email).id;
}

describe('migration 0002', () => {
  it('creates every community table', () => {
    const t = tables(makeDb());
    for (const name of TABLES) expect(t).toContain(name);
  });

  it('is reversible', () => {
    const db = makeDb();
    db.exec(DOWN);
    const t = tables(db);
    for (const name of TABLES) expect(t).not.toContain(name);
  });

  it('down clears bookkeeping so up can re-run', () => {
    const db = makeDb();
    db.exec(DOWN);
    expect(db.prepare('SELECT name FROM d1_migrations').all()).toHaveLength(0);
    expect(() => db.exec(UP)).not.toThrow();
  });
});

describe('fan_profiles integrity', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  it('enforces one profile per email', () => {
    addFan(db, 'a@b.com', 'ana');
    expect(() => addFan(db, 'a@b.com', 'other')).toThrow(/UNIQUE constraint/i);
  });

  it('enforces unique handles', () => {
    addFan(db, 'a@b.com', 'ana');
    expect(() => addFan(db, 'c@d.com', 'ana')).toThrow(/UNIQUE constraint/i);
  });

  it('defaults rank_points and collection_count to 0', () => {
    addFan(db);
    const row = db.prepare('SELECT * FROM fan_profiles').get();
    expect(row.rank_points).toBe(0);
    expect(row.collection_count).toBe(0);
    expect(row.equipped_avatar_id).toBeNull();
  });
});

describe('avatar unlocks', () => {
  let db, fanId;
  beforeEach(() => { db = makeDb(); fanId = addFan(db); addAvatar(db, 'release:perception'); });

  const grant = (f, a) => db.prepare(
    `INSERT INTO fan_avatar_unlocks (fan_id, avatar_id, unlocked_at, source)
     VALUES (?, ?, 0, 'own_release')`).run(f, a);

  it('grants an avatar once', () => {
    expect(() => grant(fanId, 'release:perception')).not.toThrow();
  });

  it('refuses a duplicate grant — the ledger is idempotent', () => {
    grant(fanId, 'release:perception');
    expect(() => grant(fanId, 'release:perception')).toThrow(/UNIQUE constraint/i);
  });

  it('rejects an unlock for an avatar that does not exist', () => {
    expect(() => grant(fanId, 'release:nope')).toThrow(/FOREIGN KEY/i);
  });

  it('cascades unlocks when a fan is deleted', () => {
    grant(fanId, 'release:perception');
    db.prepare('DELETE FROM fan_profiles WHERE id = ?').run(fanId);
    expect(db.prepare('SELECT COUNT(*) c FROM fan_avatar_unlocks').get().c).toBe(0);
  });

  it('constrains avatar kind', () => {
    expect(() => addAvatar(db, 'x', 'nonsense', null)).toThrow(/CHECK constraint/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/community/schema.test.js`
Expected: FAIL — `ENOENT: no such file or directory ... migrations/0002_fan_profiles.sql`

- [ ] **Step 3: Write the migration**

Create `migrations/0002_fan_profiles.sql`:

```sql
-- 0002_fan_profiles.sql
-- Fan profiles, the avatar catalogue, and the unlock ledger.
--
-- Purely additive. The store's purchase data lives in KV and is untouched.
-- Rollback: migrations/down/0002_fan_profiles.down.sql
--
-- Two kinds of column live here, and the difference matters:
--   derived    — regenerable from KV (fan_since, collection_count) and from
--                the ledger. A rebuild script can recompute all of it.
--   fan-owned  — exists only here (handle, display_name, equipped_avatar_id).
--                Never derived, never overwritten by a rebuild.
-- Times are unix epoch seconds, matching the KV records.

CREATE TABLE fan_profiles (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The link to the KV customer record (`customer:<email>`). Never exposed
  -- to any client; `handle` is the only fan-facing identifier.
  email              TEXT    NOT NULL,
  handle             TEXT    NOT NULL,
  display_name       TEXT    NOT NULL,
  equipped_avatar_id TEXT    REFERENCES avatar_catalogue (id) ON DELETE SET NULL,
  fan_since          INTEGER NOT NULL,
  rank_points        INTEGER NOT NULL DEFAULT 0,
  collection_count   INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_seen_at       INTEGER
);

CREATE UNIQUE INDEX idx_fan_profiles_email ON fan_profiles (email);
CREATE UNIQUE INDEX idx_fan_profiles_handle ON fan_profiles (handle);
CREATE INDEX idx_fan_profiles_board ON fan_profiles (rank_points, fan_since);

-- Avatar ids are stable TEXT keys, not autoincrement integers: `release:<slug>`
-- and `special:<name>`. The sync script is re-runnable, and a stable id means
-- re-running it can never re-issue or orphan somebody's unlock.
CREATE TABLE avatar_catalogue (
  id             TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('release', 'special')),
  release_slug   TEXT,
  name           TEXT    NOT NULL,
  art_path       TEXT    NOT NULL,
  -- JSON: {"type":"own_release","slug":"..."} | {"type":"tenure_days","days":N}
  --     | {"type":"free_song_streak","weeks":N} | {"type":"show_attended","showId":"..."}
  --     | {"type":"gate_completed","gateSlug":"..."}
  unlock_rule    TEXT    NOT NULL,
  -- Shown to fans who do not have it yet. This is the teaser, so it must
  -- always be populated.
  hint           TEXT    NOT NULL,
  available_from  INTEGER,
  available_until INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_avatar_catalogue_kind ON avatar_catalogue (kind, sort_order);

CREATE TABLE fan_avatar_unlocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fan_id      INTEGER NOT NULL REFERENCES fan_profiles (id) ON DELETE CASCADE,
  avatar_id   TEXT    NOT NULL REFERENCES avatar_catalogue (id) ON DELETE CASCADE,
  unlocked_at INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  source_ref  TEXT,
  UNIQUE (fan_id, avatar_id)
);

-- Rarity: COUNT(*) GROUP BY avatar_id, so avatar_id leads.
CREATE INDEX idx_unlocks_avatar ON fan_avatar_unlocks (avatar_id);
CREATE INDEX idx_unlocks_fan ON fan_avatar_unlocks (fan_id);
```

Create `migrations/down/0002_fan_profiles.down.sql`:

```sql
-- Rollback for 0002_fan_profiles.sql
-- wrangler d1 migrations only runs forward, so apply this by hand:
--   npm run d1:rollback:community:local
-- WARNING on remote: destroys every fan's handle, display name and unlock
-- ledger. Derived fields are regenerable; fan-owned ones are not.
DROP TABLE IF EXISTS fan_avatar_unlocks;
DROP TABLE IF EXISTS fan_profiles;
DROP TABLE IF EXISTS avatar_catalogue;
DELETE FROM d1_migrations WHERE name = '0002_fan_profiles.sql';
```

Note the drop order: `fan_profiles` references `avatar_catalogue`, and `fan_avatar_unlocks` references both, so unlocks go first and the catalogue last.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/community/schema.test.js`
Expected: PASS (13 tests)

- [ ] **Step 5: Add rollback scripts and apply locally**

Add to `package.json` scripts:

```json
"d1:rollback:community:local": "npx --yes wrangler d1 execute GATES --config tools/d1/wrangler.toml --local --file=migrations/down/0002_fan_profiles.down.sql",
"d1:rollback:community": "npx --yes wrangler d1 execute GATES --config tools/d1/wrangler.toml --remote --file=migrations/down/0002_fan_profiles.down.sql"
```

Run: `npm run d1:migrate:local`
Expected: `0002_fan_profiles.sql ✅`

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_fan_profiles.sql migrations/down/0002_fan_profiles.down.sql tests/community/schema.test.js package.json
git commit -m "feat(community): fan profile, avatar catalogue and unlock ledger schema"
```

---

### Task 2: Handle generation and validation

**Files:**
- Create: `functions/_lib/community/handle.ts`
- Test: `tests/community/handle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `slugifyHandle(input: string): string`
  - `isValidDisplayName(name: string): boolean`
  - `isBlockedName(name: string): boolean`
  - `nextAvailableHandle(base: string, taken: (h: string) => Promise<boolean>): Promise<string>`

Answers open question §10.1 from the spec: the handle is **derived from the display name**, with a numeric suffix on collision.

- [ ] **Step 1: Write the failing test**

Create `tests/community/handle.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  slugifyHandle, isValidDisplayName, isBlockedName, nextAvailableHandle,
} from '../../functions/_lib/community/handle';

describe('slugifyHandle', () => {
  it.each([
    ['Ana Vex', 'ana-vex'],
    ['  Spaced  Out  ', 'spaced-out'],
    ['MORPHICS', 'morphics'],
    ['Ünïcodé Näme', 'unicode-name'],
    ['emoji 🎧 fan', 'emoji-fan'],
    ['a---b', 'a-b'],
    ['-leading-and-trailing-', 'leading-and-trailing'],
  ])('slugifies %s to %s', (input, expected) => {
    expect(slugifyHandle(input)).toBe(expected);
  });

  it('falls back when nothing survives slugification', () => {
    expect(slugifyHandle('🎧🎧🎧')).toBe('fan');
  });

  it('caps length at 32 characters', () => {
    expect(slugifyHandle('x'.repeat(80)).length).toBe(32);
  });
});

describe('isValidDisplayName', () => {
  it.each(['Ana', 'Ana Vex', 'DJ 3000'])('accepts %s', n =>
    expect(isValidDisplayName(n)).toBe(true));
  it.each(['', ' ', 'a', 'x'.repeat(41)])('rejects %s', n =>
    expect(isValidDisplayName(n)).toBe(false));
  it('rejects control characters', () => {
    expect(isValidDisplayName('bad\u0000name')).toBe(false);
  });
});

describe('isBlockedName', () => {
  it.each(['admin', 'Admin', 'ADMIN', 'morphics', 'moderator', 'support'])(
    'blocks impersonation: %s', n => expect(isBlockedName(n)).toBe(true));
  it('blocks reserved route words so handles cannot shadow pages', () => {
    expect(isBlockedName('me')).toBe(true);
    expect(isBlockedName('u')).toBe(true);
  });
  it('allows an ordinary name', () => {
    expect(isBlockedName('Ana Vex')).toBe(false);
  });
});

describe('nextAvailableHandle', () => {
  it('returns the base when free', async () => {
    expect(await nextAvailableHandle('ana', async () => false)).toBe('ana');
  });
  it('suffixes on collision', async () => {
    const taken = new Set(['ana', 'ana-2']);
    expect(await nextAvailableHandle('ana', async h => taken.has(h))).toBe('ana-3');
  });
  it('gives up after 50 attempts and appends a random suffix', async () => {
    const h = await nextAvailableHandle('ana', async () => true);
    expect(h).toMatch(/^ana-[a-z0-9]{6}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/community/handle.test.ts`
Expected: FAIL — cannot resolve `functions/_lib/community/handle`

- [ ] **Step 3: Write the implementation**

Create `functions/_lib/community/handle.ts`:

```typescript
// Handles are derived from the display name and are the ONLY fan-facing
// identifier — email never leaves the server.

const MAX_HANDLE = 32;
const MIN_NAME = 2;
const MAX_NAME = 40;

// Names that would let someone impersonate the artist or staff, plus every
// path segment used under /community so a handle can never shadow a real
// route. Add to this list rather than inventing a second check elsewhere.
const BLOCKED = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'support', 'staff', 'official',
  'morphics', 'morphicsmusic', 'root', 'system', 'null', 'undefined',
  'me', 'u', 'community', 'login', 'library', 'store', 'music', 'visuals',
  'social', 'download', 'api', 'unlock',
]);

export function slugifyHandle(input: string): string {
  const slug = (input || '')
    .normalize('NFKD')                    // decompose accents into base + mark
    .replace(/[\u0300-\u036f]/g, '')      // strip the combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')       // everything else becomes a separator
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_HANDLE)
    .replace(/-$/, '');                // slicing may have left a trailing dash
  return slug || 'fan';
}

export function isValidDisplayName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME || trimmed.length > MAX_NAME) return false;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  return true;
}

export function isBlockedName(name: string): boolean {
  return BLOCKED.has(slugifyHandle(name));
}

/**
 * First free handle for `base`. `taken` is injected so this stays a pure
 * function over an async predicate and can be tested without a database.
 */
export async function nextAvailableHandle(
  base: string,
  taken: (handle: string) => Promise<boolean>,
): Promise<string> {
  const root = slugifyHandle(base);
  if (!(await taken(root))) return root;
  for (let n = 2; n <= 50; n++) {
    const candidate = `${root}-${n}`.slice(0, MAX_HANDLE);
    if (!(await taken(candidate))) return candidate;
  }
  // Pathological contention. A random suffix ends the loop rather than
  // spinning; collision odds at this point are negligible.
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map(b => b.toString(36))
    .join('')
    .slice(0, 6);
  return `${root}-${rand}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/community/handle.test.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add functions/_lib/community/handle.ts tests/community/handle.test.ts
git commit -m "feat(community): handle slugification, validation and collision suffixes"
```

---

### Task 3: The unlock engine

**Files:**
- Create: `functions/_lib/community/types.ts`
- Create: `functions/_lib/community/unlocks.ts`
- Test: `tests/community/unlocks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `evaluateUnlocks(ctx: UnlockContext, catalogue: AvatarCatalogueRow[]): UnlockGrant[]`
  - types `UnlockContext`, `UnlockGrant`, `AvatarCatalogueRow`, `FanProfileRow`, `UnlockRule`

This is the heart of the feature and it is deliberately pure — no D1, no KV, no fetch. Task 5 wires it to storage.

- [ ] **Step 1: Write the failing test**

Create `tests/community/unlocks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { evaluateUnlocks } from '../../functions/_lib/community/unlocks';
import type { AvatarCatalogueRow, UnlockContext } from '../../functions/_lib/community/types';

const DAY = 86400;
const NOW = 1_800_000_000;

function avatar(id: string, rule: object, over: Partial<AvatarCatalogueRow> = {}): AvatarCatalogueRow {
  return {
    id, kind: id.startsWith('release:') ? 'release' : 'special',
    release_slug: null, name: id, art_path: '/a.webp',
    unlock_rule: JSON.stringify(rule), hint: 'hint',
    available_from: null, available_until: null, sort_order: 0, ...over,
  };
}

function ctx(over: Partial<UnlockContext> = {}): UnlockContext {
  return {
    ownedSlugs: [], fanSince: NOW, now: NOW,
    streakWeeks: 0, showsAttended: [], gatesCompleted: [], ...over,
  };
}

describe('release ownership', () => {
  const cat = [avatar('release:perception', { type: 'own_release', slug: 'perception' })];

  it('grants when the release is owned', () => {
    const g = evaluateUnlocks(ctx({ ownedSlugs: ['perception'] }), cat);
    expect(g.map(x => x.avatarId)).toEqual(['release:perception']);
    expect(g[0].source).toBe('own_release');
    expect(g[0].sourceRef).toBe('perception');
  });

  it('does not grant when unowned', () => {
    expect(evaluateUnlocks(ctx({ ownedSlugs: ['other'] }), cat)).toEqual([]);
  });
});

describe('tenure', () => {
  const cat = [avatar('special:year-one', { type: 'tenure_days', days: 365 })];

  it('grants once the fan is old enough', () => {
    expect(evaluateUnlocks(ctx({ fanSince: NOW - 400 * DAY }), cat)).toHaveLength(1);
  });
  it('withholds before the milestone', () => {
    expect(evaluateUnlocks(ctx({ fanSince: NOW - 100 * DAY }), cat)).toHaveLength(0);
  });
  it('grants exactly on the boundary', () => {
    expect(evaluateUnlocks(ctx({ fanSince: NOW - 365 * DAY }), cat)).toHaveLength(1);
  });
});

describe('streaks, shows and gates', () => {
  it('grants a streak avatar at or above the threshold', () => {
    const cat = [avatar('special:streak-4', { type: 'free_song_streak', weeks: 4 })];
    expect(evaluateUnlocks(ctx({ streakWeeks: 4 }), cat)).toHaveLength(1);
    expect(evaluateUnlocks(ctx({ streakWeeks: 3 }), cat)).toHaveLength(0);
  });

  it('grants a show avatar only for that show', () => {
    const cat = [avatar('special:show-2026', { type: 'show_attended', showId: 'ldn-2026' })];
    expect(evaluateUnlocks(ctx({ showsAttended: ['ldn-2026'] }), cat)).toHaveLength(1);
    expect(evaluateUnlocks(ctx({ showsAttended: ['other'] }), cat)).toHaveLength(0);
  });

  it('grants a gate avatar on completion', () => {
    const cat = [avatar('special:acid', { type: 'gate_completed', gateSlug: 'acid-pack' })];
    expect(evaluateUnlocks(ctx({ gatesCompleted: ['acid-pack'] }), cat)).toHaveLength(1);
  });
});

describe('availability windows', () => {
  const rule = { type: 'tenure_days', days: 0 };

  it('withholds before available_from', () => {
    const cat = [avatar('special:soon', rule, { available_from: NOW + DAY })];
    expect(evaluateUnlocks(ctx(), cat)).toHaveLength(0);
  });
  it('withholds after available_until — time-limited avatars stay unrepeatable', () => {
    const cat = [avatar('special:gone', rule, { available_until: NOW - DAY })];
    expect(evaluateUnlocks(ctx(), cat)).toHaveLength(0);
  });
  it('grants inside the window', () => {
    const cat = [avatar('special:live', rule, { available_from: NOW - DAY, available_until: NOW + DAY })];
    expect(evaluateUnlocks(ctx(), cat)).toHaveLength(1);
  });
});

describe('robustness', () => {
  it('ignores an unknown rule type rather than throwing', () => {
    expect(evaluateUnlocks(ctx(), [avatar('special:x', { type: 'telepathy' })])).toEqual([]);
  });
  it('ignores malformed rule JSON rather than throwing', () => {
    const bad = { ...avatar('special:x', {}), unlock_rule: '{not json' };
    expect(() => evaluateUnlocks(ctx(), [bad])).not.toThrow();
    expect(evaluateUnlocks(ctx(), [bad])).toEqual([]);
  });
  it('evaluates a whole catalogue and returns only what qualifies', () => {
    const cat = [
      avatar('release:a', { type: 'own_release', slug: 'a' }),
      avatar('release:b', { type: 'own_release', slug: 'b' }),
      avatar('special:year-one', { type: 'tenure_days', days: 365 }),
    ];
    const g = evaluateUnlocks(ctx({ ownedSlugs: ['a'], fanSince: NOW - 400 * DAY }), cat);
    expect(g.map(x => x.avatarId).sort()).toEqual(['release:a', 'special:year-one']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/community/unlocks.test.ts`
Expected: FAIL — cannot resolve `functions/_lib/community/unlocks`

- [ ] **Step 3: Write the types**

Create `functions/_lib/community/types.ts`:

```typescript
export interface FanProfileRow {
  id: number;
  /** Server-side only. NEVER include this in a client response. */
  email: string;
  handle: string;
  display_name: string;
  equipped_avatar_id: string | null;
  fan_since: number;
  rank_points: number;
  collection_count: number;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

export interface AvatarCatalogueRow {
  id: string;
  kind: 'release' | 'special';
  release_slug: string | null;
  name: string;
  art_path: string;
  /** JSON-encoded UnlockRule. */
  unlock_rule: string;
  hint: string;
  available_from: number | null;
  available_until: number | null;
  sort_order: number;
}

export type UnlockRule =
  | { type: 'own_release'; slug: string }
  | { type: 'tenure_days'; days: number }
  | { type: 'free_song_streak'; weeks: number }
  | { type: 'show_attended'; showId: string }
  | { type: 'gate_completed'; gateSlug: string };

export interface UnlockContext {
  ownedSlugs: string[];
  fanSince: number;
  now: number;
  /** Consecutive weeks claiming the free song. 0 until that system ships. */
  streakWeeks: number;
  /** Show ids attended. Empty until attendance capture exists. */
  showsAttended: string[];
  /** Gate slugs completed. Empty until wired to the gate system. */
  gatesCompleted: string[];
}

export interface UnlockGrant {
  avatarId: string;
  source: UnlockRule['type'];
  sourceRef: string | null;
}

/** Shape returned to clients. Note the absence of `email`. */
export interface PublicProfile {
  handle: string;
  display_name: string;
  fan_since: number;
  rank_points: number;
  collection_count: number;
  avatar: { id: string; name: string; art_path: string } | null;
}
```

- [ ] **Step 4: Write the engine**

Create `functions/_lib/community/unlocks.ts`:

```typescript
// The unlock engine. Deliberately pure — no D1, no KV, no fetch — so it is
// fully testable and so the caller controls persistence.
//
// Idempotency lives in the caller: it inserts grants with ON CONFLICT DO
// NOTHING. That is what lets this run on every sign-in, and what makes the
// first run backfill every existing customer's collection rather than
// starting them at zero.

import type { AvatarCatalogueRow, UnlockContext, UnlockGrant, UnlockRule } from './types';

function parseRule(json: string): UnlockRule | null {
  try {
    const r = JSON.parse(json);
    return r && typeof r.type === 'string' ? (r as UnlockRule) : null;
  } catch {
    // A malformed rule must never take down a profile page. It simply never
    // grants, and the avatar stays locked.
    return null;
  }
}

function isAvailable(a: AvatarCatalogueRow, now: number): boolean {
  if (a.available_from !== null && now < a.available_from) return false;
  if (a.available_until !== null && now > a.available_until) return false;
  return true;
}

function qualifies(rule: UnlockRule, ctx: UnlockContext): string | null | false {
  switch (rule.type) {
    case 'own_release':
      return ctx.ownedSlugs.includes(rule.slug) ? rule.slug : false;
    case 'tenure_days':
      return (ctx.now - ctx.fanSince) / 86400 >= rule.days ? null : false;
    case 'free_song_streak':
      return ctx.streakWeeks >= rule.weeks ? String(rule.weeks) : false;
    case 'show_attended':
      return ctx.showsAttended.includes(rule.showId) ? rule.showId : false;
    case 'gate_completed':
      return ctx.gatesCompleted.includes(rule.gateSlug) ? rule.gateSlug : false;
    default:
      // Unknown rule type — forward-compatible with catalogue rows written by
      // a newer deploy. Never throws, never grants.
      return false;
  }
}

/** Every avatar the fan qualifies for right now. Order follows the catalogue. */
export function evaluateUnlocks(
  ctx: UnlockContext,
  catalogue: AvatarCatalogueRow[],
): UnlockGrant[] {
  const grants: UnlockGrant[] = [];
  for (const a of catalogue) {
    if (!isAvailable(a, ctx.now)) continue;
    const rule = parseRule(a.unlock_rule);
    if (!rule) continue;
    const result = qualifies(rule, ctx);
    if (result === false) continue;
    grants.push({ avatarId: a.id, source: rule.type, sourceRef: result });
  }
  return grants;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/community/unlocks.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 6: Commit**

```bash
git add functions/_lib/community/types.ts functions/_lib/community/unlocks.ts tests/community/unlocks.test.ts
git commit -m "feat(community): pure, idempotent avatar unlock engine"
```

---

### Task 4: Avatar catalogue sync

**Files:**
- Create: `scripts/sync-avatar-catalogue.mjs`
- Create: `tools/d1/seed-special-avatars.sql`
- Modify: `package.json`
- Test: `tests/community/catalogue-sync.test.js`

**Interfaces:**
- Consumes: `src/data/music-catalog.json`, migration 0002.
- Produces: `buildReleaseAvatars(catalog): AvatarRow[]` exported from the script for testing; `npm run sync:avatars` populates `avatar_catalogue`.

Read `scripts/upload-digital.mjs` first for this repo's script conventions (arg parsing, `npx wrangler`, dry-run flag).

- [ ] **Step 1: Write the failing test**

Create `tests/community/catalogue-sync.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { buildReleaseAvatars } from '../../scripts/sync-avatar-catalogue.mjs';

const catalog = {
  releases: [
    { slug: 'perception', title: 'PERCEPTION', artwork: '/images/albums/perception.jpg' },
    { slug: 'swamp-logic', title: 'SWAMP LOGIC', artwork: '/images/albums/swamp-logic.jpg' },
  ],
};

describe('buildReleaseAvatars', () => {
  it('makes one avatar per release', () => {
    expect(buildReleaseAvatars(catalog)).toHaveLength(2);
  });

  it('uses a stable id so re-running never re-issues an unlock', () => {
    expect(buildReleaseAvatars(catalog)[0].id).toBe('release:perception');
  });

  it('prefers the 400px webp variant over the source jpg', () => {
    expect(buildReleaseAvatars(catalog)[0].art_path).toBe('/images/albums/perception-400.webp');
  });

  it('encodes an ownership rule naming the release', () => {
    expect(JSON.parse(buildReleaseAvatars(catalog)[0].unlock_rule))
      .toEqual({ type: 'own_release', slug: 'perception' });
  });

  it('writes a hint that tells a locked fan how to earn it', () => {
    expect(buildReleaseAvatars(catalog)[0].hint).toBe('Own PERCEPTION');
  });

  it('skips a release with no artwork rather than emitting a broken avatar', () => {
    const out = buildReleaseAvatars({ releases: [{ slug: 'x', title: 'X', artwork: null }] });
    expect(out).toEqual([]);
  });

  it('is deterministic — same input, same output', () => {
    expect(buildReleaseAvatars(catalog)).toEqual(buildReleaseAvatars(catalog));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/community/catalogue-sync.test.js`
Expected: FAIL — cannot find `scripts/sync-avatar-catalogue.mjs`

- [ ] **Step 3: Write the sync script**

Create `scripts/sync-avatar-catalogue.mjs`:

```javascript
/**
 * sync-avatar-catalogue.mjs
 *
 * Generates one avatar per release from src/data/music-catalog.json and
 * upserts it into the D1 avatar_catalogue table. Every future release gets
 * its avatar for free — there is no per-avatar design work.
 *
 * Ids are stable (`release:<slug>`), so re-running is safe: an upsert can
 * never orphan or re-issue somebody's existing unlock.
 *
 *   node scripts/sync-avatar-catalogue.mjs --local
 *   node scripts/sync-avatar-catalogue.mjs --remote
 *   node scripts/sync-avatar-catalogue.mjs --dry-run
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

/** SQL string literal — doubles single quotes. Titles may contain apostrophes. */
function q(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * One avatar row per release. Exported for tests.
 * Prefers the 400px webp variant generated by scripts/generate-image-variants.mjs
 * — the medallion renders small, so shipping the full jpg would be wasteful.
 */
export function buildReleaseAvatars(catalog) {
  const rows = [];
  const releases = (catalog && catalog.releases) || [];
  releases.forEach((r, i) => {
    if (!r.slug || !r.artwork) return; // no art means no avatar
    const art = r.artwork.replace(/\.(jpg|jpeg|png)$/i, '-400.webp');
    rows.push({
      id: `release:${r.slug}`,
      kind: 'release',
      release_slug: r.slug,
      name: r.title || r.slug,
      art_path: art,
      unlock_rule: JSON.stringify({ type: 'own_release', slug: r.slug }),
      hint: `Own ${r.title || r.slug}`,
      available_from: null,
      available_until: null,
      sort_order: i,
    });
  });
  return rows;
}

function toUpsertSql(rows) {
  return rows.map(r => `INSERT INTO avatar_catalogue
  (id, kind, release_slug, name, art_path, unlock_rule, hint, available_from, available_until, sort_order)
VALUES (${q(r.id)}, ${q(r.kind)}, ${q(r.release_slug)}, ${q(r.name)}, ${q(r.art_path)},
        ${q(r.unlock_rule)}, ${q(r.hint)}, ${r.available_from ?? 'NULL'},
        ${r.available_until ?? 'NULL'}, ${r.sort_order})
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name, art_path = excluded.art_path,
  unlock_rule = excluded.unlock_rule, hint = excluded.hint,
  sort_order = excluded.sort_order;`).join('\n');
}

// Only run the CLI half when invoked directly, so importing for tests is free.
if (process.argv[1] && process.argv[1].endsWith('sync-avatar-catalogue.mjs')) {
  const catalog = JSON.parse(readFileSync(join(process.cwd(), 'src/data/music-catalog.json'), 'utf8'));
  const rows = buildReleaseAvatars(catalog);
  console.log(`${rows.length} release avatars from ${catalog.releases.length} releases`);

  if (args['dry-run']) {
    rows.forEach(r => console.log(`  ${r.id.padEnd(28)} ${r.art_path}`));
    process.exit(0);
  }

  const target = args.remote ? '--remote' : '--local';
  const tmp = join(process.cwd(), '.avatar-sync.sql');
  writeFileSync(tmp, toUpsertSql(rows));
  try {
    execSync(
      `npx --yes wrangler d1 execute GATES --config tools/d1/wrangler.toml ${target} --file=${tmp}`,
      { stdio: 'inherit' },
    );
    console.log(`Synced ${rows.length} avatars (${target}).`);
  } finally {
    unlinkSync(tmp);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/community/catalogue-sync.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Seed the special avatars**

Create `tools/d1/seed-special-avatars.sql`. These are the teasers — they render locked in v1 and cannot be earned until their source systems ship. `art_path` files must exist before this ships; create simple on-brand placeholder webps at those paths if the artwork is not ready.

```sql
-- Special avatars: the classes that release ownership cannot express.
-- Idempotent — safe to re-run.
INSERT INTO avatar_catalogue
  (id, kind, release_slug, name, art_path, unlock_rule, hint, available_from, available_until, sort_order)
VALUES
  ('special:tenure-90', 'special', NULL, 'Early Signal', '/images/avatars/tenure-90.webp',
   '{"type":"tenure_days","days":90}', 'Be a fan for 3 months', NULL, NULL, 1000),
  ('special:tenure-365', 'special', NULL, 'Year One', '/images/avatars/tenure-365.webp',
   '{"type":"tenure_days","days":365}', 'Be a fan for 1 year', NULL, NULL, 1001),
  ('special:tenure-730', 'special', NULL, 'Longform', '/images/avatars/tenure-730.webp',
   '{"type":"tenure_days","days":730}', 'Be a fan for 2 years', NULL, NULL, 1002),
  ('special:streak-4', 'special', NULL, 'Four Weeks', '/images/avatars/streak-4.webp',
   '{"type":"free_song_streak","weeks":4}', 'Claim the free song 4 weeks running', NULL, NULL, 1010),
  ('special:streak-12', 'special', NULL, 'Twelve Weeks', '/images/avatars/streak-12.webp',
   '{"type":"free_song_streak","weeks":12}', 'Claim the free song 12 weeks running', NULL, NULL, 1011)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name, art_path = excluded.art_path,
  unlock_rule = excluded.unlock_rule, hint = excluded.hint, sort_order = excluded.sort_order;
```

Add to `package.json`:

```json
"sync:avatars": "node scripts/sync-avatar-catalogue.mjs --local",
"sync:avatars:remote": "node scripts/sync-avatar-catalogue.mjs --remote",
"d1:seed:avatars:local": "npx --yes wrangler d1 execute GATES --config tools/d1/wrangler.toml --local --file=tools/d1/seed-special-avatars.sql"
```

- [ ] **Step 6: Populate locally and verify**

```bash
npm run sync:avatars
npm run d1:seed:avatars:local
npx --yes wrangler d1 execute GATES --config tools/d1/wrangler.toml --local \
  --command "SELECT kind, COUNT(*) FROM avatar_catalogue GROUP BY kind;"
```

Expected: 21 `release` rows, 5 `special` rows.

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-avatar-catalogue.mjs tools/d1/seed-special-avatars.sql tests/community/catalogue-sync.test.js package.json
git commit -m "feat(community): generate release avatars from the catalogue"
```

---

### Task 5: Profile repository

**Files:**
- Create: `functions/_lib/community/repo.ts`
- Create: `functions/_lib/community/session.ts`
- Test: `tests/community/repo.test.js`

**Interfaces:**
- Consumes: `handle.ts`, `unlocks.ts`, `types.ts`, migration 0002.
- Produces:
  - `ensureProfile(db, { email, fanSince, displayName }): Promise<FanProfileRow>`
  - `grantUnlocks(db, fanId, grants: UnlockGrant[]): Promise<number>`
  - `getProfileByHandle(db, handle): Promise<FanProfileRow | null>`
  - `getProfileByEmail(db, email): Promise<FanProfileRow | null>`
  - `getUnlockedAvatarIds(db, fanId): Promise<string[]>`
  - `getCatalogue(db): Promise<AvatarCatalogueRow[]>`
  - `getRarity(db): Promise<Record<string, number>>`
  - `getDirectory(db, { limit, offset }): Promise<FanProfileRow[]>`
  - `updateProfile(db, fanId, { displayName?, equippedAvatarId? }): Promise<void>`
  - `setCollectionCount(db, fanId, count): Promise<void>`
  - `toPublicProfile(row, avatar): PublicProfile`
  - `requireFan(request, env): Promise<string | null>` (from `session.ts`)
  - `makeD1Shim(sqliteDb)` (from `tests/community/helpers/d1-shim.js`)

`repo.ts` takes a `D1Database` as its first argument so tests can pass a `node:sqlite` shim.

- [ ] **Step 1: Write the D1 test shim**

Create `tests/community/helpers/d1-shim.js`. It adapts `node:sqlite` to the slice of the `D1Database` surface `repo.ts` uses — `prepare().bind().all()/first()/run()` — so the repository can be tested without a Cloudflare account. Task 9 imports this same helper.

```javascript
/**
 * Minimal D1Database shim over node:sqlite, covering only the surface
 * functions/_lib/community/repo.ts actually uses.
 *
 * D1 statements are immutable — .bind() returns a NEW statement rather than
 * mutating the receiver — so this returns fresh objects too. Getting that
 * wrong makes bound arguments leak between queries and produces test failures
 * that look like repository bugs.
 */
export function makeD1Shim(db) {
  const make = (sql, args) => ({
    sql,
    args,
    bind: (...a) => make(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return {
    prepare: sql => make(sql, []),
    batch: async stmts => { for (const s of stmts) await s.run(); return []; },
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/community/repo.test.js`.

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ensureProfile, grantUnlocks, getProfileByHandle, getUnlockedAvatarIds,
  getRarity, getDirectory, toPublicProfile,
} from '../../functions/_lib/community/repo';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');

import { makeD1Shim } from './helpers/d1-shim.js';

let raw, db;
beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(UP);
  raw.exec(`INSERT INTO avatar_catalogue (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order)
    VALUES ('release:perception','release','perception','PERCEPTION','/a.webp',
            '{"type":"own_release","slug":"perception"}','Own PERCEPTION',0)`);
  db = makeD1Shim(raw);
});

describe('ensureProfile', () => {
  it('creates a profile on first call', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana Vex' });
    expect(p.handle).toBe('ana-vex');
    expect(p.fan_since).toBe(100);
  });

  it('is idempotent — a second call returns the same row', async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    const b = await ensureProfile(db, { email: 'a@b.com', fanSince: 100, displayName: 'Ana' });
    expect(b.id).toBe(a.id);
    expect(raw.prepare('SELECT COUNT(*) c FROM fan_profiles').get().c).toBe(1);
  });

  it('suffixes a colliding handle instead of failing', async () => {
    await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: 'Ana' });
    const second = await ensureProfile(db, { email: 'c@d.com', fanSince: 0, displayName: 'Ana' });
    expect(second.handle).toBe('ana-2');
  });

  it('falls back to a neutral name when none is supplied', async () => {
    const p = await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: null });
    expect(p.display_name).toBe('Fan');
    // The email must never leak into the public-facing handle.
    expect(p.handle).not.toContain('a@b.com');
    expect(p.handle).not.toContain('b.com');
  });
});

describe('grantUnlocks', () => {
  let fanId;
  beforeEach(async () => {
    fanId = (await ensureProfile(db, { email: 'a@b.com', fanSince: 0, displayName: 'Ana' })).id;
  });

  const grant = { avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' };

  it('grants a new avatar', async () => {
    expect(await grantUnlocks(db, fanId, [grant])).toBe(1);
    expect(await getUnlockedAvatarIds(db, fanId)).toEqual(['release:perception']);
  });

  it('is idempotent — re-granting adds nothing and does not throw', async () => {
    await grantUnlocks(db, fanId, [grant]);
    expect(await grantUnlocks(db, fanId, [grant])).toBe(0);
    expect(await getUnlockedAvatarIds(db, fanId)).toHaveLength(1);
  });

  it('handles an empty grant list', async () => {
    expect(await grantUnlocks(db, fanId, [])).toBe(0);
  });
});

describe('reads', () => {
  beforeEach(async () => {
    const a = await ensureProfile(db, { email: 'a@b.com', fanSince: 10, displayName: 'Ana' });
    await ensureProfile(db, { email: 'c@d.com', fanSince: 20, displayName: 'Bo' });
    await grantUnlocks(db, a.id, [{ avatarId: 'release:perception', source: 'own_release', sourceRef: 'perception' }]);
  });

  it('finds a profile by handle', async () => {
    expect((await getProfileByHandle(db, 'ana')).display_name).toBe('Ana');
  });

  it('returns null for an unknown handle', async () => {
    expect(await getProfileByHandle(db, 'nobody')).toBeNull();
  });

  it('computes rarity as a fraction of all fans', async () => {
    // 1 of 2 fans holds it.
    expect((await getRarity(db))['release:perception']).toBeCloseTo(0.5);
  });

  it('lists the directory', async () => {
    expect(await getDirectory(db, { limit: 10, offset: 0 })).toHaveLength(2);
  });
});

describe('toPublicProfile', () => {
  it('never includes the email', () => {
    const row = {
      id: 1, email: 'secret@b.com', handle: 'ana', display_name: 'Ana',
      equipped_avatar_id: null, fan_since: 1, rank_points: 0,
      collection_count: 2, created_at: 0, updated_at: 0, last_seen_at: null,
    };
    const pub = toPublicProfile(row, null);
    expect(JSON.stringify(pub)).not.toContain('secret@b.com');
    expect('email' in pub).toBe(false);
    expect(pub.handle).toBe('ana');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/community/repo.test.js`
Expected: FAIL — cannot resolve `functions/_lib/community/repo`

- [ ] **Step 4: Write the session guard**

Create `functions/_lib/community/session.ts`:

```typescript
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
```

- [ ] **Step 5: Write the repository**

Create `functions/_lib/community/repo.ts`:

```typescript
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/community/repo.test.js`
Expected: PASS (13 tests)

- [ ] **Step 7: Commit**

```bash
git add functions/_lib/community/repo.ts functions/_lib/community/session.ts tests/community/repo.test.js tests/community/helpers/d1-shim.js
git commit -m "feat(community): profile repository and fans-only session guard"
```

---

### Task 6: The `/api/community/me` endpoint

**Files:**
- Create: `functions/api/community/me.ts`
- Create: `functions/api/community/update.ts`

**Interfaces:**
- Consumes: `repo.ts`, `session.ts`, `unlocks.ts`, `functions/_lib/ratelimit.ts`, `functions/_lib/cors.ts`.
- Produces: `GET /api/community/me`, `POST /api/community/update`.

Read `functions/api/library.ts` first — it is the closest existing endpoint and shows the KV customer-record read this task reuses.

- [ ] **Step 1: Write the endpoint**

Create `functions/api/community/me.ts`:

```typescript
// GET /api/community/me
// The signed-in fan's own profile. Creates it on first visit and runs the
// unlock engine, which is what backfills existing customers' collections.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  ensureProfile, getCatalogue, getUnlockedAvatarIds, grantUnlocks,
  getRarity, setCollectionCount, toPublicProfile,
} from '../../_lib/community/repo';
import { evaluateUnlocks } from '../../_lib/community/unlocks';

interface CustomerRecord {
  name?: string | null;
  first_seen_at?: number;
  purchases?: Array<{ music_release_slugs?: string[]; digital_slugs?: string[] }>;
}

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_me', 'ip', clientIp(request), 60, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    // Ownership and tenure still come from KV — it remains the source of truth.
    const raw = await env.DOWNLOADS.get(`customer:${email}`);
    let record: CustomerRecord = {};
    try { if (raw) record = JSON.parse(raw); } catch { /* treat as empty */ }

    const owned = new Set<string>();
    for (const p of record.purchases || []) {
      for (const s of p.music_release_slugs || []) owned.add(s);
      for (const d of p.digital_slugs || []) owned.add(d);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const profile = await ensureProfile(env.GATES, {
      email,
      // A fan with no purchases (e.g. arrived via a download gate) still gets
      // a profile; their tenure starts now.
      fanSince: record.first_seen_at || nowSec,
      displayName: record.name || null,
    });

    const catalogue = await getCatalogue(env.GATES);
    const grants = evaluateUnlocks(
      {
        ownedSlugs: [...owned],
        fanSince: profile.fan_since,
        now: nowSec,
        // Zero until the free-song, shows and gate systems ship. Their avatars
        // exist in the catalogue and render locked with their hint.
        streakWeeks: 0,
        showsAttended: [],
        gatesCompleted: [],
      },
      catalogue,
    );
    await grantUnlocks(env.GATES, profile.id, grants);
    await setCollectionCount(env.GATES, profile.id, owned.size);

    const unlockedIds = new Set(await getUnlockedAvatarIds(env.GATES, profile.id));
    const rarity = await getRarity(env.GATES);
    const equipped = catalogue.find(a => a.id === profile.equipped_avatar_id) || null;

    // The owner sees the whole catalogue: unlocked ones to equip, locked ones
    // with their hint. The locked half is the entire point — an unseen reward
    // motivates nobody.
    const avatars = catalogue.map(a => ({
      id: a.id,
      name: a.name,
      art_path: a.art_path,
      hint: a.hint,
      kind: a.kind,
      release_slug: a.release_slug,
      unlocked: unlockedIds.has(a.id),
      rarity: rarity[a.id] ?? 0,
    }));

    return new Response(JSON.stringify({
      profile: { ...toPublicProfile({ ...profile, collection_count: owned.size }, equipped), is_self: true },
      avatars,
      newly_unlocked: grants.filter(g => !unlockedIds.has(g.avatarId)).map(g => g.avatarId),
    }), { headers: { 'Content-Type': 'application/json' } });
  },
);
```

- [ ] **Step 2: Write the update endpoint**

Create `functions/api/community/update.ts`:

```typescript
// POST /api/community/update  { display_name?, equipped_avatar_id? }
// Fan-owned fields only. A fan may equip only an avatar they have unlocked.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { getProfileByEmail, getUnlockedAvatarIds, updateProfile } from '../../_lib/community/repo';
import { isValidDisplayName, isBlockedName } from '../../_lib/community/handle';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestPost: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_update', 'ip', clientIp(request), 20, 600);
    if (!rl.ok) return rateLimitedJson(rl);

    const email = await requireFan(request, env);
    if (!email) return unauthorized();

    let body: { display_name?: string; equipped_avatar_id?: string };
    try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

    const profile = await getProfileByEmail(env.GATES, email);
    if (!profile) return json({ error: 'no profile' }, 404);

    const fields: { displayName?: string; equippedAvatarId?: string | null } = {};

    if (body.display_name !== undefined) {
      const name = String(body.display_name).trim();
      if (!isValidDisplayName(name)) return json({ error: 'invalid_name' }, 400);
      if (isBlockedName(name)) return json({ error: 'blocked_name' }, 400);
      fields.displayName = name;
      // The handle is deliberately NOT regenerated on rename: it is a stable
      // permalink, and changing it would break every link to this profile.
    }

    if (body.equipped_avatar_id !== undefined) {
      const wanted = body.equipped_avatar_id;
      if (wanted === null || wanted === '') {
        fields.equippedAvatarId = null;
      } else {
        const unlocked = await getUnlockedAvatarIds(env.GATES, profile.id);
        if (!unlocked.includes(wanted)) return json({ error: 'not_unlocked' }, 403);
        fields.equippedAvatarId = wanted;
      }
    }

    await updateProfile(env.GATES, profile.id, fields);
    return json({ ok: true });
  },
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 3: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS — all prior tests green (these endpoints are covered end-to-end in Task 9).

- [ ] **Step 4: Commit**

```bash
git add functions/api/community/me.ts functions/api/community/update.ts
git commit -m "feat(community): own-profile endpoint with unlock backfill, and profile updates"
```

---

### Task 7: Public profile and directory endpoints

**Files:**
- Create: `functions/api/community/profile.ts`
- Create: `functions/api/community/directory.ts`

**Interfaces:**
- Consumes: `repo.ts`, `session.ts`.
- Produces: `GET /api/community/profile?handle=<h>`, `GET /api/community/directory?limit=&offset=`.

- [ ] **Step 1: Write the profile endpoint**

Create `functions/api/community/profile.ts`:

```typescript
// GET /api/community/profile?handle=<handle>
// Another fan's profile. Fans-only: signed-out callers get 401, never data.
//
// What is exposed here is exactly the spec's visible surface — display name,
// avatar, fan-since, rank, collection. Never email, prices, purchase dates or
// order history.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import {
  getProfileByHandle, getUnlockedAvatarIds, getCatalogue, getRarity, toPublicProfile,
} from '../../_lib/community/repo';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_profile', 'ip', clientIp(request), 120, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    if (!(await requireFan(request, env))) return unauthorized();

    const handle = (new URL(request.url).searchParams.get('handle') || '').toLowerCase();
    if (!/^[a-z0-9-]{1,32}$/.test(handle)) {
      return new Response(JSON.stringify({ error: 'bad handle' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const profile = await getProfileByHandle(env.GATES, handle);
    if (!profile) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }

    const catalogue = await getCatalogue(env.GATES);
    const unlocked = new Set(await getUnlockedAvatarIds(env.GATES, profile.id));
    const rarity = await getRarity(env.GATES);
    const equipped = catalogue.find(a => a.id === profile.equipped_avatar_id) || null;

    // Only what this fan HAS. A visitor does not get to see somebody else's
    // locked list — that is the owner's to-do list, not a public fact.
    const shelf = catalogue
      .filter(a => unlocked.has(a.id))
      .map(a => ({
        id: a.id, name: a.name, art_path: a.art_path,
        kind: a.kind, release_slug: a.release_slug, rarity: rarity[a.id] ?? 0,
      }));

    return new Response(JSON.stringify({
      profile: { ...toPublicProfile(profile, equipped), is_self: false },
      shelf,
    }), { headers: { 'Content-Type': 'application/json' } });
  },
);
```

- [ ] **Step 2: Write the directory endpoint**

Create `functions/api/community/directory.ts`:

```typescript
// GET /api/community/directory?limit=&offset=
// The fan wall: directory + leaderboard, in one paginated list.
// Answers spec open question §10.3 — it paginates, defaulting to 48 a page.

import { corsHandler, preflight } from '../../_lib/cors';
import { rateLimit, rateLimitedJson, clientIp } from '../../_lib/ratelimit';
import { requireFan, unauthorized, type CommunityEnv } from '../../_lib/community/session';
import { getDirectory, getCatalogue, toPublicProfile } from '../../_lib/community/repo';

export const onRequestOptions: PagesFunction<CommunityEnv> = async ({ request }) => preflight(request);

export const onRequestGet: PagesFunction<CommunityEnv> = corsHandler<CommunityEnv>(
  async ({ request, env }) => {
    const rl = await rateLimit(env, 'community_dir', 'ip', clientIp(request), 60, 60);
    if (!rl.ok) return rateLimitedJson(rl);

    if (!(await requireFan(request, env))) return unauthorized();

    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '48', 10) || 48, 1), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    const rows = await getDirectory(env.GATES, { limit, offset });
    const catalogue = await getCatalogue(env.GATES);
    const byId = new Map(catalogue.map(a => [a.id, a]));

    const fans = rows.map((r, i) => ({
      ...toPublicProfile(r, r.equipped_avatar_id ? byId.get(r.equipped_avatar_id) || null : null),
      position: offset + i + 1,
    }));

    return new Response(JSON.stringify({ fans, limit, offset, has_more: rows.length === limit }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
);
```

- [ ] **Step 3: Verify the suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add functions/api/community/profile.ts functions/api/community/directory.ts
git commit -m "feat(community): public profile and paginated fan directory endpoints"
```

---

### Task 8: Community pages, nav and routing

**Files:**
- Create: `src/components/AvatarMedallion.astro`
- Create: `src/pages/community/index.astro`
- Create: `src/pages/community/me.astro`
- Create: `src/pages/community/profile.astro`
- Modify: `src/components/TopNav.astro`
- Modify: `src/components/BottomNav.astro`
- Modify: `public/_headers`
- Modify: `public/_redirects`

**Interfaces:**
- Consumes: the four endpoints from Tasks 6–7.
- Produces: routes `/community`, `/community/me`, `/community/u/<handle>`.

**Critical routing constraint:** Astro here is **static** (no adapter in `astro.config.mjs`), so a dynamic `[handle].astro` cannot prerender unknown handles. Instead `/community/u/*` is **rewritten** by Cloudflare Pages to a single static shell that reads the handle from `location.pathname` and fetches client-side — the same pattern `src/pages/library.astro` uses today.

- [ ] **Step 1: Write the medallion component**

Create `src/components/AvatarMedallion.astro`:

```astro
---
// Circular framed avatar. Release art is square cover art; the crop and ring
// are what make a leaderboard read as people rather than as a discography.
interface Props {
  art?: string | null;
  name: string;
  size?: 'sm' | 'md' | 'lg';
  locked?: boolean;
  rarity?: number;
}
const { art, name, size = 'md', locked = false, rarity } = Astro.props;
const dim = { sm: 'w-10 h-10', md: 'w-16 h-16', lg: 'w-28 h-28' }[size];
---
<div class="relative inline-block">
  <div class:list={[
    dim,
    'rounded-full overflow-hidden border-2 transition-colors',
    locked ? 'border-white/10' : 'border-primary/60',
  ]}>
    {art ? (
      <img
        src={art}
        alt={locked ? `${name} — locked` : name}
        width="112" height="112" loading="lazy" decoding="async"
        class:list={['w-full h-full object-cover', locked && 'grayscale opacity-25']}
      />
    ) : (
      <div class="w-full h-full bg-surface-container-high"></div>
    )}
  </div>
  {locked && (
    <span class="material-symbols-outlined absolute inset-0 grid place-items-center text-white/50 text-[18px]">lock</span>
  )}
  {!locked && typeof rarity === 'number' && rarity > 0 && rarity <= 0.1 && (
    <span class="absolute -bottom-1 left-1/2 -translate-x-1/2 font-mono text-[8px] uppercase tracking-widest bg-secondary text-on-secondary px-1">
      {Math.max(1, Math.round(rarity * 100))}%
    </span>
  )}
</div>
```

- [ ] **Step 2: Write the three pages**

All three follow `src/pages/library.astro`'s structure: a static shell, then a `<script>` that fetches and renders. **Read `library.astro` first** and copy its `esc()` and `safeImg()` helpers verbatim — all interpolation into `innerHTML` must go through them, matching the existing XSS discipline.

Create `src/pages/community/me.astro` — header, editable display name, equipped-avatar picker, and the full catalogue grid with locked entries showing their hint. Fetches `GET /api/community/me`; saves via `POST /api/community/update`. On 401, show a sign-in prompt linking to `/login?redirect=/community/me` rather than an error.

Create `src/pages/community/index.astro` — the fan wall. Fetches `GET /api/community/directory`, renders each fan as a medallion + display name + `fan since` + collection count, linking to `/community/u/<handle>`. A "Load more" button increments `offset`. Same 401 handling.

Create `src/pages/community/profile.astro` — the rewrite target. Reads the handle from the path:

```javascript
const handle = location.pathname.replace(/^\/community\/u\//, '').replace(/\/$/, '');
if (!/^[a-z0-9-]{1,32}$/.test(handle)) { showError('No such fan.'); }
else { fetch(`/api/community/profile?handle=${encodeURIComponent(handle)}`) /* ... */ }
```

Render the profile header plus the shelf of avatars they hold. A 404 renders "No such fan", not a crash.

- [ ] **Step 3: Add the rewrite and headers**

Add to `public/_redirects` (order matters — Pages matches top to bottom, and this must not shadow `/community` itself):

```
/community/u/* /community/profile 200
```

Add to `public/_headers`, alongside the existing `/library` block:

```
# Fan-only surfaces: never cached, never indexed. The API already returns 401
# to signed-out callers; X-Robots-Tag stops the shells being indexed too.
/community
  Cache-Control: no-store
  X-Robots-Tag: noindex, nofollow
/community/*
  Cache-Control: no-store
  X-Robots-Tag: noindex, nofollow
```

- [ ] **Step 4: Add the nav entry**

In `src/components/TopNav.astro`, add to `navItems`:

```javascript
{ label: 'COMMUNITY', href: '/community', icon: 'diversity_3' },
```

Do the same in `src/components/BottomNav.astro`. Two things to handle there:

1. `BottomNav` currently points SOCIAL at the stale `/signal` (which 301s to `/social` via `_redirects`). Leave that alone — it is outside this feature.
2. Five items crowd the mobile row. In `TopNav`, the mobile label class is `text-[8px]`; verify at 320px width that "COMMUNITY" does not wrap or overlap. If it does, shorten the label to `FANS` in the mobile markup only — do not change the route.

`diversity_3` must be added to the icon subset or it will render as blank. Run:

```bash
node scripts/subset-icon-font.mjs
```

Confirm the script picks up the new ligature (it scans the source for `material-symbols-outlined` usage). If it does not detect it automatically, add the glyph name to that script's explicit list.

- [ ] **Step 5: Verify the build and the routes**

```bash
npm run build
```

Expected: build succeeds; `dist/community/index.html`, `dist/community/me/index.html` and `dist/community/profile/index.html` all exist.

Then verify the icon actually rendered rather than falling back to ligature text, and that the nav fits at 320px. **Take a real screenshot** — per project convention, headless checks have shipped false passes before.

- [ ] **Step 6: Commit**

```bash
git add src/components/AvatarMedallion.astro src/pages/community/ src/components/TopNav.astro src/components/BottomNav.astro public/_headers public/_redirects public/fonts/MaterialSymbols-Subset.woff2
git commit -m "feat(community): community tab, fan directory and profile pages"
```

---

### Task 9: End-to-end verification and the rebuild script

**Files:**
- Create: `scripts/rebuild-fan-projection.mjs`
- Modify: `package.json`
- Test: `tests/community/e2e-unlock.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run rebuild:fans` — regenerates every derived field from KV.

This task delivers the safety net the spec's architecture depends on: derived fields must be regenerable, or the KV↔D1 split is a liability rather than a design.

- [ ] **Step 1: Write the end-to-end test**

Create `tests/community/e2e-unlock.test.js`. This exercises the full chain — a customer record's owned slugs through the engine into the ledger — using the shared `makeD1Shim` helper created in Task 5.

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureProfile, grantUnlocks, getUnlockedAvatarIds } from '../../functions/_lib/community/repo';
import { evaluateUnlocks } from '../../functions/_lib/community/unlocks';
import { buildReleaseAvatars } from '../../scripts/sync-avatar-catalogue.mjs';
import { makeD1Shim } from './helpers/d1-shim.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');

const CATALOG = {
  releases: [
    { slug: 'perception', title: 'PERCEPTION', artwork: '/images/albums/perception.jpg' },
    { slug: 'swamp-logic', title: 'SWAMP LOGIC', artwork: '/images/albums/swamp-logic.jpg' },
  ],
};

let raw, db;
beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(UP);
  for (const a of buildReleaseAvatars(CATALOG)) {
    raw.prepare(`INSERT INTO avatar_catalogue
      (id,kind,release_slug,name,art_path,unlock_rule,hint,sort_order)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(a.id, a.kind, a.release_slug, a.name, a.art_path, a.unlock_rule, a.hint, a.sort_order);
  }
  db = makeD1Shim(raw);
});

const catalogue = () => raw.prepare('SELECT * FROM avatar_catalogue').all();

describe('backfill of an existing customer', () => {
  it('grants avatars for everything they already owned before this feature existed', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 1000, displayName: 'Ana' });
    const grants = evaluateUnlocks({
      ownedSlugs: ['perception'], fanSince: 1000, now: 2000,
      streakWeeks: 0, showsAttended: [], gatesCompleted: [],
    }, catalogue());
    await grantUnlocks(db, profile.id, grants);
    expect(await getUnlockedAvatarIds(db, profile.id)).toEqual(['release:perception']);
  });

  it('is safe to run repeatedly — the second run grants nothing new', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 1000, displayName: 'Ana' });
    const ctx = {
      ownedSlugs: ['perception', 'swamp-logic'], fanSince: 1000, now: 2000,
      streakWeeks: 0, showsAttended: [], gatesCompleted: [],
    };
    await grantUnlocks(db, profile.id, evaluateUnlocks(ctx, catalogue()));
    const added = await grantUnlocks(db, profile.id, evaluateUnlocks(ctx, catalogue()));
    expect(added).toBe(0);
    expect(await getUnlockedAvatarIds(db, profile.id)).toHaveLength(2);
  });

  it('grants the new avatar when a fan buys another release later', async () => {
    const profile = await ensureProfile(db, { email: 'a@b.com', fanSince: 1000, displayName: 'Ana' });
    const base = { fanSince: 1000, now: 2000, streakWeeks: 0, showsAttended: [], gatesCompleted: [] };
    await grantUnlocks(db, profile.id, evaluateUnlocks({ ...base, ownedSlugs: ['perception'] }, catalogue()));
    await grantUnlocks(db, profile.id, evaluateUnlocks({ ...base, ownedSlugs: ['perception', 'swamp-logic'] }, catalogue()));
    expect(await getUnlockedAvatarIds(db, profile.id)).toHaveLength(2);
  });

  it('grants nothing to a fan who owns nothing', async () => {
    const profile = await ensureProfile(db, { email: 'new@b.com', fanSince: 2000, displayName: 'New' });
    const grants = evaluateUnlocks({
      ownedSlugs: [], fanSince: 2000, now: 2000,
      streakWeeks: 0, showsAttended: [], gatesCompleted: [],
    }, catalogue());
    await grantUnlocks(db, profile.id, grants);
    expect(await getUnlockedAvatarIds(db, profile.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npx vitest run tests/community/e2e-unlock.test.js`

Expected: PASS (4 tests)

- [ ] **Step 3: Write the rebuild script**

Create `scripts/rebuild-fan-projection.mjs`. It walks every `customer:*` key in KV and recomputes each fan's derived state, leaving fan-owned fields untouched.

```javascript
/**
 * rebuild-fan-projection.mjs
 *
 * Regenerates every DERIVED field in the D1 fan projection from KV, which is
 * the source of truth. Fan-owned fields — handle, display_name,
 * equipped_avatar_id — are never written here, so a rebuild cannot clobber
 * somebody's identity.
 *
 * This is what makes the KV/D1 split safe: drift is a recoverable
 * inconvenience rather than data loss.
 *
 *   node scripts/rebuild-fan-projection.mjs --dry-run
 *   node scripts/rebuild-fan-projection.mjs --remote
 *
 * Requires `wrangler login`.
 */
```

Implementation notes for the engineer:

- List keys with `npx wrangler kv key list --binding DOWNLOADS --prefix "customer:"`. The KV binding is configured in the Pages dashboard, so pass `--remote`.
- For each record: parse it, union `music_release_slugs` + `digital_slugs` into `ownedSlugs`, take `first_seen_at` as `fan_since`.
- Emit one SQL file that upserts `fan_since` and `collection_count`, and inserts unlock rows with `ON CONFLICT (fan_id, avatar_id) DO NOTHING`. Execute it in one `wrangler d1 execute --file=` call rather than one call per fan.
- `--dry-run` prints the SQL and exits without executing.
- Never emit an `UPDATE` touching `handle`, `display_name`, or `equipped_avatar_id`.

Add to `package.json`:

```json
"rebuild:fans": "node scripts/rebuild-fan-projection.mjs"
```

- [ ] **Step 4: Full local verification**

```bash
npm test                       # every suite
npm run build                  # static build succeeds
npm run rebuild:fans -- --dry-run
```

Expected: all tests pass; build succeeds; the dry run prints SQL containing no `UPDATE` to a fan-owned column.

- [ ] **Step 5: Commit**

```bash
git add scripts/rebuild-fan-projection.mjs tests/community/e2e-unlock.test.js package.json
git commit -m "feat(community): fan projection rebuild script and end-to-end unlock tests"
```

---

## Deployment checklist

Not part of any task — these are manual steps for Tim, and several are blockers.

1. `npx wrangler login` — **the stored token is currently expired.**
2. `npx wrangler d1 create morphics-gates`, then paste the returned `database_id` into `tools/d1/wrangler.toml`.
3. Cloudflare Pages → Settings → Functions → Bindings → **D1**, variable name `GATES`, database `morphics-gates`. Without this every `/api/community/*` call 500s.
4. `npm run d1:migrate` (remote) — applies 0001 and 0002.
5. `npm run sync:avatars:remote` and the special-avatar seed against remote.
6. Create the five special-avatar images at `/images/avatars/*.webp`.
7. `npm run rebuild:fans -- --remote` once, to backfill existing customers.

**Preview deployments share the production KV namespace** (`SECURITY-OPS.md:74`), and will now share D1 too. A preview deploy can write real fan profiles.

## Deferred to later sub-projects

- `streakWeeks` is hard-coded `0` (free-song-of-the-week).
- `showsAttended` is hard-coded `[]` (shows & attendance).
- `gatesCompleted` is hard-coded `[]` (wire to the gate system once it ships).
- `rank_points` is always `0` (loyalty & perks). Recorded in the spec: collection size is a poor rank input while giveaways are frequent.

Their avatars exist in the catalogue and render **locked with their hint**, which is deliberate — visible, unearnable rewards are the teaser.

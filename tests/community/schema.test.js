import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0002_fan_profiles.sql'), 'utf8');
const DOWN = readFileSync(join(root, 'migrations/down/0002_fan_profiles.down.sql'), 'utf8');
const UP3 = readFileSync(join(root, 'migrations/0003_handle_locked.sql'), 'utf8');
const DOWN3 = readFileSync(join(root, 'migrations/down/0003_handle_locked.down.sql'), 'utf8');
const UP4 = readFileSync(join(root, 'migrations/0004_handle_cooldown.sql'), 'utf8');
const DOWN4 = readFileSync(join(root, 'migrations/down/0004_handle_cooldown.down.sql'), 'utf8');
const UP5 = readFileSync(join(root, 'migrations/0005_avatar_tiers.sql'), 'utf8');
const DOWN5 = readFileSync(join(root, 'migrations/down/0005_avatar_tiers.down.sql'), 'utf8');
const UP6 = readFileSync(join(root, 'migrations/0006_creatures.sql'), 'utf8');
const DOWN6 = readFileSync(join(root, 'migrations/down/0006_creatures.down.sql'), 'utf8');
const UP7 = readFileSync(join(root, 'migrations/0007_sprites.sql'), 'utf8');
const DOWN7 = readFileSync(join(root, 'migrations/down/0007_sprites.down.sql'), 'utf8');
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

const STUB3 = `INSERT INTO d1_migrations (name, applied_at) VALUES ('0003_handle_locked.sql','now');`;

function makeDb3() {
  const db = makeDb();
  db.exec(STUB3);
  db.exec(UP3);
  return db;
}

describe('migration 0003', () => {
  it('adds handle_locked, defaulting to 0', () => {
    const db = makeDb3();
    addFan(db, 'a@b.com', 'ana');
    const row = db.prepare('SELECT handle_locked FROM fan_profiles').get();
    expect(row.handle_locked).toBe(0);
  });

  it('enforces the 0/1 check constraint', () => {
    const db = makeDb3();
    addFan(db, 'a@b.com', 'ana');
    expect(() => db.prepare('UPDATE fan_profiles SET handle_locked = 2 WHERE handle = ?').run('ana'))
      .toThrow(/CHECK constraint/i);
  });

  it('is reversible', () => {
    const db = makeDb3();
    db.exec(DOWN3);
    const cols = db.prepare("PRAGMA table_info(fan_profiles)").all().map(c => c.name);
    expect(cols).not.toContain('handle_locked');
  });

  it('down clears bookkeeping so up can re-run', () => {
    const db = makeDb3();
    db.exec(DOWN3);
    expect(db.prepare("SELECT name FROM d1_migrations WHERE name = '0003_handle_locked.sql'").all()).toHaveLength(0);
    expect(() => { db.exec(STUB3); db.exec(UP3); }).not.toThrow();
  });
});

const STUB4 = `INSERT INTO d1_migrations (name, applied_at) VALUES ('0004_handle_cooldown.sql','now');`;

function makeDb4() {
  const db = makeDb3();
  db.exec(STUB4);
  db.exec(UP4);
  return db;
}

describe('migration 0004', () => {
  it('adds handle_changed_at (nullable) and drops handle_locked', () => {
    const db = makeDb4();
    addFan(db, 'a@b.com', 'ana');
    const cols = db.prepare('PRAGMA table_info(fan_profiles)').all().map(c => c.name);
    expect(cols).toContain('handle_changed_at');
    expect(cols).not.toContain('handle_locked');
    const row = db.prepare('SELECT handle_changed_at FROM fan_profiles').get();
    expect(row.handle_changed_at).toBeNull();
  });

  it('is reversible — restores handle_locked and drops handle_changed_at', () => {
    const db = makeDb4();
    db.exec(DOWN4);
    const cols = db.prepare('PRAGMA table_info(fan_profiles)').all().map(c => c.name);
    expect(cols).toContain('handle_locked');
    expect(cols).not.toContain('handle_changed_at');
  });

  it('down clears bookkeeping so up can re-run', () => {
    const db = makeDb4();
    db.exec(DOWN4);
    expect(db.prepare("SELECT name FROM d1_migrations WHERE name = '0004_handle_cooldown.sql'").all()).toHaveLength(0);
    expect(() => { db.exec(STUB4); db.exec(UP4); }).not.toThrow();
  });
});

const STUB5 = `INSERT INTO d1_migrations (name, applied_at) VALUES ('0005_avatar_tiers.sql','now');`;

function makeDb5() {
  const db = makeDb4();
  db.exec(STUB5);
  db.exec(UP5);
  return db;
}

const PLACEHOLDER_IDS = [
  'special:tenure-90', 'special:tenure-365', 'special:tenure-730',
  'special:streak-4', 'special:streak-12',
];

function placeholderCount(db) {
  return db.prepare(
    `SELECT COUNT(*) c FROM avatar_catalogue WHERE id IN (${PLACEHOLDER_IDS.map(() => '?').join(',')})`,
  ).get(...PLACEHOLDER_IDS).c;
}

describe('migration 0005', () => {
  it('adds style, colourway, artwork_key, tier — all nullable', () => {
    const db = makeDb5();
    addAvatar(db, 'release:perception');
    const cols = db.prepare('PRAGMA table_info(avatar_catalogue)').all().map(c => c.name);
    for (const c of ['style', 'colourway', 'artwork_key', 'tier']) expect(cols).toContain(c);
    const row = db.prepare("SELECT style, colourway, artwork_key, tier FROM avatar_catalogue WHERE id = 'release:perception'").get();
    expect(row.style).toBeNull();
    expect(row.colourway).toBeNull();
    expect(row.artwork_key).toBeNull();
    expect(row.tier).toBeNull();
  });

  it('leaves art_path untouched — release avatars still work exactly as before', () => {
    const db = makeDb5();
    addAvatar(db, 'release:perception');
    const row = db.prepare("SELECT art_path FROM avatar_catalogue WHERE id = 'release:perception'").get();
    expect(row.art_path).toBe('/a.webp');
  });

  it('deletes the five special:* placeholder rows', () => {
    const db = makeDb4();
    // Seed the five placeholders exactly as tools/d1/seed-special-avatars.sql does.
    for (const id of PLACEHOLDER_IDS) {
      db.prepare(`INSERT INTO avatar_catalogue (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order)
        VALUES (?, 'special', NULL, 'N', '/a.webp', '{"type":"tenure_days","days":1}', 'hint', 0)`).run(id);
    }
    expect(placeholderCount(db)).toBe(5);
    db.exec(STUB5);
    db.exec(UP5);
    expect(placeholderCount(db)).toBe(0);
  });

  it('enforces the style CHECK constraint', () => {
    const db = makeDb5();
    expect(() => db.prepare(`INSERT INTO avatar_catalogue (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order, style)
      VALUES ('x', 'special', NULL, 'N', '/a.webp', '{"type":"manual"}', 'hint', 0, 'nonsense')`).run())
      .toThrow(/CHECK constraint/i);
  });

  it('enforces the tier CHECK constraint (1-4 or NULL)', () => {
    const db = makeDb5();
    expect(() => db.prepare(`INSERT INTO avatar_catalogue (id, kind, release_slug, name, art_path, unlock_rule, hint, sort_order, tier)
      VALUES ('x', 'special', NULL, 'N', '/a.webp', '{"type":"manual"}', 'hint', 0, 5)`).run())
      .toThrow(/CHECK constraint/i);
  });

  it('is reversible — drops the four columns', () => {
    const db = makeDb5();
    db.exec(DOWN5);
    const cols = db.prepare('PRAGMA table_info(avatar_catalogue)').all().map(c => c.name);
    for (const c of ['style', 'colourway', 'artwork_key', 'tier']) expect(cols).not.toContain(c);
  });

  it('down restores the five placeholder rows', () => {
    const db = makeDb5();
    expect(placeholderCount(db)).toBe(0);
    db.exec(DOWN5);
    expect(placeholderCount(db)).toBe(5);
  });

  it('down clears bookkeeping so up can re-run', () => {
    const db = makeDb5();
    db.exec(DOWN5);
    expect(db.prepare("SELECT name FROM d1_migrations WHERE name = '0005_avatar_tiers.sql'").all()).toHaveLength(0);
    expect(() => { db.exec(STUB5); db.exec(UP5); }).not.toThrow();
  });
});

const STUB6 = `INSERT INTO d1_migrations (name, applied_at) VALUES ('0006_creatures.sql','now');`;

function makeDb6() {
  const db = makeDb5();
  db.exec(STUB6);
  db.exec(UP6);
  return db;
}

describe('migration 0006', () => {
  it('creates creature_species', () => {
    const t = tables(makeDb6());
    expect(t).toContain('creature_species');
  });

  it('adds ep (defaulting to 0), stage/species/creature_colourway/hatched_at (all nullable) to fan_profiles', () => {
    const db = makeDb6();
    addFan(db, 'a@b.com', 'ana');
    const cols = db.prepare('PRAGMA table_info(fan_profiles)').all().map(c => c.name);
    for (const c of ['ep', 'stage', 'species', 'creature_colourway', 'hatched_at']) expect(cols).toContain(c);
    const row = db.prepare('SELECT ep, stage, species, creature_colourway, hatched_at FROM fan_profiles').get();
    expect(row.ep).toBe(0);
    expect(row.stage).toBeNull();
    expect(row.species).toBeNull();
    expect(row.creature_colourway).toBeNull();
    expect(row.hatched_at).toBeNull();
  });

  it('enforces the stage CHECK constraint', () => {
    const db = makeDb6();
    addFan(db, 'a@b.com', 'ana');
    expect(() => db.prepare("UPDATE fan_profiles SET stage = 'nonsense' WHERE handle = 'ana'").run())
      .toThrow(/CHECK constraint/i);
  });

  it('accepts every valid stage value, and NULL', () => {
    const db = makeDb6();
    addFan(db, 'a@b.com', 'ana');
    for (const s of ['egg', 'larva', 'chrysalis', 'emergent', null]) {
      expect(() => db.prepare('UPDATE fan_profiles SET stage = ? WHERE handle = ?').run(s, 'ana')).not.toThrow();
    }
  });

  it('enforces the creature_species.active CHECK constraint', () => {
    const db = makeDb6();
    expect(() => db.prepare(
      `INSERT INTO creature_species (id, name, rarity_weight, art_prefix, active) VALUES ('x', 'N', 100, 'x', 2)`,
    ).run()).toThrow(/CHECK constraint/i);
  });

  it('creature_species.active defaults to 1', () => {
    const db = makeDb6();
    db.prepare(`INSERT INTO creature_species (id, name, art_prefix) VALUES ('x', 'N', 'x')`).run();
    const row = db.prepare('SELECT active, rarity_weight FROM creature_species WHERE id = ?').get('x');
    expect(row.active).toBe(1);
    expect(row.rarity_weight).toBe(100);
  });

  it('is reversible — drops the five columns and the table', () => {
    const db = makeDb6();
    db.exec(DOWN6);
    const cols = db.prepare('PRAGMA table_info(fan_profiles)').all().map(c => c.name);
    for (const c of ['ep', 'stage', 'species', 'creature_colourway', 'hatched_at']) expect(cols).not.toContain(c);
    expect(tables(db)).not.toContain('creature_species');
  });

  it('down clears bookkeeping so up can re-run', () => {
    const db = makeDb6();
    db.exec(DOWN6);
    expect(db.prepare("SELECT name FROM d1_migrations WHERE name = '0006_creatures.sql'").all()).toHaveLength(0);
    expect(() => { db.exec(STUB6); db.exec(UP6); }).not.toThrow();
  });
});

const STUB7 = `INSERT INTO d1_migrations (name, applied_at) VALUES ('0007_sprites.sql','now');`;

function makeDb7() {
  const db = makeDb6();
  db.exec(STUB7);
  db.exec(UP7);
  return db;
}

describe('migration 0007', () => {
  it('renames stage CHECK values to egg/grub/pupa/adult and rejects the old names', () => {
    const db = makeDb7();
    addFan(db, 'a@b.com', 'ana');
    for (const s of ['egg', 'grub', 'pupa', 'adult', null]) {
      expect(() => db.prepare('UPDATE fan_profiles SET stage = ? WHERE handle = ?').run(s, 'ana')).not.toThrow();
    }
    for (const s of ['larva', 'chrysalis', 'emergent']) {
      expect(() => db.prepare('UPDATE fan_profiles SET stage = ? WHERE handle = ?').run(s, 'ana'))
        .toThrow(/CHECK constraint/i);
    }
  });

  it('rewrites existing rows: larva -> grub, chrysalis -> pupa, emergent -> adult, egg/NULL untouched', () => {
    // Build the row under the OLD (0006) schema first, then apply 0007 on
    // top — this is the actual migration path a populated table takes,
    // unlike makeDb7() alone which never has pre-existing data to translate.
    const db = makeDb6();
    addFan(db, 'egg@b.com', 'egg-fan');
    addFan(db, 'larva@b.com', 'larva-fan');
    addFan(db, 'chrysalis@b.com', 'chrysalis-fan');
    addFan(db, 'emergent@b.com', 'emergent-fan');
    addFan(db, 'legacy@b.com', 'legacy-fan'); // stage stays NULL
    db.prepare("UPDATE fan_profiles SET stage = 'egg' WHERE handle = 'egg-fan'").run();
    db.prepare("UPDATE fan_profiles SET stage = 'larva' WHERE handle = 'larva-fan'").run();
    db.prepare("UPDATE fan_profiles SET stage = 'chrysalis' WHERE handle = 'chrysalis-fan'").run();
    db.prepare("UPDATE fan_profiles SET stage = 'emergent' WHERE handle = 'emergent-fan'").run();

    db.exec(STUB7);
    db.exec(UP7);

    const stageOf = handle => db.prepare('SELECT stage FROM fan_profiles WHERE handle = ?').get(handle).stage;
    expect(stageOf('egg-fan')).toBe('egg');
    expect(stageOf('larva-fan')).toBe('grub');
    expect(stageOf('chrysalis-fan')).toBe('pupa');
    expect(stageOf('emergent-fan')).toBe('adult');
    expect(stageOf('legacy-fan')).toBeNull();
  });

  it('preserves id, and everything that references fan_profiles.id by that id, across the rebuild', () => {
    const db = makeDb6();
    const id = addFan(db, 'a@b.com', 'ana');
    addAvatar(db, 'release:x');
    db.prepare(`INSERT INTO fan_avatar_unlocks (fan_id, avatar_id, unlocked_at, source)
      VALUES (?, 'release:x', 0, 'own_release')`).run(id);

    db.exec(STUB7);
    db.exec(UP7);

    const row = db.prepare('SELECT id FROM fan_profiles WHERE handle = ?').get('ana');
    expect(row.id).toBe(id);
    const unlock = db.prepare('SELECT * FROM fan_avatar_unlocks WHERE fan_id = ?').get(id);
    expect(unlock).toBeTruthy();
    expect(unlock.avatar_id).toBe('release:x');
  });

  it('a fan created after the migration keeps getting a fresh, never-reused id', () => {
    const db = makeDb6();
    const before = addFan(db, 'a@b.com', 'ana');
    db.exec(STUB7);
    db.exec(UP7);
    const after = addFan(db, 'c@d.com', 'carlos');
    expect(after).toBeGreaterThan(before);
  });

  it('adds sprite_egg/grub/pupa/adult and colourway — all nullable', () => {
    const db = makeDb7();
    addFan(db, 'a@b.com', 'ana');
    const cols = db.prepare('PRAGMA table_info(fan_profiles)').all().map(c => c.name);
    for (const c of ['sprite_egg', 'sprite_grub', 'sprite_pupa', 'sprite_adult', 'colourway']) {
      expect(cols).toContain(c);
    }
    const row = db.prepare(`SELECT sprite_egg, sprite_grub, sprite_pupa, sprite_adult, colourway
      FROM fan_profiles WHERE handle = 'ana'`).get();
    expect(row.sprite_egg).toBeNull();
    expect(row.sprite_grub).toBeNull();
    expect(row.sprite_pupa).toBeNull();
    expect(row.sprite_adult).toBeNull();
    expect(row.colourway).toBeNull();
  });

  it('drops species and creature_colourway (superseded by sprite_* / colourway)', () => {
    const db = makeDb7();
    const cols = db.prepare('PRAGMA table_info(fan_profiles)').all().map(c => c.name);
    expect(cols).not.toContain('species');
    expect(cols).not.toContain('creature_colourway');
  });

  it('drops creature_species — superseded by fixed sprite refs, nothing reads it anymore', () => {
    expect(tables(makeDb7())).not.toContain('creature_species');
  });

  it('enforces the colourway CHECK constraint against the 12 real ids', () => {
    const db = makeDb7();
    addFan(db, 'a@b.com', 'ana');
    expect(() => db.prepare("UPDATE fan_profiles SET colourway = 'not-a-real-colourway' WHERE handle = 'ana'").run())
      .toThrow(/CHECK constraint/i);
    for (const id of [
      'crimson', 'ember', 'amber', 'citron', 'leaf', 'jade',
      'cyan', 'azure', 'indigo', 'violet', 'magenta', 'rose', null,
    ]) {
      expect(() => db.prepare('UPDATE fan_profiles SET colourway = ? WHERE handle = ?').run(id, 'ana')).not.toThrow();
    }
  });

  it('preserves the email/handle uniqueness and the leaderboard index across the rebuild', () => {
    const db = makeDb7();
    addFan(db, 'a@b.com', 'ana');
    expect(() => addFan(db, 'a@b.com', 'other')).toThrow(/UNIQUE constraint/i);
    expect(() => addFan(db, 'c@d.com', 'ana')).toThrow(/UNIQUE constraint/i);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fan_profiles'")
      .all().map(r => r.name);
    expect(idx).toEqual(expect.arrayContaining([
      'idx_fan_profiles_email', 'idx_fan_profiles_handle', 'idx_fan_profiles_board',
    ]));
  });

  it('is reversible — restores the old stage names, species/creature_colourway, and creature_species', () => {
    const db = makeDb6();
    addFan(db, 'a@b.com', 'ana');
    db.prepare("UPDATE fan_profiles SET stage = 'egg' WHERE handle = 'ana'").run();
    db.exec(STUB7);
    db.exec(UP7);
    db.prepare("UPDATE fan_profiles SET stage = 'adult' WHERE handle = 'ana'").run();

    db.exec(DOWN7);

    const cols = db.prepare('PRAGMA table_info(fan_profiles)').all().map(c => c.name);
    for (const c of ['sprite_egg', 'sprite_grub', 'sprite_pupa', 'sprite_adult', 'colourway']) {
      expect(cols).not.toContain(c);
    }
    expect(cols).toContain('species');
    expect(cols).toContain('creature_colourway');
    expect(tables(db)).toContain('creature_species');
    const row = db.prepare("SELECT stage FROM fan_profiles WHERE handle = 'ana'").get();
    expect(row.stage).toBe('emergent');
  });

  it('down clears bookkeeping so up can re-run', () => {
    const db = makeDb7();
    db.exec(DOWN7);
    expect(db.prepare("SELECT name FROM d1_migrations WHERE name = '0007_sprites.sql'").all()).toHaveLength(0);
    expect(() => { db.exec(STUB7); db.exec(UP7); }).not.toThrow();
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

  it('rejects equipped_avatar_id pointing to a nonexistent avatar', () => {
    expect(() => db.prepare('UPDATE fan_profiles SET equipped_avatar_id = ? WHERE id = ?')
      .run('release:nope', fanId)).toThrow(/FOREIGN KEY/i);
  });

  it('sets equipped_avatar_id to NULL when the avatar is deleted', () => {
    db.prepare('UPDATE fan_profiles SET equipped_avatar_id = ? WHERE id = ?')
      .run('release:perception', fanId);
    db.prepare('DELETE FROM avatar_catalogue WHERE id = ?').run('release:perception');
    const row = db.prepare('SELECT equipped_avatar_id FROM fan_profiles WHERE id = ?').get(fanId);
    expect(row.equipped_avatar_id).toBeNull();
  });

  it('cascades unlocks when an avatar is deleted', () => {
    grant(fanId, 'release:perception');
    db.prepare('DELETE FROM avatar_catalogue WHERE id = ?').run('release:perception');
    expect(db.prepare('SELECT COUNT(*) c FROM fan_avatar_unlocks').get().c).toBe(0);
  });
});

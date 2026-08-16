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

// Schema tests for the download gate data model.
//
// Runs the real migration SQL against an in-memory SQLite database via Node's
// built-in `node:sqlite` — no new dependency, and no Cloudflare account needed,
// so this runs in CI and offline. D1 is SQLite, so the constraints exercised
// here are the same ones that run in production. (Where D1 diverges from stock
// SQLite it is *more* restrictive — e.g. its low compound-SELECT limit, which
// is why the seed uses plain VALUES rows.)
//
// The point of these tests is the honest-labelling guarantee. The brief's first
// hard constraint is "never label an attested action as verified, anywhere".
// Comments and code review don't enforce that; a CHECK constraint does. These
// tests prove the database itself refuses.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UP = readFileSync(join(root, 'migrations/0001_download_gates.sql'), 'utf8');
const DOWN = readFileSync(join(root, 'migrations/down/0001_download_gates.down.sql'), 'utf8');
const SEED = readFileSync(join(root, 'tools/d1/seed-example-gate.sql'), 'utf8');

const TABLES = [
  'gates',
  'gate_actions',
  'gate_unlocks',
  'gate_action_completions',
  'gate_events',
];

/** The down migration expects wrangler's bookkeeping table to exist. */
const D1_MIGRATIONS_STUB = `
  CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TEXT
  );
  INSERT INTO d1_migrations (name, applied_at) VALUES ('0001_download_gates.sql', 'now');
`;

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(r => r.name);
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(D1_MIGRATIONS_STUB);
  db.exec(UP);
  return db;
}

function insertGate(db, slug = 'g') {
  db.exec(`
    INSERT INTO gates (slug, title, file_storage_key, active, created_at, updated_at)
    VALUES ('${slug}', 'T', 'gates/${slug}/f.zip', 1, 0, 0);
  `);
  return db.prepare('SELECT id FROM gates WHERE slug = ?').get(slug).id;
}

function addAction(db, gateId, { ordinal = 1, type, mode }) {
  db.prepare(
    `INSERT INTO gate_actions (gate_id, ordinal, type, verification_mode, required, created_at)
     VALUES (?, ?, ?, ?, 1, 0)`,
  ).run(gateId, ordinal, type, mode);
}

describe('migration 0001 — up and down', () => {
  it('creates every gate table', () => {
    const db = makeDb();
    const names = tableNames(db);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('creates the indexes the brief requires', () => {
    const db = makeDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map(r => r.name);
    // gates.slug, gate_unlocks.email, gate_unlocks.gate_id (leftmost column of
    // the unique gate_id+email index).
    expect(idx).toContain('idx_gates_slug');
    expect(idx).toContain('idx_gate_unlocks_email');
    expect(idx).toContain('idx_gate_unlocks_gate_email');
  });

  it('is reversible — down removes every table it created', () => {
    const db = makeDb();
    db.exec(DOWN);
    const names = tableNames(db);
    for (const t of TABLES) expect(names).not.toContain(t);
  });

  it('down clears the migration bookkeeping so up can re-run', () => {
    const db = makeDb();
    db.exec(DOWN);
    const rows = db
      .prepare('SELECT name FROM d1_migrations WHERE name = ?')
      .all('0001_download_gates.sql');
    expect(rows).toHaveLength(0);
    // And re-applying works on the emptied database.
    expect(() => db.exec(UP)).not.toThrow();
    expect(tableNames(db)).toContain('gates');
  });

  it('touches nothing outside the gate tables', () => {
    const db = makeDb();
    // A stand-in for any pre-existing table. The store's real data lives in KV
    // and R2, but this proves the migration is purely additive.
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY, keep TEXT)');
    db.exec("INSERT INTO unrelated (keep) VALUES ('value')");
    db.exec(DOWN);
    expect(db.prepare('SELECT keep FROM unrelated').get().keep).toBe('value');
  });
});

describe('honest labelling is enforced by the database', () => {
  let db, gateId;
  beforeEach(() => {
    db = makeDb();
    gateId = insertGate(db);
  });

  // The headline guarantee. Spotify can never be verified — the Web API
  // endpoints that would answer it need Extended Quota Mode (~250k MAU plus a
  // business entity), which an independent artist will not be granted.
  it.each([
    'spotify_follow',
    'spotify_save',
    'instagram_follow',
    'tiktok_follow',
    'youtube_subscribe',
    'bandcamp_follow',
    'facebook_follow',
    'x_follow',
    'visit_link',
  ])('rejects %s claiming verification_mode = verified', type => {
    expect(() => addAction(db, gateId, { type, mode: 'verified' })).toThrow(/CHECK constraint/i);
  });

  it.each([
    'soundcloud_follow',
    'soundcloud_like',
    'soundcloud_repost',
    'soundcloud_comment',
    'email',
  ])('allows %s to be verified', type => {
    expect(() => addAction(db, gateId, { type, mode: 'verified' })).not.toThrow();
  });

  it('allows a genuinely-verifiable action to be configured as attested', () => {
    // Needed for the config flag that downgrades SoundCloud to attested if API
    // access is ever revoked.
    expect(() =>
      addAction(db, gateId, { type: 'soundcloud_follow', mode: 'attested' }),
    ).not.toThrow();
  });

  it('rejects an unknown action type outright', () => {
    expect(() => addAction(db, gateId, { type: 'myspace_follow', mode: 'attested' })).toThrow(
      /CHECK constraint/i,
    );
  });

  it.each(['trusted', 'confirmed', 'VERIFIED', 'assumed', ''])(
    'rejects %s as a verification mode',
    mode => {
      expect(() => addAction(db, gateId, { type: 'email', mode })).toThrow(/CHECK constraint/i);
    },
  );

  it('records completions only as verified or attested', () => {
    addAction(db, gateId, { type: 'email', mode: 'verified' });
    const actionId = db.prepare('SELECT id FROM gate_actions').get().id;
    db.prepare(
      `INSERT INTO gate_unlocks (gate_id, email, created_at) VALUES (?, ?, 0)`,
    ).run(gateId, 'a@b.com');
    const unlockId = db.prepare('SELECT id FROM gate_unlocks').get().id;

    const insert = mode =>
      db
        .prepare(
          `INSERT INTO gate_action_completions (unlock_id, action_id, verification_mode_used, verified_at)
           VALUES (?, ?, ?, 0)`,
        )
        .run(unlockId, actionId, mode);

    expect(() => insert('trusted')).toThrow(/CHECK constraint/i);
    expect(() => insert('attested')).not.toThrow();
  });
});

describe('data integrity', () => {
  let db, gateId;
  beforeEach(() => {
    db = makeDb();
    gateId = insertGate(db);
  });

  it('enforces one action per ordinal per gate', () => {
    addAction(db, gateId, { ordinal: 1, type: 'email', mode: 'verified' });
    expect(() =>
      addAction(db, gateId, { ordinal: 1, type: 'spotify_follow', mode: 'attested' }),
    ).toThrow(/UNIQUE constraint/i);
  });

  it('allows the same ordinal on a different gate', () => {
    const other = insertGate(db, 'other');
    addAction(db, gateId, { ordinal: 1, type: 'email', mode: 'verified' });
    expect(() => addAction(db, other, { ordinal: 1, type: 'email', mode: 'verified' })).not.toThrow();
  });

  it('enforces unique slugs', () => {
    expect(() => insertGate(db, 'g')).toThrow(/UNIQUE constraint/i);
  });

  it('allows one unlock row per person per gate, and re-unlock on another gate', () => {
    const other = insertGate(db, 'other');
    const ins = (g, e) =>
      db.prepare('INSERT INTO gate_unlocks (gate_id, email, created_at) VALUES (?, ?, 0)').run(g, e);
    ins(gateId, 'a@b.com');
    expect(() => ins(gateId, 'a@b.com')).toThrow(/UNIQUE constraint/i);
    expect(() => ins(other, 'a@b.com')).not.toThrow();
  });

  it('defaults download_count to 0 and leaves completion/consent null', () => {
    db.prepare('INSERT INTO gate_unlocks (gate_id, email, created_at) VALUES (?, ?, 0)').run(
      gateId,
      'a@b.com',
    );
    const row = db.prepare('SELECT * FROM gate_unlocks').get();
    expect(row.download_count).toBe(0);
    // Double opt-in: an unlock is not complete until the email is confirmed.
    expect(row.email_confirmed_at).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.marketing_consent_at).toBeNull();
  });

  it('cascades deletes from a gate to its actions, unlocks and completions', () => {
    addAction(db, gateId, { type: 'email', mode: 'verified' });
    const actionId = db.prepare('SELECT id FROM gate_actions').get().id;
    db.prepare('INSERT INTO gate_unlocks (gate_id, email, created_at) VALUES (?, ?, 0)').run(
      gateId,
      'a@b.com',
    );
    const unlockId = db.prepare('SELECT id FROM gate_unlocks').get().id;
    db.prepare(
      `INSERT INTO gate_action_completions (unlock_id, action_id, verification_mode_used, verified_at)
       VALUES (?, ?, 'verified', 0)`,
    ).run(unlockId, actionId);

    db.prepare('DELETE FROM gates WHERE id = ?').run(gateId);

    expect(db.prepare('SELECT COUNT(*) c FROM gate_actions').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM gate_unlocks').get().c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM gate_action_completions').get().c).toBe(0);
  });

  it('rejects an action pointing at a gate that does not exist', () => {
    expect(() => addAction(db, 9999, { type: 'email', mode: 'verified' })).toThrow(/FOREIGN KEY/i);
  });

  it('constrains event types to the tracked funnel steps', () => {
    const ins = type =>
      db
        .prepare('INSERT INTO gate_events (gate_id, type, created_at) VALUES (?, ?, 0)')
        .run(gateId, type);
    for (const t of [
      'gate_view',
      'action_started',
      'action_completed',
      'action_failed',
      'email_submitted',
      'email_confirmed',
      'unlock_completed',
      'download_delivered',
    ]) {
      expect(() => ins(t)).not.toThrow();
    }
    expect(() => ins('something_else')).toThrow(/CHECK constraint/i);
  });
});

describe('the seeded example gate', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
    db.exec(SEED);
  });

  it('applies cleanly and is idempotent', () => {
    expect(() => db.exec(SEED)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) c FROM gates WHERE slug='example-pack'").get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM gate_actions').get().c).toBe(7);
  });

  it('labels SoundCloud and email verified, and Spotify/Instagram attested', () => {
    const modes = Object.fromEntries(
      db.prepare('SELECT type, verification_mode FROM gate_actions').all().map(r => [r.type, r.verification_mode]),
    );
    expect(modes.soundcloud_follow).toBe('verified');
    expect(modes.soundcloud_like).toBe('verified');
    expect(modes.soundcloud_repost).toBe('verified');
    expect(modes.soundcloud_comment).toBe('verified');
    expect(modes.email).toBe('verified');
    expect(modes.spotify_follow).toBe('attested');
    expect(modes.instagram_follow).toBe('attested');
  });

  it('stores the file under the gates/ prefix', () => {
    const g = db.prepare("SELECT file_storage_key FROM gates WHERE slug='example-pack'").get();
    expect(g.file_storage_key).toMatch(/^gates\/example-pack\//);
  });
});

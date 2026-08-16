/**
 * Minimal D1Database shim over node:sqlite, covering only the surface
 * functions/_lib/community/repo.ts actually uses.
 *
 * D1 statements are immutable - .bind() returns a NEW statement rather than
 * mutating the receiver - so this returns fresh objects too. Getting that
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

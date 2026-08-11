import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { MIGRATIONS } from "./migrations";

export type Db = Database.Database;

/**
 * Where the memory lives. Outside the repo by default so it cannot be committed
 * and survives deleting the checkout.
 */
export function defaultDbPath(): string {
  return process.env.ZEUS_DB ?? join(homedir(), ".zeus", "zeus.db");
}

/** ISO-8601 UTC, the single timestamp format used throughout the store. */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Open (and migrate) the store.
 *
 * The Next.js server and the MCP server are separate processes against the same file,
 * so WAL plus a generous busy timeout is what keeps concurrent access from throwing
 * SQLITE_BUSY. `foreign_keys` is per-connection and off by default — the whole
 * provenance design rests on it, so it is set here rather than assumed.
 */
export function openDb(path: string = defaultDbPath()): Db {
  const isMemory = path === ":memory:";
  if (!isMemory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const db = new Database(path);

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  migrate(db);

  if (!isMemory) {
    // The most sensitive file the user owns. Owner-only, best effort —
    // some filesystems (e.g. mounted volumes) silently ignore this.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch {
        // File may not exist yet (-wal/-shm) or the FS may not support modes.
      }
    }
  }

  return db;
}

/** Apply any migrations this database has not seen, each in its own transaction. */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare<[], { id: string }>("SELECT id FROM schema_migration")
      .all()
      .map((row) => row.id),
  );

  const record = db.prepare<[string, string]>(
    "INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, now());
    })();
  }
}

/**
 * A throwaway in-memory store, fully migrated. Used by tests so no suite can
 * ever touch the real memory.
 */
export function openTestDb(): Db {
  return openDb(":memory:");
}

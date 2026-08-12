import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { MIGRATIONS, type Migration } from "./migrations";

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
  // Overwrite deleted cell payloads on every writable connection. Explicit source
  // erasure additionally VACUUMs and truncates the WAL, but this protects ordinary
  // deletes and rollback/error paths from leaving cleartext in reusable pages.
  db.pragma("secure_delete = ON");
  db.pragma("synchronous = NORMAL");

  migrate(db);
  enableFtsSecureDeletion(db);

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

function enableFtsSecureDeletion(db: Db): void {
  for (const table of ["fact_fts", "message_fts", "passage_fts", "facet_fts"] as const) {
    db.exec(`INSERT INTO ${table} (${table}, rank) VALUES ('secure-delete', 1)`);
  }
}

/** Serialize and atomically apply every migration this database has not seen. */
export function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  // One writer reservation covers pending detection, backup, and application. A
  // second Zeus process waits at BEGIN IMMEDIATE, then rechecks the ledger instead
  // of racing the same DDL or taking a backup of a half-migrated schema.
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureZeusApplicationId(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        id          TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL
      );
    `);
    const applied = appliedMigrationLedger(db);
    validateMigrationLedger(applied, migrations);
    const pending = migrations.slice(applied.length);
    if (pending.length === 0) {
      db.exec("COMMIT");
      return;
    }

    if (!db.memory && applied.length > 0 && statSync(databaseFilePath(db)).size > 0) {
      createVerifiedPreMigrationBackup(db, applied);
    }

    const record = db.prepare<[string, string]>(
      "INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)",
    );
    for (const migration of pending) {
      db.exec(migration.sql);
      record.run(migration.id, now());
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

const MIGRATION_BACKUP_MARKER = ".pre-migration-";
const MIGRATION_BACKUP_SUFFIX = ".backup";
// ASCII "ZEUS". SQLite reserves application_id for formats owned by applications.
const ZEUS_APPLICATION_ID = 0x5a455553;

/**
 * Return only non-symlink SQLite backups carrying the Zeus application marker, a
 * passing integrity check, and a migration ledger that is an exact prefix of this
 * build. A filename alone never grants deletion authority.
 */
export function listManagedMigrationBackups(databasePath: string): string[] {
  if (databasePath === ":memory:") return [];
  const exactPath = resolve(databasePath);
  const directory = dirname(exactPath);
  const prefix = `${basename(exactPath)}${MIGRATION_BACKUP_MARKER}`;
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(MIGRATION_BACKUP_SUFFIX))
      .map((name) => join(directory, name))
      .filter((path) => {
        try {
          const entry = lstatSync(path);
          return (
            entry.isFile() &&
            !entry.isSymbolicLink() &&
            isVerifiedManagedMigrationBackup(path)
          );
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Purge only validated Zeus-managed backups for the exact database path. */
export function purgeManagedMigrationBackups(databasePath: string): number {
  const backups = listManagedMigrationBackups(databasePath);
  for (const backup of backups) rmSync(backup);
  return backups.length;
}

function createVerifiedPreMigrationBackup(db: Db, applied: readonly string[]): string {
  const databasePath = databaseFilePath(db);
  const directory = dirname(databasePath);
  const label = new Date().toISOString().replaceAll(":", "-");
  const finalPath = join(
    directory,
    `${basename(databasePath)}${MIGRATION_BACKUP_MARKER}${label}-${randomUUID()}${MIGRATION_BACKUP_SUFFIX}`,
  );
  const temporaryPath = `${finalPath}.tmp`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);

  try {
    // serialize() uses SQLite's snapshot machinery and includes committed WAL pages.
    // The outer writer reservation prevents another migration or application write
    // between this snapshot and the subsequent schema changes.
    writeFileSync(descriptor, db.serialize());
    fsyncSync(descriptor);
    closeSync(descriptor);
    chmodSync(temporaryPath, 0o600);
    verifyMigrationBackup(temporaryPath, applied);
    renameSync(temporaryPath, finalPath);
    chmodSync(finalPath, 0o600);
    syncDirectory(directory);
    return finalPath;
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // It was already closed after the write.
    }
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function databaseFilePath(db: Db): string {
  const databases = db.pragma("database_list") as Array<{ name: string; file: string }>;
  const main = databases.find((entry) => entry.name === "main");
  if (!main?.file) throw new Error("Cannot resolve the on-disk Zeus database path.");
  return resolve(main.file);
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function verifyMigrationBackup(path: string, expectedApplied: readonly string[]): void {
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`Pre-migration backup failed integrity_check: ${String(integrity)}`);
    }
    if ((backup.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error("Pre-migration backup failed foreign_key_check.");
    }
    if (backup.pragma("application_id", { simple: true }) !== ZEUS_APPLICATION_ID) {
      throw new Error("Pre-migration backup is missing the Zeus application marker.");
    }
    const backedUp = appliedMigrationLedger(backup);
    if (
      backedUp.length !== expectedApplied.length ||
      backedUp.some((id, index) => id !== expectedApplied[index])
    ) {
      throw new Error("Pre-migration backup does not match the source migration ledger.");
    }
  } finally {
    backup.close();
  }
}

function isVerifiedManagedMigrationBackup(path: string): boolean {
  let backup: Database.Database | null = null;
  try {
    backup = new Database(path, { readonly: true, fileMustExist: true });
    if (backup.pragma("application_id", { simple: true }) !== ZEUS_APPLICATION_ID) return false;
    if (backup.pragma("integrity_check", { simple: true }) !== "ok") return false;
    if ((backup.pragma("foreign_key_check") as unknown[]).length > 0) return false;
    const ledger = backup
      .prepare<[], { id: string }>("SELECT id FROM schema_migration ORDER BY rowid")
      .all()
      .map((row) => row.id);
    if (ledger.length === 0 || ledger.length > MIGRATIONS.length) return false;
    return ledger.every((id, index) => id === MIGRATIONS[index]?.id);
  } catch {
    return false;
  } finally {
    backup?.close();
  }
}

function ensureZeusApplicationId(db: Db): void {
  const current = db.pragma("application_id", { simple: true });
  if (current === ZEUS_APPLICATION_ID) return;
  if (current !== 0) {
    throw new Error("Database application_id belongs to another application.");
  }
  db.pragma(`application_id = ${ZEUS_APPLICATION_ID}`);
}

function appliedMigrationLedger(db: Db): string[] {
  return db
    .prepare<[], { id: string }>("SELECT id FROM schema_migration ORDER BY rowid")
    .all()
    .map((row) => row.id);
}

function validateMigrationLedger(
  applied: readonly string[],
  migrations: readonly Migration[],
): void {
  const configuredIds = migrations.map((migration) => migration.id);
  const duplicate = configuredIds.find((id, index) => configuredIds.indexOf(id) !== index);
  if (duplicate) throw new Error(`Migration list contains duplicate id: ${duplicate}`);
  if (
    applied.length > configuredIds.length ||
    applied.some((id, index) => id !== configuredIds[index])
  ) {
    throw new Error(
      "Database migration ledger is not an exact ordered prefix of this Zeus build.",
    );
  }
}

/**
 * A throwaway in-memory store, fully migrated. Used by tests so no suite can
 * ever touch the real memory.
 */
export function openTestDb(): Db {
  return openDb(":memory:");
}

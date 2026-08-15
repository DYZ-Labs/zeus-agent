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
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { MIGRATIONS, type Migration } from "./migrations";
import { errorSignature, logEvent, type ZeusEvent } from "./observability";

export type Db = Database.Database;

/**
 * Where the memory lives. Outside the repo by default so it cannot be committed
 * and survives deleting the checkout.
 */
export function defaultDbPath(): string {
  return process.env.ZEUS_DB ?? join(homedir(), ".zeus", "zeus.db");
}

/**
 * How hard SQLite works to survive a host failure.
 *
 * WAL with `synchronous=NORMAL` does not fsync on commit: a process crash is safe
 * because the WAL is already written, but a host crash or power loss can lose the most
 * recently committed transactions — the last facts a user just watched Zeus learn.
 * `FULL` fsyncs each commit and survives that.
 *
 * Measured on this write path: 0.06ms/commit at NORMAL against 0.14ms at FULL, with no
 * measurable difference for rows written inside one transaction, where fsync happens
 * once per commit rather than once per row. A chat turn makes a handful of commits and
 * is dominated by a multi-second model call, so the durability is close to free.
 *
 * Left configurable because that measurement is from macOS, whose fsync does not force
 * a drive cache flush the way Linux does, and because network-attached storage can make
 * fsync markedly slower. `ZEUS_SYNCHRONOUS=normal` reverts without a code change.
 */
export type SynchronousSetting = "full" | "normal";

export function configuredSynchronous(): SynchronousSetting {
  const raw = process.env.ZEUS_SYNCHRONOUS?.trim().toLowerCase();
  if (!raw) return "full";
  if (raw !== "full" && raw !== "normal") {
    throw new Error("ZEUS_SYNCHRONOUS must be 'full' or 'normal'");
  }
  return raw;
}

/**
 * Fold the write-ahead log back into the database.
 *
 * PASSIVE never waits for a reader, so it is safe while requests are in flight;
 * TRUNCATE additionally empties the WAL file but needs exclusive access, which is only
 * reasonable from a background task. Returns false when SQLite reported it was busy.
 */
export function checkpointWal(db: Db, mode: "PASSIVE" | "TRUNCATE" = "PASSIVE"): boolean {
  if (db.memory) return true;
  try {
    const result = db.pragma(`wal_checkpoint(${mode})`) as Array<{ busy: number }>;
    return result[0]?.busy === 0;
  } catch {
    // A checkpoint is maintenance; failing one must never propagate to a caller.
    return false;
  }
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
  db.pragma(`synchronous = ${configuredSynchronous()}`);

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

/**
 * Why a migration stopped, in a fixed vocabulary an operator can act on.
 *
 * These call for different responses and the log may never quote the error text that
 * would otherwise tell them apart. A ledger that is not a prefix of this build means the
 * deploy went backwards: the store is ahead of the code, and the fix is to roll the code
 * forward again, never to touch the store. A refused backup means the volume is out of
 * room, which is fixed on the host and will recur on every deploy until it is. A dangling
 * reference means provenance did not survive the schema change — on a hosted deployment,
 * one account unable to load their memory while everyone else is fine.
 *
 * Each step records what a failure from that point on means, because once the error is in
 * hand nothing but its message distinguishes them.
 */
type MigrationFailure =
  | "reservation_failed"
  | "store_not_zeus"
  | "ledger_unreadable"
  | "ledger_mismatch"
  | "backup_space"
  | "backup_failed"
  | "apply_failed"
  | "dangling_references"
  | "commit_failed";

/** Serialize and atomically apply every migration this database has not seen. */
export function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  // SQLite cannot relax a CHECK in place, so a migration that needs one rebuilds the
  // table. Left to its defaults, RENAME repoints every existing REFERENCES clause at the
  // legacy copy, and the following DROP then cascades the referencing rows away — which
  // is how a table swap silently destroys provenance. Suspending enforcement and
  // restoring the pre-3.25 RENAME semantics together keeps those clauses naming the
  // table that is about to reappear. Both pragmas are per-connection and no-ops inside a
  // transaction, so they are set outside it and always restored.
  //
  // The `foreign_key_check` before COMMIT is strictly safer than what came before: no
  // migration was previously verified for dangling references at all.
  const enforcedForeignKeys = db.pragma("foreign_keys", { simple: true }) === 1;
  const legacyAlterTable = db.pragma("legacy_alter_table", { simple: true });
  if (enforcedForeignKeys) db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");

  // An in-memory store is created, migrated from empty, and discarded inside a single
  // process: it has no path, no operator, and nothing anyone can act on later. Reporting
  // one would add two lines for every test and every scratch database, which is how the
  // one migration that does matter gets lost.
  const reportable = !db.memory;
  const origin: MigrationStore = reportable ? migrationStoreKind(db) : {};
  const startedAt = Date.now();
  let pendingCount = 0;
  // Nothing has been attempted yet but taking the reservation, and on a hosted deployment
  // that is the likeliest failure of the lot: a deploy migrating while the MCP process, the
  // snapshot scheduler, and every account's first request want the same writer. Named for
  // what it is, because `reason` is the field an operator groups on, and reporting lock
  // contention as a store that is not Zeus sends them to inspect the wrong thing entirely.
  let failure: MigrationFailure = "reservation_failed";
  try {
    // One writer reservation covers pending detection, backup, and application. A
    // second Zeus process waits at BEGIN IMMEDIATE, then rechecks the ledger instead
    // of racing the same DDL or taking a backup of a half-migrated schema.
    db.exec("BEGIN IMMEDIATE");
    try {
      failure = "store_not_zeus";
      ensureZeusApplicationId(db);
      failure = "ledger_unreadable";
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migration (
          id          TEXT PRIMARY KEY,
          applied_at  TEXT NOT NULL
        );
      `);
      const applied = appliedMigrationLedger(db);
      failure = "ledger_mismatch";
      validateMigrationLedger(applied, migrations);
      const pending = migrations.slice(applied.length);
      if (pending.length === 0) {
        // Nothing is reported from here: an up-to-date store is every ordinary open, and
        // an event per connection would bury the one migration that changed something.
        failure = "commit_failed";
        db.exec("COMMIT");
        return;
      }
      pendingCount = pending.length;
      // Written from inside the reservation, before the first schema change, because a
      // migration that never returns — killed mid-deploy, or still queued behind another
      // writer — is exactly the incident this line exists to explain, and a line written
      // afterwards cannot describe one.
      if (reportable) {
        reportMigration({ event: "migration_started", ...origin, count: pendingCount });
      }

      failure = "backup_failed";
      if (!db.memory && applied.length > 0 && statSync(databaseFilePath(db)).size > 0) {
        const databasePath = databaseFilePath(db);
        // Prune before writing rather than after. Stale copies are the likeliest reason
        // a volume is short of room, and the new backup needs that room now; keeping
        // retention-1 leaves exactly `retention` once this migration's copy lands.
        // Verification makes this list expensive, which is affordable here because a
        // migration is rare — never do it on an ordinary open.
        pruneManagedMigrationBackups(databasePath, configuredMigrationBackupRetention() - 1);
        // Held apart from every other backup failure: a full volume is fixed on the host
        // rather than in the store, and it is the one that repeats on every deploy.
        failure = "backup_space";
        assertRoomForMigrationBackup(databasePath);
        failure = "backup_failed";
        createVerifiedPreMigrationBackup(db, applied);
      }

      failure = "apply_failed";
      const record = db.prepare<[string, string]>(
        "INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)",
      );
      for (const migration of pending) {
        db.exec(migration.sql);
        record.run(migration.id, now());
      }
      failure = "dangling_references";
      if (enforcedForeignKeys) assertNoDanglingReferences(db);
      failure = "commit_failed";
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (reportable) {
      reportMigration({
        event: "migration_failed",
        outcome: "error",
        reason: failure,
        ...origin,
        // A failure before the work was counted has no count. Zero would read as
        // "nothing was pending", which is a different incident entirely.
        count: pendingCount > 0 ? pendingCount : null,
        duration_ms: Date.now() - startedAt,
        ...errorSignature(error),
      });
    }
    throw error;
  } finally {
    db.pragma(`legacy_alter_table = ${legacyAlterTable === 1 ? "ON" : "OFF"}`);
    if (enforcedForeignKeys) db.pragma("foreign_keys = ON");
  }

  // Only ever reached once the transaction has committed, so a store is never reported
  // as migrated before it is.
  if (reportable) {
    reportMigration({
      event: "migration_applied",
      outcome: "ok",
      ...origin,
      count: pendingCount,
      // Measured from entry, so the wait for another process's writer reservation is
      // part of what an operator sees: a slow migration and a queued one look identical
      // from the outside and are fixed differently.
      duration_ms: Date.now() - startedAt,
    });
  }
}

/**
 * Describe a migration without ever becoming the reason one failed.
 *
 * The start line is written from inside the writer reservation, where an exception would
 * abort the very transaction it is describing. Nothing about writing a diagnostic to
 * stderr may cost a store its schema change: a closed pipe on a redirected log is not a
 * reason to leave a database half-migrated.
 */
function reportMigration(event: ZeusEvent): void {
  try {
    logEvent(event);
  } catch {
    // A migration that succeeds unobserved beats one that fails observed.
  }
}

/**
 * The sibling directory a multi-account deployment gives each account's store. Named
 * here only to label an event; `listStores` owns the layout itself, and cannot be
 * imported back into the module it is built on.
 */
const ACCOUNT_STORE_DIRECTORY = "accounts";

/**
 * Which store this is, in the two words the log has for them.
 *
 * The path itself is never logged: it ends in an account's UUID on a hosted deployment
 * and sits under somebody's home directory on a laptop. The layout is what separates
 * them — one primary store, and one database per account in a sibling directory beside
 * it — so the parent directory answers the question without quoting any of it.
 */
type MigrationStore = { store?: "primary" | "account"; account?: string };

function migrationStoreKind(db: Db): MigrationStore {
  try {
    const path = databaseFilePath(db);
    if (basename(dirname(path)) !== ACCOUNT_STORE_DIRECTORY) return { store: "primary" };
    // Which account, not merely that it was one. "One account cannot open their memory"
    // and "every account is broken" are the same line without it, and that is the first
    // question an incident raises.
    //
    // The file name is the account's own pseudonymous UUID, which is exactly what the
    // `account` field carries elsewhere — and core cannot ask `owner.ts` for it, because
    // owner.ts imports `now` from this module and the back-import would cycle in the one
    // module every entry point loads first. Reading it off the path needs no import at
    // all. A directory holding something that is not a UUID cannot leak a name through
    // this field either: the allowlist's pattern rejects it and reports `invalid`.
    return { store: "account", account: basename(path, ".db") };
  } catch {
    // Labelling is not worth failing a migration over, and an unlabelled event still
    // reports that a migration happened.
    return {};
  }
}

/**
 * Fail the whole migration rather than commit a store whose provenance links are broken.
 * Every guarantee Zeus makes about evidence depends on these references resolving.
 */
function assertNoDanglingReferences(db: Db): void {
  const violations = db.pragma("foreign_key_check") as Array<{ table?: unknown }>;
  if (violations.length === 0) return;
  const tables = [
    ...new Set(
      violations.map((row) => (typeof row.table === "string" ? row.table : "unknown")),
    ),
  ].sort();
  throw new Error(
    `Migration left dangling references in: ${tables.join(", ")}`,
  );
}

const MIGRATION_BACKUP_MARKER = ".pre-migration-";
const MIGRATION_BACKUP_SUFFIX = ".backup";
/**
 * How many pre-migration copies to keep per store. Each is a full copy of the database
 * on the same volume as the data it protects, so an unbounded series eventually fills
 * the disk and blocks the very migration that would fix it. Three covers a rollback
 * across a couple of releases, which is the window these copies actually serve.
 */
export const DEFAULT_MIGRATION_BACKUP_RETENTION = 3;
/** Room for the copy's own overhead and the migration that follows it. */
const MIGRATION_BACKUP_HEADROOM_BYTES = 16 * 1024 * 1024;
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

/**
 * Keep only the newest `retention` validated backups for this database.
 *
 * Backup names embed a UTC ISO timestamp, so the validated list sorts oldest-first and
 * the tail is the set worth keeping. Only validated backups are eligible for deletion:
 * a filename alone never grants deletion authority, which is also why an unreadable
 * copy is left in place for an operator to look at rather than quietly removed.
 */
export function pruneManagedMigrationBackups(
  databasePath: string,
  retention: number,
): number {
  const keep = Math.max(0, Math.trunc(retention));
  const backups = listManagedMigrationBackups(databasePath);
  const expired = backups.slice(0, Math.max(0, backups.length - keep));
  for (const backup of expired) rmSync(backup, { force: true });
  return expired.length;
}

export function configuredMigrationBackupRetention(): number {
  const raw = process.env.ZEUS_MIGRATION_BACKUP_RETENTION?.trim();
  if (!raw) return DEFAULT_MIGRATION_BACKUP_RETENTION;
  if (!/^\d+$/u.test(raw)) {
    throw new Error("ZEUS_MIGRATION_BACKUP_RETENTION must be a positive integer");
  }
  const value = Number(raw);
  // At least one: a store must never be configured out of its own rollback path.
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("ZEUS_MIGRATION_BACKUP_RETENTION must be between 1 and 1000");
  }
  return value;
}

/**
 * Refuse to start a backup that cannot finish.
 *
 * The backup is taken inside the migration's writer reservation and before any schema
 * change, so a disk-full failure mid-write aborts the migration — and the volume stays
 * full, so the next deploy fails the same way. Checking first turns an obscure partial
 * write into an operator-actionable message while the store is still untouched.
 */
function assertRoomForMigrationBackup(databasePath: string): void {
  const required = statSync(databasePath).size + MIGRATION_BACKUP_HEADROOM_BYTES;
  let available: number;
  try {
    const volume = statfsSync(dirname(databasePath));
    available = volume.bavail * volume.bsize;
  } catch {
    // statfs is not available everywhere. The backup verifies itself before it is
    // published, so losing an early warning is not a reason to block a migration.
    return;
  }
  if (available >= required) return;
  throw new Error(
    `Not enough free space to back up ${basename(databasePath)} before migrating: ` +
      `${megabytes(available)} available, ${megabytes(required)} required. Free space on ` +
      "this volume and restart. Zeus does not migrate without a pre-migration backup.",
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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

export function databaseFilePath(db: Db): string {
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

type DatabaseCopyLedgerMode = "exact" | "prefix";

/**
 * Verify that a SQLite copy is a structurally sound Zeus store with the expected
 * migration history. Migration backups and scheduled snapshots deliberately share
 * this boundary so neither path can weaken provenance checks to integrity_check alone.
 */
export function verifyDatabaseCopy(
  path: string,
  expectedApplied: readonly string[],
  description = "Database copy",
  ledgerMode: DatabaseCopyLedgerMode = "exact",
): void {
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`${description} failed integrity_check: ${String(integrity)}`);
    }
    if ((backup.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error(`${description} failed foreign_key_check.`);
    }
    if (backup.pragma("application_id", { simple: true }) !== ZEUS_APPLICATION_ID) {
      throw new Error(`${description} is missing the Zeus application marker.`);
    }
    const backedUp = appliedMigrationLedger(backup);
    const ledgerMatches =
      ledgerMode === "exact"
        ? backedUp.length === expectedApplied.length &&
          backedUp.every((id, index) => id === expectedApplied[index])
        : backedUp.length > 0 &&
          backedUp.length <= expectedApplied.length &&
          backedUp.every((id, index) => id === expectedApplied[index]);
    if (!ledgerMatches) {
      const relationship = ledgerMode === "exact" ? "match" : "precede";
      throw new Error(`${description} migration ledger does not ${relationship} the source.`);
    }
  } finally {
    backup.close();
  }
}

/** Verify a copy that may have been created by an older compatible Zeus build. */
export function verifyRestorableDatabaseCopy(path: string): void {
  verifyDatabaseCopy(
    path,
    MIGRATIONS.map((migration) => migration.id),
    "Zeus database copy",
    "prefix",
  );
}

function verifyMigrationBackup(path: string, expectedApplied: readonly string[]): void {
  verifyDatabaseCopy(path, expectedApplied, "Pre-migration backup");
}

function isVerifiedManagedMigrationBackup(path: string): boolean {
  try {
    verifyRestorableDatabaseCopy(path);
    return true;
  } catch {
    return false;
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

export function appliedMigrationLedger(db: Db): string[] {
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

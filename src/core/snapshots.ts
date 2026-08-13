import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";

import {
  appliedMigrationLedger,
  databaseFilePath,
  defaultDbPath,
  now,
  type Db,
  verifyDatabaseCopy,
} from "./db";
import {
  SnapshotDestination,
  type SnapshotDestination as SnapshotDestinationRow,
} from "./schema";

export const DEFAULT_SNAPSHOT_RETENTION = 14;
export const DEFAULT_SNAPSHOT_HOUR = 3;

const SNAPSHOT_MARKER = ".zeus-snapshot-";
const SNAPSHOT_SUFFIX = ".db";
const LOCK_RETRY_LIMIT = 600;
const LOCK_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export type SnapshotOptions = {
  directory?: string;
  retention?: number;
  createdAt?: Date;
};

export type SnapshotResult = {
  path: string;
  pruned: number;
};

/** Resolve the configured snapshot directory without creating it. */
export function defaultSnapshotDirectory(databasePath: string = defaultDbPath()): string {
  if (databasePath === ":memory:") {
    throw new Error("Cannot configure snapshots for an in-memory database");
  }
  const configured = process.env.ZEUS_SNAPSHOT_DIR?.trim();
  return validateSnapshotDirectoryPath(
    normalize(
      requireAbsolutePath(
        configured || join(dirname(requireAbsolutePath(databasePath)), "snapshots"),
      ),
    ),
  );
}

export function configuredSnapshotRetention(): number {
  return parseIntegerSetting(
    process.env.ZEUS_SNAPSHOT_RETENTION,
    DEFAULT_SNAPSHOT_RETENTION,
    "ZEUS_SNAPSHOT_RETENTION",
    1,
    10_000,
  );
}

export function configuredSnapshotHour(): number {
  return parseIntegerSetting(
    process.env.ZEUS_SNAPSHOT_HOUR,
    DEFAULT_SNAPSHOT_HOUR,
    "ZEUS_SNAPSHOT_HOUR",
    0,
    23,
  );
}

/**
 * Create a transactionally consistent SQLite copy without checkpointing or pausing
 * another WAL connection. The copy is published only after the same verification
 * boundary used for pre-migration backups passes against the live source ledger.
 */
export function createVerifiedSnapshot(db: Db, options: SnapshotOptions = {}): SnapshotResult {
  if (db.memory) throw new Error("Cannot snapshot an in-memory database");
  if (db.inTransaction) {
    throw new Error("Cannot create a snapshot while a database transaction is active");
  }

  const sourcePath = databaseFilePath(db);
  const expectedLedger = appliedMigrationLedger(db);
  if (expectedLedger.length === 0) {
    throw new Error("Cannot snapshot a Zeus database without a migration ledger");
  }
  const directory = prepareSnapshotDirectory(
    options.directory ?? defaultSnapshotDirectory(sourcePath),
  );
  const retention = validateRetention(options.retention ?? configuredSnapshotRetention());
  const timestamp = (options.createdAt ?? new Date()).toISOString().replaceAll(":", "-");
  const prefix = snapshotPrefix(sourcePath);
  const finalPath = join(directory, `${prefix}${timestamp}-${randomUUID()}${SNAPSHOT_SUFFIX}`);
  const temporaryPath = `${finalPath}.tmp`;
  const lockPath = snapshotLockPath(sourcePath);

  const releaseLock = acquireSnapshotLock(lockPath);
  try {
    registerSnapshotDestination(db, directory, prefix);
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    closeSync(descriptor);
    let published = false;
    try {
      // VACUUM INTO uses SQLite's online snapshot machinery. In WAL mode it includes
      // committed pages without copying a live -wal/-shm pair and excludes uncommitted
      // changes from another connection.
      db.prepare("VACUUM main INTO ?").run(temporaryPath);
      chmodSync(temporaryPath, 0o600);
      syncFile(temporaryPath);
      verifyDatabaseCopy(temporaryPath, expectedLedger, "Snapshot");
      renameSync(temporaryPath, finalPath);
      published = true;
      chmodSync(finalPath, 0o600);
      syncDirectory(directory);

      const pruned = pruneManagedSnapshots(db, directory, retention);
      return { path: finalPath, pruned };
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      // A verified copy that was already atomically published remains useful even if
      // directory fsync or later retention fails. Surface the failure so the scheduler
      // can report it; a future run can safely include the copy in retention.
      if (!published) rmSync(finalPath, { force: true });
      throw error;
    }
  } finally {
    releaseLock();
  }
}

/** List only regular, verified snapshots belonging to this exact database path. */
export function listManagedSnapshots(db: Db, directory?: string): string[] {
  if (db.memory) return [];
  const sourcePath = databaseFilePath(db);
  const requestedDirectory = validateSnapshotDirectoryPath(
    normalize(requireAbsolutePath(directory ?? defaultSnapshotDirectory(sourcePath))),
  );
  const prefix = snapshotPrefix(sourcePath);
  const expectedLedger = appliedMigrationLedger(db);
  if (expectedLedger.length === 0) return [];

  if (!existsSync(requestedDirectory)) return [];
  const exactDirectory = canonicalSnapshotDirectory(requestedDirectory);
  assertSnapshotDirectory(exactDirectory);
  return readdirSync(exactDirectory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(SNAPSHOT_SUFFIX))
    .map((name) => join(exactDirectory, name))
    .filter((path) => isManagedSnapshot(path, expectedLedger))
    .sort();
}

/** Purge source-scoped artifacts from one or every registered recovery boundary. */
export function purgeManagedSnapshots(db: Db, directory?: string): number {
  if (db.memory) return 0;
  const sourcePath = databaseFilePath(db);
  const releaseLock = acquireSnapshotLock(snapshotLockPath(sourcePath));
  try {
    if (directory) {
      const exactDirectory = canonicalSnapshotDirectory(
        validateSnapshotDirectoryPath(normalize(requireAbsolutePath(directory))),
      );
      const destination = registeredSnapshotDestination(
        db,
        exactDirectory,
        snapshotPrefix(sourcePath),
      );
      assertRegisteredDestinationAvailable(exactDirectory, destination);
      return purgeSnapshotArtifacts(destination);
    }
    assertRegisteredSnapshotDestinationsAvailable(db);
    return purgeRegisteredSnapshotArtifacts(db);
  } finally {
    releaseLock();
  }
}

/**
 * Coordinate explicit erasure with every snapshot process before any source row is
 * removed. Registered destinations are checked while the source-wide lock is held.
 */
export function withSnapshotErasureLock<T>(db: Db, callback: () => T): T {
  if (db.memory) return callback();
  const releaseLock = acquireSnapshotLock(snapshotLockPath(databaseFilePath(db)));
  try {
    assertRegisteredSnapshotDestinationsAvailable(db);
    return callback();
  } finally {
    releaseLock();
  }
}

/** Erasure-only helper; the caller must hold `withSnapshotErasureLock`. */
export function purgeManagedSnapshotsWhileErasureLocked(db: Db): number {
  if (db.memory) return 0;
  assertRegisteredSnapshotDestinationsAvailable(db);
  return purgeRegisteredSnapshotArtifacts(db);
}

function pruneManagedSnapshots(db: Db, directory: string, retention: number): number {
  const snapshots = listManagedSnapshots(db, directory);
  const expired = snapshots.slice(0, Math.max(0, snapshots.length - retention));
  for (const snapshot of expired) rmSync(snapshot);
  if (expired.length > 0) syncDirectory(directory);
  return expired.length;
}

function registerSnapshotDestination(db: Db, directory: string, filePrefix: string): void {
  const deviceId = snapshotDeviceId(directory);
  const existing = db
    .prepare<[string, string], SnapshotDestinationRow>(
      `SELECT directory, file_prefix, device_id, registered_at
       FROM snapshot_destination WHERE directory = ? AND file_prefix = ?`,
    )
    .get(directory, filePrefix);
  if (existing) {
    const destination = SnapshotDestination.parse(existing);
    if (destination.device_id !== deviceId) {
      throw new Error(
        "Snapshot destination filesystem identity changed; restore the original mounted target before continuing",
      );
    }
    return;
  }
  db.prepare<[string, string, string, string]>(
    `INSERT INTO snapshot_destination
       (directory, file_prefix, device_id, registered_at)
     VALUES (?, ?, ?, ?)`,
  ).run(directory, filePrefix, deviceId, now());
}

function registeredSnapshotDestinations(db: Db): SnapshotDestinationRow[] {
  return db
    .prepare<[], SnapshotDestinationRow>(
      `SELECT directory, file_prefix, device_id, registered_at
       FROM snapshot_destination ORDER BY directory, file_prefix`,
    )
    .all()
    .map((row) => SnapshotDestination.parse(row));
}

function assertRegisteredSnapshotDestinationsAvailable(db: Db): void {
  for (const destination of registeredSnapshotDestinations(db)) {
    assertRegisteredDestinationAvailable(destination.directory, destination);
  }
}

function registeredSnapshotDestination(
  db: Db,
  directory: string,
  filePrefix: string,
): SnapshotDestinationRow {
  const row = db
    .prepare<[string, string], SnapshotDestinationRow>(
      `SELECT directory, file_prefix, device_id, registered_at
       FROM snapshot_destination WHERE directory = ? AND file_prefix = ?`,
    )
    .get(directory, filePrefix);
  if (!row) throw new Error("Snapshot destination is not registered for this Zeus store");
  return SnapshotDestination.parse(row);
}

function assertRegisteredDestinationAvailable(
  directory: string,
  destination: SnapshotDestinationRow,
): void {
  if (!existsSync(directory)) {
    throw new Error(`Registered snapshot destination is unavailable: ${directory}`);
  }
  assertSnapshotDirectory(directory);
  if (snapshotDeviceId(directory) !== destination.device_id) {
    throw new Error(`Registered snapshot destination filesystem changed: ${directory}`);
  }
  // Force an access check before explicit erasure commits any row deletion.
  readdirSync(directory);
}

function purgeRegisteredSnapshotArtifacts(db: Db): number {
  let purged = 0;
  for (const destination of registeredSnapshotDestinations(db)) {
    purged += purgeSnapshotArtifacts(destination);
  }
  return purged;
}

function purgeSnapshotArtifacts(destination: SnapshotDestinationRow): number {
  const artifacts = readdirSync(destination.directory)
    .filter(
      (name) =>
        name.startsWith(destination.file_prefix) &&
        (name.endsWith(SNAPSHOT_SUFFIX) || name.endsWith(`${SNAPSHOT_SUFFIX}.tmp`)),
    )
    .map((name) => join(destination.directory, name))
    .filter((path) => {
      const entry = lstatSync(path);
      return entry.isFile() && !entry.isSymbolicLink();
    });
  for (const artifact of artifacts) rmSync(artifact);
  if (artifacts.length > 0) syncDirectory(destination.directory);
  return artifacts.length;
}

function snapshotDeviceId(directory: string): string {
  return statSync(directory, { bigint: true }).dev.toString();
}

function isManagedSnapshot(path: string, expectedLedger: readonly string[]): boolean {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    verifyDatabaseCopy(path, expectedLedger, "Managed snapshot", "prefix");
    return true;
  } catch {
    return false;
  }
}

function snapshotPrefix(databasePath: string): string {
  const exactPath = normalize(requireAbsolutePath(databasePath));
  const identity = createHash("sha256").update(exactPath).digest("hex").slice(0, 16);
  return `${basename(databasePath)}${SNAPSHOT_MARKER}${identity}-`;
}

function prepareSnapshotDirectory(path: string): string {
  const directory = validateSnapshotDirectoryPath(normalize(requireAbsolutePath(path)));
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = canonicalSnapshotDirectory(directory);
  assertSnapshotDirectory(canonical);
  // Full database copies are as sensitive as the live store. Owner-only permissions
  // are best effort on mounted filesystems that may not implement POSIX modes.
  if (!existed) {
    try {
      chmodSync(canonical, 0o700);
    } catch {
      // Verification and file-level mode enforcement still apply below.
    }
  }
  return canonical;
}

function canonicalSnapshotDirectory(directory: string): string {
  return validateSnapshotDirectoryPath(realpathSync(directory));
}

function requireAbsolutePath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Snapshot paths must be absolute");
  return path;
}

function assertSnapshotDirectory(directory: string): void {
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Snapshot destination must be a regular directory, not a symbolic link");
  }
}

function validateSnapshotDirectoryPath(directory: string): string {
  if (directory === parse(directory).root) {
    throw new Error("Snapshot destination cannot be a filesystem root");
  }
  return directory;
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function snapshotLockPath(databasePath: string): string {
  return `${databasePath}.zeus-snapshot.lock`;
}

function acquireSnapshotLock(lockPath: string): () => void {
  let retries = 0;
  while (true) {
    try {
      // O_EXCL create-if-absent semantics refuse an existing symlink. Snapshot
      // creation and explicit erasure coordinate on this source-wide file.
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      syncFile(lockPath);
      break;
    } catch (error) {
      if (isAlreadyExists(error) && recoverStaleSnapshotLock(lockPath)) continue;
      if (!isAlreadyExists(error) || retries >= LOCK_RETRY_LIMIT) {
        throw new Error("Could not acquire the snapshot maintenance lock", { cause: error });
      }
      retries += 1;
      sleepForLock();
    }
  }

  return () => {
    rmSync(lockPath, { force: true });
    syncDirectory(dirname(lockPath));
  };
}

function recoverStaleSnapshotLock(lockPath: string): boolean {
  try {
    const entry = lstatSync(lockPath);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    if (snapshotLockOwnerIsAlive(lockPath) && Date.now() - entry.mtimeMs < LOCK_STALE_AFTER_MS) {
      return false;
    }
    rmSync(lockPath);
    syncDirectory(dirname(lockPath));
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

function snapshotLockOwnerIsAlive(lockPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return false;
    try {
      process.kill(parsed.pid as number, 0);
      return true;
    } catch (error) {
      return !isMissingProcess(error);
    }
  } catch {
    return false;
  }
}

function sleepForLock(): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, 50);
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

function validateRetention(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Snapshot retention must be an integer between 1 and 10000");
  }
  return value;
}

function parseIntegerSetting(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

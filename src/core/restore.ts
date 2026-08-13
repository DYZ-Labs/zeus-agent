import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, normalize, resolve } from "node:path";

import { verifyRestorableDatabaseCopy } from "./db";

/**
 * Put a verified copy back.
 *
 * Snapshots and pre-migration backups were only ever half a recovery story: nothing
 * could install one. A backup that has never been restored is a hope, not a plan, so
 * this is deliberately the boring, reversible half — it verifies before and after, it
 * never deletes the store it replaces, and it refuses to run while a writer holds the
 * target.
 */

/** SQLite sidecars that belong to the *outgoing* database and must not survive it. */
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export type RestorePlan = {
  target: string;
  source: string;
  targetExists: boolean;
  /** Existing `-wal`/`-shm` files that would be moved aside with the old store. */
  sidecars: string[];
};

export type RestoreResult = Omit<RestorePlan, "sidecars"> & {
  /** Where the replaced store was kept, or null when the target did not exist. */
  preserved: string | null;
  /** Sidecars actually moved, which the plan can only estimate in advance. */
  sidecars: string[];
};

/**
 * Validate a restore without changing anything. The source is fully verified here, so
 * a dry run proves the copy is usable rather than merely present.
 */
export function planRestore(targetPath: string, sourcePath: string): RestorePlan {
  const target = exactPath(targetPath);
  const source = exactPath(sourcePath);

  if (target === source) {
    throw new Error("The restore source and target are the same file");
  }
  if (!isRegularFile(source)) {
    throw new Error(`Restore source is not a regular file: ${source}`);
  }
  const directory = dirname(target);
  if (!isDirectory(directory)) {
    // Mirrors the hosted-store startup check: a missing parent usually means the
    // volume is not mounted, and creating it would restore onto disposable storage.
    throw new Error(
      `The restore target directory ${directory} does not exist. Zeus will not create ` +
        "it: on a hosted deployment a missing directory usually means the persistent " +
        "volume is not mounted.",
    );
  }

  // Verify before touching anything, so an unusable copy cannot displace a live store.
  verifyRestorableDatabaseCopy(source);

  const targetExists = existsSync(target);
  if (targetExists && !isRegularFile(target)) {
    throw new Error(`Restore target is not a regular file: ${target}`);
  }

  return {
    target,
    source,
    targetExists,
    sidecars: SIDECAR_SUFFIXES.map((suffix) => `${target}${suffix}`).filter((path) =>
      existsSync(path),
    ),
  };
}

/**
 * Install a verified copy at the target path.
 *
 * The replaced store is renamed aside rather than deleted, because an operator running
 * this is already having a bad day and the previous file may still be the only copy of
 * something. Its `-wal`/`-shm` sidecars move with it: leaving a stale write-ahead log
 * beside a restored database invites SQLite to replay one store's pages into another.
 */
export function restoreDatabaseCopy(
  targetPath: string,
  sourcePath: string,
  options: { label?: string } = {},
): RestoreResult {
  const plan = planRestore(targetPath, sourcePath);
  assertNoLiveWriter(plan.target);

  const label = options.label ?? new Date().toISOString().replaceAll(":", "-");
  const staged = `${plan.target}.zeus-restore-${randomUUID()}.tmp`;

  copyFileSync(plan.source, staged);
  try {
    // The restored file is a complete cleartext copy of the store. Set the mode
    // explicitly rather than inheriting the snapshot's and hoping umask cooperates.
    chmodSync(staged, 0o600);
    syncFile(staged);
    // Verify the staged copy too: the source passed, but a short read, a full disk, or
    // a truncated write would otherwise be discovered only by the next reader.
    verifyRestorableDatabaseCopy(staged);

    let preserved: string | null = null;
    const moved: string[] = [];
    if (existsSync(plan.target)) {
      preserved = `${plan.target}.pre-restore-${label}`;
      if (existsSync(preserved)) {
        throw new Error(`A preserved store already exists at ${preserved}`);
      }
      renameSync(plan.target, preserved);
      // Re-resolve rather than trusting the plan: the writer probe above opens the
      // target, and closing it checkpoints the WAL away, so a sidecar listed at plan
      // time may legitimately be gone. That checkpoint is welcome — it folds pending
      // pages into the file that is about to be preserved.
      for (const suffix of SIDECAR_SUFFIXES) {
        const sidecar = `${plan.target}${suffix}`;
        if (!existsSync(sidecar)) continue;
        renameSync(sidecar, `${preserved}${suffix}`);
        moved.push(sidecar);
      }
    }

    renameSync(staged, plan.target);
    syncDirectory(dirname(plan.target));
    // Prove the installed file, not the staged one: this is the artifact that will be
    // served, and a rename is the last place a filesystem can surprise us.
    verifyRestorableDatabaseCopy(plan.target);

    return { ...plan, preserved, sidecars: moved };
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

/**
 * Refuse to restore under a running Zeus. `BEGIN IMMEDIATE` takes the same writer
 * reservation the app takes, so a busy result means a live process would keep writing
 * into the store being replaced.
 */
function assertNoLiveWriter(target: string): void {
  if (!existsSync(target)) return;
  let db: Database.Database;
  try {
    db = new Database(target, { fileMustExist: true });
  } catch {
    // An unreadable or non-SQLite target is replaced wholesale; nothing to reserve.
    return;
  }
  try {
    // Fail fast instead of waiting out the application's five-second busy timeout.
    db.pragma("busy_timeout = 250");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } catch {
    throw new Error(
      `Another process is writing to ${basename(target)}. Stop the Zeus web server, ` +
        "MCP server, and any scheduled job before restoring.",
    );
  } finally {
    db.close();
  }
}

function exactPath(path: string): string {
  if (!path.trim()) throw new Error("A restore path is required");
  return resolve(normalize(path));
}

function isRegularFile(path: string): boolean {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r+");
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

import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

import { defaultDbPath, openDb } from "../src/core/db";
import {
  configuredSnapshotRetention,
  createVerifiedSnapshot,
  defaultSnapshotDirectory,
} from "../src/core/snapshots";
import { listStores, storeLabel, type StoreLocation } from "../src/core/stores";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment(resolve(import.meta.dirname, ".."));

// `--db` names the *primary* store and every account store beside it is included.
// The installed LaunchAgent already passes `--db`, so keeping that meaning is what
// makes an existing scheduled job start covering accounts without being reinstalled.
// `--only` is the escape hatch for operating on a single store deliberately.
const primaryPath = resolve(option("--db") ?? defaultDbPath());
const directory = resolve(option("--directory") ?? defaultSnapshotDirectory(primaryPath));
const retention = option("--retention")
  ? parseRetention(option("--retention")!)
  : configuredSnapshotRetention();

assertExistingRegularDatabase(primaryPath);
const stores = process.argv.includes("--only")
  ? [{ path: primaryPath, kind: "primary", account: null } satisfies StoreLocation]
  : listStores(primaryPath);

// Snapshots are name-scoped by a hash of their source path, so every store shares one
// directory without pruning another's copies — one directory to replicate off-machine.
let failed = 0;
for (const store of stores) {
  try {
    const db = openDb(store.path);
    try {
      const result = createVerifiedSnapshot(db, { directory, retention });
      // Paths and counts are safe operational metadata; never print database contents.
      process.stdout.write(
        `${storeLabel(store)}: created ${result.path}; pruned ${result.pruned}.\n`,
      );
    } finally {
      db.close();
    }
  } catch (error) {
    // One unreadable store must not deprive every other account of a backup. Report,
    // continue, and fail the run at the end so a scheduler still sees the error.
    failed += 1;
    process.exitCode = 1;
    process.stderr.write(
      `${storeLabel(store)}: snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

process.stdout.write(
  `Snapshotted ${stores.length - failed} of ${stores.length} store${
    stores.length === 1 ? "" : "s"
  } into ${directory}.\n`,
);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseRetention(raw: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error("--retention must be a positive integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("--retention must be an integer between 1 and 10000");
  }
  return value;
}

function assertExistingRegularDatabase(path: string): void {
  if (!existsSync(path)) throw new Error(`Zeus database does not exist: ${path}`);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("Zeus database path must be a regular file, not a symbolic link");
  }
}

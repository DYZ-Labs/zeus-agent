import { resolve } from "node:path";

import { defaultDbPath } from "../src/core/db";
import { restoreDatabaseCopy, planRestore } from "../src/core/restore";
import { defaultSnapshotDirectory, listRestorableSnapshots } from "../src/core/snapshots";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment(resolve(import.meta.dirname, ".."));

const USAGE = `Restore a verified Zeus snapshot over a store.

  npm run restore -- --list
  npm run restore -- --from <snapshot.db> [--db <target.db>] --yes
  npm run restore -- --latest [--db <target.db>] --yes

  --db <path>        Store to restore (default: ZEUS_DB, else ~/.zeus/zeus.db)
  --from <path>      Exact snapshot to install
  --latest           Use the newest verified snapshot for this store
  --directory <path> Snapshot directory (default: beside the primary store)
  --list             Show verified snapshots and exit
  --yes              Perform the restore; without it this is a dry run

Stop the web server, MCP server, and any scheduled job first. The replaced store is
renamed aside, never deleted.
`;

const target = resolve(option("--db") ?? defaultDbPath());
const directory = resolve(
  option("--directory") ?? defaultSnapshotDirectory(defaultDbPath()),
);

if (process.argv.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const available = listRestorableSnapshots(target, directory);

if (process.argv.includes("--list")) {
  if (available.length === 0) {
    process.stdout.write(`No verified snapshots for ${target} in ${directory}.\n`);
  } else {
    process.stdout.write(`Verified snapshots for ${target} (oldest first):\n`);
    for (const path of available) process.stdout.write(`  ${path}\n`);
  }
  process.exit(0);
}

const explicit = option("--from");
if (!explicit && !process.argv.includes("--latest")) {
  process.stderr.write(USAGE);
  throw new Error("Choose a snapshot with --from <path> or --latest");
}
const source = explicit ? resolve(explicit) : newestSnapshot();

// Verification happens here, so a dry run proves the copy is usable rather than merely
// present — the failure mode worth catching before an operator commits to a restore.
const plan = planRestore(target, source);

if (!process.argv.includes("--yes")) {
  process.stdout.write(
    `Dry run. ${source}\n  verified, and would replace ${target}\n` +
      (plan.targetExists
        ? `  the current store would be preserved beside it${
            plan.sidecars.length > 0 ? `, with ${plan.sidecars.length} WAL/SHM sidecar(s)` : ""
          }\n`
        : "  no store exists at the target yet\n") +
      "Re-run with --yes to perform the restore.\n",
  );
  process.exit(0);
}

const result = restoreDatabaseCopy(target, source);
process.stdout.write(`Restored ${result.source}\n  to ${result.target}\n`);
process.stdout.write(
  result.preserved
    ? `  previous store preserved at ${result.preserved}\n`
    : "  no previous store to preserve\n",
);

function newestSnapshot(): string {
  const newest = available.at(-1);
  if (!newest) {
    throw new Error(`No verified snapshot for ${target} in ${directory}`);
  }
  return newest;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

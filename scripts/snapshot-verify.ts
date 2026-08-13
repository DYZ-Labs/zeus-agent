import { lstatSync } from "node:fs";
import { resolve } from "node:path";

import { verifyRestorableDatabaseCopy } from "../src/core/db";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: npm run snapshot:verify -- /absolute/path/to/snapshot");

const path = resolve(argument);
const entry = lstatSync(path);
if (!entry.isFile() || entry.isSymbolicLink()) {
  throw new Error("Snapshot must be a regular file, not a symbolic link");
}
verifyRestorableDatabaseCopy(path);
process.stdout.write(`Verified restorable Zeus snapshot: ${path}\n`);

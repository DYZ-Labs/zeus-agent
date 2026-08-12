import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

import { defaultDbPath, openDb } from "../src/core/db";
import { prepareExportWorkspace, writePrivateFile } from "../src/core/export-files";
import { generateExportEntries } from "../src/core/export-generator";
import { collectSqliteExport } from "../src/core/export-sqlite";

process.umask(0o077);
const requestedOutDir = process.argv[2] ?? "zeus-export";
const dbPath = defaultDbPath();
const workspace = prepareExportWorkspace(requestedOutDir, { sourceDbPath: dbPath });
process.once("exit", () => workspace.cleanup());
const db = openDb(dbPath);

try {
  for (const entry of generateExportEntries(collectSqliteExport(db))) {
    const target = join(workspace.path, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writePrivateFile(target, entry.content);
  }
  workspace.finish();
  console.log(`Exported Zeus data to ${workspace.destination}`);
} finally {
  db.close();
}

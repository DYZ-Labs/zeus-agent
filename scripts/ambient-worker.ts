import { runAmbientEvaluation } from "../src/core/ambient";
import { openDb } from "../src/core/db";
import { MacOsNotifier } from "../src/core/macos-notifier";

const databaseFlag = process.argv.indexOf("--db");
const databasePath = databaseFlag >= 0 ? process.argv[databaseFlag + 1] : undefined;
if (databaseFlag >= 0 && !databasePath) {
  throw new Error("The ambient worker requires a value after --db");
}
const db = openDb(databasePath);
try {
  const result = runAmbientEvaluation(db, new MacOsNotifier());
  // Never print recommendation or memory text from a background process.
  process.stdout.write(`${result.status}\n`);
} finally {
  db.close();
}

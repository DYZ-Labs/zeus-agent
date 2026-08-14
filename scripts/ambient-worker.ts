import { runAmbientEvaluation } from "../src/core/ambient";
import { refreshExternalSignals } from "../src/core/ambient";
import { openDb } from "../src/core/db";
import { MacOsNotifier } from "../src/core/macos-notifier";

const databaseFlag = process.argv.indexOf("--db");
const databasePath = databaseFlag >= 0 ? process.argv[databaseFlag + 1] : undefined;
if (databaseFlag >= 0 && !databasePath) {
  throw new Error("The ambient worker requires a value after --db");
}
const db = openDb(databasePath);
try {
  // Refresh the connected calendar and re-run the detectors before deciding whether to
  // interrupt. Both steps are deterministic and make no model call, so a timer can drive
  // them without spending money or reasoning unsupervised about the user's day.
  await refreshExternalSignals(db);
  const result = runAmbientEvaluation(db, new MacOsNotifier());
  // Never print recommendation or memory text from a background process.
  process.stdout.write(`${result.status}\n`);
} finally {
  db.close();
}

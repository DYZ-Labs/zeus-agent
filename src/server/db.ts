import "server-only";

import { migrate, openDb, type Db } from "@/core/db";
import { MIGRATIONS } from "@/core/migrations";
import { assertSqliteDeploymentSafe } from "@/server/deployment";
import { wakeMemoryJobRunner } from "@/server/memory-job-runner";

/**
 * One database handle per server process.
 *
 * Cached on globalThis because Next's dev server re-evaluates modules on every hot
 * reload; without this each edit would leak another SQLite connection to the same file.
 */
const globalForDb = globalThis as unknown as {
  zeusDb?: Db;
  zeusLatestMigrationId?: string;
};

export function getDb(): Db {
  assertSqliteDeploymentSafe();
  const latestMigrationId = MIGRATIONS.at(-1)?.id;

  if (!globalForDb.zeusDb) {
    globalForDb.zeusDb = openDb();
    globalForDb.zeusLatestMigrationId = latestMigrationId;
  } else if (globalForDb.zeusLatestMigrationId !== latestMigrationId) {
    // The connection survives Next.js hot reloads, but the migration list may not.
    // Re-run the idempotent migration check when a newer app version is loaded.
    migrate(globalForDb.zeusDb);
    globalForDb.zeusLatestMigrationId = latestMigrationId;
  }

  // Every local server entrypoint passes through this handle, so process restart and
  // stale-job recovery do not depend on the originating chat tab being reopened.
  wakeMemoryJobRunner(globalForDb.zeusDb);
  return globalForDb.zeusDb;
}

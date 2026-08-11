import "server-only";

import type { Db } from "@/core/db";
import { openDb } from "@/core/db";

/**
 * One database handle per server process.
 *
 * Cached on globalThis because Next's dev server re-evaluates modules on every hot
 * reload; without this each edit would leak another SQLite connection to the same file.
 */
const globalForDb = globalThis as unknown as { zeusDb?: Db };

export function getDb(): Db {
  globalForDb.zeusDb ??= openDb();
  return globalForDb.zeusDb;
}

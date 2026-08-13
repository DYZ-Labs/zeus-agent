import "server-only";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { databaseFilePath, migrate, openDb, type Db } from "@/core/db";
import { MIGRATIONS } from "@/core/migrations";
import { getAppOwner } from "@/core/owner";
import { z } from "zod";

const AccountIdentity = z
  .object({
    supabaseUserId: z.string().trim().toLowerCase().uuid(),
    email: z.string().trim().toLowerCase().email(),
    legacyOwnerEmail: z.string().trim().toLowerCase().email().nullable(),
  })
  .strict();

export type AccountIdentity = z.infer<typeof AccountIdentity>;

type CachedDb = {
  db: Db;
  latestMigrationId: string | undefined;
};

/**
 * One database handle per server process.
 *
 * Cached on globalThis because Next's dev server re-evaluates modules on every hot
 * reload; without this each edit would leak another SQLite connection to the same file.
 */
const globalForDb = globalThis as unknown as {
  zeusDb?: Db;
  zeusLatestMigrationId?: string;
  zeusAccountDbs?: Map<string, CachedDb>;
};

export function getDb(): Db {
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

  return globalForDb.zeusDb;
}

/**
 * Resolve one authenticated account to one personal Zeus store.
 *
 * The original database remains attached to its immutable owner. An unbound legacy
 * database can be claimed only by the explicitly configured legacy email; every other
 * verified account receives a fresh UUID-named database in the sibling accounts/
 * directory. A web deployment can therefore serve multiple people without ever mixing
 * their evidence, conversations, or derived memory in shared tables.
 */
export function getAccountDb(identity: AccountIdentity): Db {
  const parsed = AccountIdentity.parse(identity);
  const primaryDb = getDb();
  const primaryPath = databaseFilePath(primaryDb);
  const path = accountDbPath(primaryDb, parsed, primaryPath);
  if (path === primaryPath) return primaryDb;

  const latestMigrationId = MIGRATIONS.at(-1)?.id;
  const accountDbs = (globalForDb.zeusAccountDbs ??= new Map());
  const cached = accountDbs.get(path);
  if (!cached) {
    const db = openDb(path);
    accountDbs.set(path, { db, latestMigrationId });
    return db;
  }
  if (cached.latestMigrationId !== latestMigrationId) {
    migrate(cached.db);
    cached.latestMigrationId = latestMigrationId;
  }
  return cached.db;
}

/**
 * Whether this identity already has a store on disk, answered without creating one.
 *
 * Establishing a new store is precisely the allocation the signup allowlist gates, so
 * this check must never be the thing that performs it. `getAccountDb` opens and
 * migrates; this only resolves a path and asks the filesystem.
 */
export function accountDbExists(identity: AccountIdentity): boolean {
  // turbopackIgnore: the path is resolved at runtime from the configured store, so
  // there is nothing for the bundler's file tracer to follow.
  return existsSync(/* turbopackIgnore: true */ accountDbPath(getDb(), identity));
}

/** Pure path selection kept exported so the legacy-routing safety policy is testable. */
export function accountDbPath(
  primaryDb: Db,
  identity: AccountIdentity,
  primaryPath: string = databaseFilePath(primaryDb),
): string {
  const parsed = AccountIdentity.parse(identity);
  const owner = getAppOwner(primaryDb);
  if (
    owner?.supabase_user_id === parsed.supabaseUserId ||
    (!owner &&
      parsed.legacyOwnerEmail !== null &&
      parsed.email === parsed.legacyOwnerEmail)
  ) {
    return primaryPath;
  }
  return join(dirname(primaryPath), "accounts", `${parsed.supabaseUserId}.db`);
}

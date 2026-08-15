import "server-only";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { databaseFilePath, migrate, openDb, type Db } from "@/core/db";
import { MIGRATIONS } from "@/core/migrations";
import { errorSignature, logEvent } from "@/core/observability";
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
    const db = openAccountStore(path, parsed.supabaseUserId);
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
 * Open one account's store, and say so the first time this process does.
 *
 * A deploy migrates the primary store while the health check is still running, and every
 * other account's store on that account's next request — which may be days later, in a
 * process nobody is watching. The deploy is therefore called healthy on the strength of
 * one store, and without this line nothing anywhere records how much of the fleet has
 * actually reached the new schema, or that one account cannot open theirs at all while
 * everyone else is fine. It costs one line per account per process: an ordinary request
 * reuses the cached handle and says nothing.
 *
 * The account's own pseudonymous UUID, already validated as one, is what identifies it.
 * The path it came from is deliberately not logged — that is the same id inside a
 * directory a person named.
 */
function openAccountStore(path: string, account: string): Db {
  const startedAt = Date.now();
  try {
    const db = openDb(path);
    logEvent({
      event: "store_opened",
      outcome: "ok",
      store: "account",
      account,
      // Cold-open cost, migration included, which is the only place the lazy per-account
      // migration shows up as latency somebody paid for.
      duration_ms: Date.now() - startedAt,
    });
    return db;
  } catch (error) {
    // Which account cannot load their memory is the first question an incident raises,
    // and `migrate()` cannot answer it: a store whose schema is too old to hold an owner
    // row has nothing to attribute itself with. Here the identity is already known.
    logEvent({
      event: "store_open_failed",
      outcome: "error",
      store: "account",
      account,
      duration_ms: Date.now() - startedAt,
      ...errorSignature(error),
    });
    throw error;
  }
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

/**
 * Every store this process currently holds open.
 *
 * Deliberately does not open anything: maintenance should act on the handles that
 * already exist, not create work by touching stores nobody has asked for.
 */
export function openStoreHandles(): Db[] {
  const handles: Db[] = [];
  if (globalForDb.zeusDb) handles.push(globalForDb.zeusDb);
  for (const cached of globalForDb.zeusAccountDbs?.values() ?? []) {
    handles.push(cached.db);
  }
  return handles;
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

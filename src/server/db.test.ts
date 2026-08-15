import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openTestDb, type Db } from "@/core/db";
import { bindAppOwner } from "@/core/owner";
import { accountDbPath, getAccountDb, openStoreHandles } from "./db";

const LEGACY_ID = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const OTHER_ID = "12f81434-e99b-4208-a1a2-0a216579e393";
const PRIMARY_PATH = "/var/lib/zeus/zeus.db";

const temporaryDirectories: string[] = [];
let deployment: string;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  deployment = mkdtempSync(join(tmpdir(), "zeus-server-db-"));
  temporaryDirectories.push(deployment);
  // A real primary store on disk: resolving an account's path asks the primary store
  // where it lives, which an in-memory database cannot answer.
  vi.stubEnv("ZEUS_DB", join(deployment, "zeus.db"));
});

afterEach(() => {
  closeCachedStores();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("account database routing", () => {
  it("reserves an unbound legacy database for its configured email", () => {
    const primary = openTestDb();

    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: LEGACY_ID,
          email: "owner@example.com",
          legacyOwnerEmail: "owner@example.com",
        },
        PRIMARY_PATH,
      ),
    ).toBe(PRIMARY_PATH);
    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: OTHER_ID,
          email: "other@example.com",
          legacyOwnerEmail: "owner@example.com",
        },
        PRIMARY_PATH,
      ),
    ).toBe(`/var/lib/zeus/accounts/${OTHER_ID}.db`);
  });

  it("keeps a bound legacy database with its UUID and isolates every other UUID", () => {
    const primary = openTestDb();
    bindAppOwner(primary, {
      supabaseUserId: LEGACY_ID,
      email: "owner@example.com",
    });

    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: LEGACY_ID,
          email: "renamed@example.com",
          legacyOwnerEmail: null,
        },
        PRIMARY_PATH,
      ),
    ).toBe(PRIMARY_PATH);
    expect(
      accountDbPath(
        primary,
        {
          supabaseUserId: OTHER_ID,
          email: "owner@example.com",
          legacyOwnerEmail: "owner@example.com",
        },
        PRIMARY_PATH,
      ),
    ).toBe(`/var/lib/zeus/accounts/${OTHER_ID}.db`);
  });

  it("rejects an identity that cannot safely become a database filename", () => {
    const primary = openTestDb();

    expect(() =>
      accountDbPath(
        primary,
        {
          supabaseUserId: "../../shared",
          email: "other@example.com",
          legacyOwnerEmail: null,
        },
        PRIMARY_PATH,
      ),
    ).toThrow();
  });
});

// Only the primary store is migrated by the deploy that ships a schema change. Every
// other account's store is opened and migrated on that account's next request, which can
// be days later, so these are the lines an operator counts to see how much of the fleet
// has actually arrived.
describe("account stores warming up", () => {
  const identity = {
    supabaseUserId: OTHER_ID,
    email: "other@example.com",
    legacyOwnerEmail: null,
  };

  it("reports the first time this process opens an account's store", () => {
    getAccountDb(identity);

    const account = emittedEvents().filter((event) => event.store === "account");
    expect(account.map((event) => event.event)).toEqual([
      // The lazy migration and the open that triggered it, in one uninterrupted run:
      // opening a store is entirely synchronous, so no other account can appear between
      // these lines and steal the attribution.
      "migration_started",
      "migration_applied",
      "store_opened",
    ]);
    expect(account.at(-1)).toEqual({
      event: "store_opened",
      outcome: "ok",
      store: "account",
      account: OTHER_ID,
      duration_ms: expect.any(Number),
    });
  });

  it("says nothing on the requests that follow, because the handle is already open", () => {
    getAccountDb(identity);
    forgetEvents();

    getAccountDb(identity);

    expect(emittedEvents()).toEqual([]);
  });

  it("names the account whose memory will not load", () => {
    // The store's own name, taken by a directory: unopenable, and only for this account.
    mkdirSync(join(deployment, "accounts", `${OTHER_ID}.db`), { recursive: true });

    expect(() => getAccountDb(identity)).toThrow();

    // The primary store migrated perfectly a moment earlier, which is precisely the
    // incident: everyone else is fine.
    expect(emittedEvents().filter((event) => event.store === "account")).toEqual([
      {
        event: "store_open_failed",
        outcome: "error",
        store: "account",
        account: OTHER_ID,
        duration_ms: expect.any(Number),
        error_name: "SqliteError",
        error_code: "SQLITE_CANTOPEN",
        error_site: expect.stringMatching(/^src\/(?:core|server)\/db\.ts:\d+$/u),
      },
    ]);
  });

  it("never writes where any of it lives", () => {
    mkdirSync(join(deployment, "accounts", `${LEGACY_ID}.db`), { recursive: true });
    getAccountDb(identity);
    expect(() =>
      getAccountDb({ ...identity, supabaseUserId: LEGACY_ID }),
    ).toThrow();

    const events = emittedEvents();
    // Anchored before the absence is asserted: an empty array contains no path either, so
    // on its own the check below would survive the events being removed entirely.
    expect(events.map((event) => event.event)).toContain("store_open_failed");
    expect(events.map((event) => event.event)).toContain("store_opened");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(deployment);
    expect(serialized).not.toContain(tmpdir());
    // The account UUID is allowlisted and pseudonymous; the file named after it is not.
    expect(serialized).not.toContain(`${OTHER_ID}.db`);
  });
});

function emittedEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
}

/** Discard what opening the deployment emitted; the assertions are about what follows. */
function forgetEvents(): void {
  vi.mocked(console.error).mockClear();
}

/**
 * The handles `getDb` and `getAccountDb` deliberately keep for the life of a process.
 * A test that inherited the previous test's would be resolving paths inside a directory
 * that no longer exists.
 */
function closeCachedStores(): void {
  const cache = globalThis as unknown as {
    zeusDb?: Db;
    zeusLatestMigrationId?: string;
    zeusAccountDbs?: Map<string, { db: Db }>;
  };
  for (const db of openStoreHandles()) db.close();
  cache.zeusDb = undefined;
  cache.zeusLatestMigrationId = undefined;
  cache.zeusAccountDbs = undefined;
}

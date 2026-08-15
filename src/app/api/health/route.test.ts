import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  embeddingStatus: vi.fn(),
  hasCredentials: vi.fn(),
  getAuthConfiguration: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/core/embed", () => ({ embeddingStatus: mocks.embeddingStatus }));
vi.mock("@/core/openai", () => ({ hasCredentials: mocks.hasCredentials }));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: mocks.getAuthConfiguration,
}));

import { migrate, openDb, openTestDb } from "@/core/db";
import { MIGRATIONS } from "@/core/migrations";
import {
  replicateSnapshot,
  resetSnapshotReplication,
} from "@/core/snapshot-replication";
import { createVerifiedSnapshot, listRestorableSnapshots } from "@/core/snapshots";
import {
  resetSnapshotScheduler,
  SNAPSHOT_STALE_GRACE_HOURS,
  startSnapshotScheduler,
} from "@/server/snapshot-scheduler";
import { GET } from "./route";

const ACCOUNT = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const OTHER_ACCOUNT = "019ff233-1a4c-7b81-9f0e-6d7c2b51aa90";
const temporaryDirectories: string[] = [];

/**
 * The probe cache, cleared between tests.
 *
 * It is deliberately keyed on nothing: one process serves one deployment, so there is
 * nothing to key it on. That makes clearing it here part of the setup rather than a
 * missing feature.
 */
const globalForProbe = globalThis as typeof globalThis & {
  zeusHealthStoreProbe?: unknown;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete globalForProbe.zeusHealthStoreProbe;
  mocks.getDb.mockReturnValue(openTestDb());
  mocks.embeddingStatus.mockReturnValue("ready");
  mocks.hasCredentials.mockReturnValue(true);
  mocks.getAuthConfiguration.mockReturnValue({ mode: "configured" });
  // Pinned *unset* rather than pinned to a path: the endpoint has to resolve the
  // documented default the same way the scheduler does, and inheriting whichever value
  // started vitest would make that agreement accidental.
  vi.stubEnv("ZEUS_SNAPSHOT_DIR", undefined);
});

afterEach(() => {
  resetSnapshotScheduler();
  resetSnapshotReplication();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A request the way one actually arrives, because the verdict depends on it.
 *
 * The Host is the authority the caller reached this deployment under, and in local mode
 * that is the difference between a workstation serving itself and a public deployment
 * answering 403 to everyone. Defaulted to the loopback authority the README tells people
 * to use.
 */
function probe(host = "127.0.0.1:3000"): Request {
  return new Request("http://127.0.0.1:3000/api/health", { headers: { host } });
}

/** A deployment on disk: a real primary store with a real accounts directory beside it. */
function deployment(): { primary: string; accounts: string; snapshots: string } {
  const base = mkdtempSync(join(tmpdir(), "zeus-health-"));
  temporaryDirectories.push(base);
  const primary = join(base, "zeus.db");
  openDb(primary).close();
  const accounts = join(base, "accounts");
  mkdirSync(accounts);
  vi.stubEnv("ZEUS_DB", primary);
  return { primary, accounts, snapshots: join(base, "snapshots") };
}

/** The structured events this request wrote, read back off the stderr stream. */
function loggedEvents(): Record<string, unknown>[] {
  return vi.mocked(console.error).mock.calls.flatMap((call) => {
    try {
      return [JSON.parse(String(call[0])) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/**
 * A store held open by another writer, the way `npm run snapshot`'s VACUUM INTO and a
 * confirmed source deletion's VACUUM hold one, from a process this one cannot hurry.
 */
function heldByAnotherWriter(path: string): Database.Database {
  openDb(path).close();
  const writer = new Database(path);
  writer.pragma("locking_mode = EXCLUSIVE");
  writer.exec("CREATE TABLE zeus_health_probe_lock (x)");
  return writer;
}

describe("health check", () => {
  it("reports the schema version and subsystem state when the store opens", async () => {
    const response = await GET(probe());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      store: {
        status: "ok",
        migrations_applied: MIGRATIONS.length,
        migrations_expected: MIGRATIONS.length,
        // Fault counts, never a list and never a census.
        unopenable: 0,
        behind: 0,
        unmeasured: 0,
      },
      auth: "configured",
      embeddings: "ready",
      model: "configured",
      // A backup that quietly stopped is the failure the subsystem exists to prevent.
      snapshots: {
        state: "not_started",
        intervalHours: null,
        lastResult: null,
        lastRunAt: null,
        freshness: { state: "not_applicable", oldestAgeHours: null },
      },
      // ...and a copy that never leaves the volume it protects is the other half of it.
      replication: {
        state: "not_configured",
        lastResult: null,
        lastReason: null,
        lastAttemptAt: null,
      },
    });
  });

  it("surfaces a scheduler that has stopped backing stores up", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "off");
    startSnapshotScheduler();

    const body = await (await GET(probe())).json();

    // Still serving, so still 200 — but the backups are visibly not running.
    expect(body.status).toBe("ok");
    expect(body.snapshots.state).toBe("disabled");
  });

  it("degrades on a scheduler with nowhere to write, with no store on disk to disprove it", async () => {
    // An in-memory store has nothing to copy, so the freshness reading answers
    // "not_applicable" and never touches the directory. The scheduler's own state is the
    // only thing left that knows this deployment can never produce a backup.
    vi.stubEnv("ZEUS_DB", ":memory:");
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    startSnapshotScheduler();

    const response = await GET(probe());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.snapshots).toMatchObject({
      state: "misconfigured",
      freshness: { state: "not_applicable" },
    });
    // A body that said "ok" while carrying "misconfigured" inside it contradicts itself,
    // and the contradiction resolves in favour of the reassuring half.
    expect(loggedEvents()).toContainEqual(
      expect.objectContaining({
        event: "health_check",
        reason: "snapshot_directory_unresolved",
      }),
    );
  });

  it("surfaces a snapshot copy that never made it off the volume", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_REPLICA_COMMAND", "/nonexistent/zeus-replica-tool");
    await replicateSnapshot("/var/tmp/zeus-snapshot-never-copied.db");

    const body = await (await GET(probe())).json();

    // Still serving, so still 200 — but the only copy of the store is on one volume.
    expect(body.status).toBe("ok");
    expect(body.replication).toMatchObject({
      state: "configured",
      lastResult: "failed",
      lastReason: "command_missing",
    });
    // The configured command and the snapshot path stay out of an unauthenticated body.
    expect(JSON.stringify(body)).not.toContain("zeus-replica-tool");
    expect(JSON.stringify(body)).not.toContain("zeus-snapshot-never-copied");
  });

  it("fails with 503 when the store cannot be opened", async () => {
    // The case the check exists for: the process is listening, the volume is not there.
    mocks.getDb.mockImplementation(() => {
      throw new Error("unable to open database file: /data/zeus.db");
    });

    const response = await GET(probe());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.store).toMatchObject({
      status: "error",
      migrations_applied: null,
      unopenable: 1,
    });
    // A path is operational detail, but the message may not be ours to repeat.
    expect(JSON.stringify(body)).not.toContain("/data/zeus.db");
    expect(body.store.error_name).toBe("Error");
  });

  it("reports an account store that cannot be opened without pulling the deployment", async () => {
    const { accounts } = deployment();
    openDb(join(accounts, `${ACCOUNT}.db`)).close();
    // A file that exists but is not a database: enumerated, then unopenable — and every
    // private route belonging to that one person fails while the check said 200.
    writeFileSync(join(accounts, `${OTHER_ACCOUNT}.db`), "not a database");

    const response = await GET(probe());
    const body = await response.json();

    // 200 on purpose. This endpoint gates deployment promotion, and rolling back does not
    // repair a corrupt volume: failing here would retire a working deployment, keep the
    // broken tenant broken, and block the deploy that fixes it.
    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.store).toMatchObject({ status: "degraded", unopenable: 1 });
    // Counts only: neither the account nor the path it lives at is anyone's business.
    expect(JSON.stringify(body)).not.toContain(OTHER_ACCOUNT);
    expect(JSON.stringify(body)).not.toContain(accounts);
  });

  it("reports faults without publishing how many people this deployment holds", async () => {
    const { accounts } = deployment();
    for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
      openDb(join(accounts, `${account}.db`)).close();
    }

    const body = await (await GET(probe())).json();

    // Every number here is a count of things that are wrong. A store count is not: it is
    // a live headcount of people, on an unauthenticated route, that ticks up within the
    // minute somebody signs up. A monitor needs to know something is broken and how much.
    expect(Object.keys(body.store).sort()).toEqual([
      "behind",
      "migrations_applied",
      "migrations_expected",
      "status",
      "unmeasured",
      "unopenable",
    ]);
    // The number is genuinely operational, so it goes where the operator reads and the
    // public does not.
    expect(loggedEvents()).toContainEqual(
      expect.objectContaining({ event: "health_check", count: 3 }),
    );
  });

  it("bounds what a store somebody else is writing can cost the request", async () => {
    const { accounts } = deployment();
    // Backups switched off, so the verdict below is about the contended stores alone.
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "off");
    startSnapshotScheduler();
    const writers = [ACCOUNT, OTHER_ACCOUNT].map((account) =>
      heldByAnotherWriter(join(accounts, `${account}.db`)),
    );

    const started = Date.now();
    const body = await (await GET(probe())).json();
    const elapsed = Date.now() - started;
    for (const writer of writers) writer.close();

    // better-sqlite3 waits five seconds for a lock by default and blocks the single Node
    // thread while it waits, so an unbounded probe of two contended stores stalls the
    // server it exists to report on for ten seconds — long enough for the platform's own
    // probe to time out and retire a deployment that was serving.
    expect(elapsed).toBeLessThan(2_000);
    // And a store being written to is not a broken store: counting contention as a fault
    // would put the deployment in "degraded" for the length of every snapshot run.
    expect(body.status).toBe("ok");
    expect(body.store).toMatchObject({ status: "ok", unopenable: 0, unmeasured: 2 });
    expect(loggedEvents()).toContainEqual(
      expect.objectContaining({ event: "health_store_probe", reason: "probe_incomplete" }),
    );
  });

  it("counts a store still waiting for its migrations without calling it broken", async () => {
    const { accounts } = deployment();
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "off");
    startSnapshotScheduler();
    const behind = new Database(join(accounts, `${ACCOUNT}.db`));
    migrate(behind, MIGRATIONS.slice(0, 1));
    behind.close();

    const body = await (await GET(probe())).json();

    // An account store is migrated on its owner's first request, so every one of them is
    // behind for a while after a deploy that adds a migration. Reporting the count is
    // useful; degrading on it would mean every such deploy declares itself unhealthy.
    expect(body.store).toMatchObject({ unopenable: 0, behind: 1 });
    expect(body.status).toBe("ok");
  });

  it("degrades when the newest copy on the volume is older than the schedule allows", async () => {
    const { primary, snapshots } = deployment();
    const db = openDb(primary);
    createVerifiedSnapshot(db, { directory: snapshots });
    db.close();
    const aged = new Date(Date.now() - (25 + SNAPSHOT_STALE_GRACE_HOURS) * 3_600_000);
    for (const copy of listRestorableSnapshots(primary, snapshots)) {
      utimesSync(copy, aged, aged);
    }

    const response = await GET(probe());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.snapshots.freshness.state).toBe("stale");
    // The fields this used to be reported from say nothing at all — the same nothing
    // they say when backups are healthy.
    expect(body.snapshots.lastResult).toBeNull();
    expect(body.snapshots.lastRunAt).toBeNull();
  });

  it("surfaces a silent retrieval downgrade rather than reporting plain health", async () => {
    mocks.embeddingStatus.mockReturnValue("unavailable");

    const response = await GET(probe());

    // Still serving, so still 200 — but an operator can see recall got worse.
    expect(response.status).toBe(200);
    expect((await response.json()).embeddings).toBe("unavailable");
  });

  it("answers while auth itself is misconfigured, and fails the check", async () => {
    mocks.getAuthConfiguration.mockReturnValue({
      mode: "misconfigured",
      message: "Supabase login needs a project URL",
    });

    const response = await GET(probe());
    const body = await response.json();

    // The store is fine and the process is listening, and none of that helps: every
    // /api/* answers 503 and every private page redirects to a login that cannot work.
    // A platform reads the status code, so the status code has to say so.
    expect(response.status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.auth).toBe("misconfigured");
    expect(body.store.status).toBe("ok");
  });

  it("fails the check when a local-mode deployment is reached under a public hostname", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });

    const response = await GET(probe("zeus.example.com"));

    // The Supabase variables went missing on a deployment the world can reach. Local mode
    // demands the literal loopback authority, so this request — and every private one
    // behind it — is answered with a bare 403. Not an inference about the deployment: the
    // outage arrived at the door and the check is reporting what it found there.
    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe("unavailable");
    expect(loggedEvents()).toContainEqual(
      expect.objectContaining({ event: "health_check", reason: "auth_local_off_loopback" }),
    );
  });

  it("stays healthy on the documented loopback production serve", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });
    // `npm run start` is `next start -H 127.0.0.1`, which sets NODE_ENV=production, and
    // AGENTS.md lists it as the way to serve the production build. NODE_ENV alone cannot
    // tell it from a hosted deployment that lost its auth, so it must not be the signal:
    // reporting this configuration unavailable is the endpoint crying wolf at the one
    // setup the repository documents.
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(probe());

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  });

  it("stays healthy in local mode outside production", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });

    const response = await GET(probe());

    // Loopback-only local mode is the supported way to run Zeus on a workstation.
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  });

  it("never reports whether a key exists beyond a boolean-ish label", async () => {
    mocks.hasCredentials.mockReturnValue(false);

    const body = await (await GET(probe())).json();

    expect(body.model).toBe("absent");
    expect(JSON.stringify(body)).not.toMatch(/sk-|key/iu);
  });
});

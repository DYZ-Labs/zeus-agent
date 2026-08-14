import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openDb } from "@/core/db";
import { deploymentSnapshotDirectory } from "@/core/snapshot-schedule";
import { listRestorableSnapshots } from "@/core/snapshots";
import {
  resetSnapshotScheduler,
  runDueSnapshots,
  snapshotSchedulerStatus,
  startSnapshotScheduler,
} from "./snapshot-scheduler";

const ACCOUNT = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const temporaryDirectories: string[] = [];

let primary: string;
let account: string;
/**
 * The default layout, deliberately not `ZEUS_SNAPSHOT_DIR`.
 *
 * Stubbing that variable made the write side and the read side agree by force, which is
 * exactly what hid a scheduler that wrote every account's backup somewhere the freshness
 * check and the restore command never looked. These tests have to run against the
 * documented default or they prove nothing about it.
 */
let snapshots: string;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const base = mkdtempSync(join(tmpdir(), "zeus-scheduler-"));
  temporaryDirectories.push(base);
  primary = join(base, "zeus.db");
  openDb(primary).close();
  mkdirSync(join(base, "accounts"));
  account = join(base, "accounts", `${ACCOUNT}.db`);
  openDb(account).close();
  snapshots = join(base, "snapshots");
  vi.stubEnv("ZEUS_DB", primary);
  // Pinned *unset*, not pinned to a path. Setting it is what hid the bug these tests
  // exist for, because both sides then agree by configuration rather than by code; not
  // pinning it at all would leave them reading whoever's shell started vitest.
  vi.stubEnv("ZEUS_SNAPSHOT_DIR", undefined);
});

afterEach(() => {
  resetSnapshotScheduler();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The one verified copy of a store, failing loudly rather than indexing into nothing. */
function onlySnapshot(store: string): string {
  const found = listRestorableSnapshots(store, snapshots);
  expect(found).toHaveLength(1);
  return found[0] ?? "";
}

describe("in-process snapshot scheduler", () => {
  it("backs up every store on the first tick, not only the primary one", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    startSnapshotScheduler();

    await runDueSnapshots();

    expect(listRestorableSnapshots(primary, snapshots)).toHaveLength(1);
    expect(listRestorableSnapshots(account, snapshots)).toHaveLength(1);
    expect(snapshotSchedulerStatus()).toMatchObject({ state: "running", lastResult: "ok" });
  });

  it("does not snapshot again while the existing copy is still fresh", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    startSnapshotScheduler();
    await runDueSnapshots();

    // A redeploy loop must not turn a daily backup into a per-deploy one.
    await runDueSnapshots();
    resetSnapshotScheduler();
    startSnapshotScheduler();
    await runDueSnapshots();

    expect(listRestorableSnapshots(primary, snapshots)).toHaveLength(1);
    // An account store has to be as fresh-checkable as the primary one. When the copy
    // lands somewhere the freshness check cannot see, every store looks due on every
    // hourly tick and retention burns a hosted user's history down to hours.
    expect(listRestorableSnapshots(account, snapshots)).toHaveLength(1);
  });

  it("leaves an account store's copy where the restore command looks for it", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    startSnapshotScheduler();
    await runDueSnapshots();

    // Resolved the way `npm run restore -- --db <account>.db --list` resolves it. A
    // backup the documented recovery cannot find is not a backup.
    expect(listRestorableSnapshots(account, deploymentSnapshotDirectory())).toHaveLength(1);
  });

  it("prunes each store's own copies and never another store's", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    vi.stubEnv("ZEUS_SNAPSHOT_RETENTION", "1");
    startSnapshotScheduler();
    await runDueSnapshots();

    const primaryCopy = onlySnapshot(primary);
    const staleAccountCopy = onlySnapshot(account);

    // Age only the account's copy, so the next tick snapshots that store alone. Every
    // store shares one directory, so retention has to count per source: a prune that
    // kept "the newest file here" would take the primary store's only backup with it.
    const aged = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(staleAccountCopy, aged, aged);
    await runDueSnapshots();

    expect(listRestorableSnapshots(primary, snapshots)).toEqual([primaryCopy]);
    expect(onlySnapshot(account)).not.toBe(staleAccountCopy);
  });

  it("keeps backing up the other stores when one cannot be read", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    // A file that exists but is not a database: enumerated, then unreadable.
    rmSync(account);
    writeFileSync(account, "not a database");

    // start() kicks off its own run; awaiting joins that run rather than racing it.
    startSnapshotScheduler();
    await runDueSnapshots();

    expect(listRestorableSnapshots(primary, snapshots)).toHaveLength(1);
    expect(snapshotSchedulerStatus().lastResult).toBe("partial");
  });

  it("never lets a backup failure escape into the server", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    vi.stubEnv("ZEUS_SNAPSHOT_DIR", "relative/not/absolute");
    startSnapshotScheduler();

    // Scheduling itself failing is reported, not thrown at whatever called the tick.
    await expect(runDueSnapshots()).resolves.toBeUndefined();
  });

  it("stays off outside a hosted deployment and says so", () => {
    vi.stubEnv("NODE_ENV", "development");
    const settings = startSnapshotScheduler();

    expect(settings).toMatchObject({ enabled: false, reason: "not_hosted" });
    expect(snapshotSchedulerStatus()).toMatchObject({ state: "disabled" });
  });

  it("reports not_started before anything has scheduled it", () => {
    resetSnapshotScheduler();

    expect(snapshotSchedulerStatus()).toEqual({
      state: "not_started",
      intervalHours: null,
      lastResult: null,
      lastRunAt: null,
    });
  });

  it("replaces its timer across a hot reload instead of stacking another", () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    const clear = vi.spyOn(globalThis, "clearInterval");

    startSnapshotScheduler();
    startSnapshotScheduler();

    expect(clear).toHaveBeenCalled();
    expect(snapshotSchedulerStatus().state).toBe("running");
  });
});

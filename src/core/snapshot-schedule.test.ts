import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb } from "./db";
import {
  DEFAULT_SNAPSHOT_INTERVAL_HOURS,
  deploymentSnapshotDirectory,
  snapshotScheduleSettings,
  storesDueForSnapshot,
} from "./snapshot-schedule";
import { createVerifiedSnapshot, latestSnapshotTime } from "./snapshots";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  // These tests are about where the default layout puts a copy, so the override has to be
  // pinned off. Left ambient, they would quietly assert whoever's shell started vitest.
  vi.stubEnv("ZEUS_SNAPSHOT_DIR", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const ACCOUNT = "019ff232-f8e0-7ce2-8e83-d416444aed06";

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "zeus-schedule-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A primary store, one account store, and the shared snapshot directory beside them. */
function deployment(): { primary: string; account: string; directory: string } {
  const base = root();
  const primary = join(base, "zeus.db");
  openDb(primary).close();
  mkdirSync(join(base, "accounts"));
  const account = join(base, "accounts", `${ACCOUNT}.db`);
  openDb(account).close();
  return { primary, account, directory: join(base, "snapshots") };
}

function snapshot(path: string, directory: string, ageHours = 0): void {
  const db = openDb(path);
  try {
    const result = createVerifiedSnapshot(db, { directory });
    if (ageHours > 0) {
      const when = new Date(Date.now() - ageHours * 3_600_000);
      utimesSync(result.path, when, when);
    }
  } finally {
    db.close();
  }
}

describe("hosted snapshot scheduling", () => {
  it("enables itself for a hosted deployment and stays out of development", () => {
    const hosted = snapshotScheduleSettings(
      { mode: "configured" },
      { NODE_ENV: "production" },
    );
    const development = snapshotScheduleSettings(
      { mode: "configured" },
      { NODE_ENV: "development" },
    );
    const local = snapshotScheduleSettings({ mode: "local" }, { NODE_ENV: "production" });

    expect(hosted).toMatchObject({ enabled: true, reason: "hosted" });
    // `next dev` must not grow a surprise background job.
    expect(development).toMatchObject({ enabled: false, reason: "not_hosted" });
    expect(local).toMatchObject({ enabled: false, reason: "not_hosted" });
    expect(hosted.intervalHours).toBe(DEFAULT_SNAPSHOT_INTERVAL_HOURS);
  });

  it("honours an explicit override in both directions", () => {
    expect(
      snapshotScheduleSettings({ mode: "local" }, { ZEUS_SNAPSHOT_SCHEDULER: "on" }),
    ).toMatchObject({ enabled: true, reason: "explicitly_enabled" });
    expect(
      snapshotScheduleSettings(
        { mode: "configured" },
        { NODE_ENV: "production", ZEUS_SNAPSHOT_SCHEDULER: "off" },
      ),
    ).toMatchObject({ enabled: false, reason: "explicitly_disabled" });
    expect(() =>
      snapshotScheduleSettings({ mode: "local" }, { ZEUS_SNAPSHOT_SCHEDULER: "maybe" }),
    ).toThrow(/'on' or 'off'/u);
  });

  it("rejects a nonsense interval rather than silently backing up never", () => {
    expect(() =>
      snapshotScheduleSettings({ mode: "local" }, { ZEUS_SNAPSHOT_INTERVAL_HOURS: "0" }),
    ).toThrow(/between 1 and 8760/u);
    expect(
      snapshotScheduleSettings({ mode: "local" }, { ZEUS_SNAPSHOT_INTERVAL_HOURS: "6" })
        .intervalHours,
    ).toBe(6);
  });

  it("treats a never-snapshotted store as due, including a new account", () => {
    const { primary, account, directory } = deployment();

    const due = storesDueForSnapshot({ primaryPath: primary, directory });

    expect(due.map((store) => store.path)).toEqual([primary, account]);
  });

  it("stops asking once a store has a fresh snapshot", () => {
    const { primary, account, directory } = deployment();
    snapshot(primary, directory);

    const due = storesDueForSnapshot({ primaryPath: primary, directory });

    // Each store is considered on its own, so a new account is not made to wait for
    // the primary store's next turn.
    expect(due.map((store) => store.path)).toEqual([account]);
  });

  it("becomes due again once the interval has elapsed", () => {
    const { primary, directory } = deployment();
    snapshot(primary, directory, 25);

    const fresh = storesDueForSnapshot({
      primaryPath: primary,
      directory,
      intervalHours: 48,
    });
    const stale = storesDueForSnapshot({
      primaryPath: primary,
      directory,
      intervalHours: 24,
    });

    expect(fresh.map((store) => store.path)).not.toContain(primary);
    expect(stale.map((store) => store.path)).toContain(primary);
  });

  it("survives restarts by reading disk rather than remembering a timer", () => {
    const { primary, account, directory } = deployment();
    snapshot(primary, directory);
    snapshot(account, directory);

    // A redeploy loop must not turn a daily backup into a per-deploy one: state lives
    // in the snapshots themselves, so a brand-new process sees nothing due.
    expect(storesDueForSnapshot({ primaryPath: primary, directory })).toEqual([]);
  });

  it("takes a snapshot rather than trusting a clock that moved backwards", () => {
    const { primary, directory } = deployment();
    snapshot(primary, directory);
    const future = new Date(Date.now() - 3_600_000);

    const due = storesDueForSnapshot({ primaryPath: primary, directory, at: future });

    expect(due.map((store) => store.path)).toContain(primary);
  });

  it("reports no snapshot time for a store that has never had one", () => {
    const { account, directory } = deployment();

    expect(latestSnapshotTime(account, directory)).toBeNull();
    snapshot(account, directory);
    expect(latestSnapshotTime(account, directory)).toBeInstanceOf(Date);
  });

  it("resolves one directory for every store, beside the primary one", () => {
    const { primary, account } = deployment();

    // An account store's own path implies `accounts/snapshots`, and resolving it that
    // way is how the write side and the read side came apart. Every store's copies
    // belong beside the primary store, where retention keeps them apart by source hash
    // and where a single directory is what an operator replicates off-machine.
    expect(deploymentSnapshotDirectory(primary)).toBe(join(dirname(primary), "snapshots"));
    expect(deploymentSnapshotDirectory(primary)).not.toBe(
      join(dirname(account), "snapshots"),
    );
  });

  it("finds an account store's copies without being told where to look", () => {
    const { primary, account } = deployment();
    snapshot(account, deploymentSnapshotDirectory(primary));

    // The scheduler asks without passing a directory, so the default it falls back to
    // has to be the same one the snapshot was written into.
    const due = storesDueForSnapshot({ primaryPath: primary });

    expect(due.map((store) => store.path)).toEqual([primary]);
  });

  it("keeps one store's freshness from vouching for another's", () => {
    const { primary, account, directory } = deployment();
    snapshot(primary, directory);

    expect(latestSnapshotTime(primary, directory)).toBeInstanceOf(Date);
    expect(latestSnapshotTime(account, directory)).toBeNull();
  });
});

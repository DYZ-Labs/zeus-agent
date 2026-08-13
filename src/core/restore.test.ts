import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConversation, listConversations } from "./conversations";
import { openDb } from "./db";
import { planRestore, restoreDatabaseCopy } from "./restore";
import { createVerifiedSnapshot } from "./snapshots";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "zeus-restore-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A store holding one identifiable conversation, plus a verified snapshot of it. */
function storeWithSnapshot(directory: string, title: string) {
  const databasePath = join(directory, "zeus.db");
  const snapshotDirectory = join(directory, "snapshots");
  const db = openDb(databasePath);
  createConversation(db, { title, source: "web" });
  const snapshot = createVerifiedSnapshot(db, { directory: snapshotDirectory });
  db.close();
  return { databasePath, snapshotPath: snapshot.path, snapshotDirectory };
}

function titles(databasePath: string): (string | null)[] {
  const db = openDb(databasePath);
  try {
    return listConversations(db, 50).map((entry) => entry.title);
  } finally {
    db.close();
  }
}

describe("verified restore", () => {
  it("installs the snapshot and preserves the store it replaced", () => {
    const directory = root();
    const { databasePath, snapshotPath } = storeWithSnapshot(directory, "before");

    // Diverge the live store so a successful restore is observable.
    const live = openDb(databasePath);
    createConversation(live, { title: "after", source: "web" });
    live.close();
    expect(titles(databasePath)).toContain("after");

    const result = restoreDatabaseCopy(databasePath, snapshotPath);

    expect(titles(databasePath)).toEqual(["before"]);
    expect(result.preserved).not.toBeNull();
    expect(existsSync(result.preserved!)).toBe(true);
    // The replaced store is intact, not merely retained.
    expect(titles(result.preserved!)).toContain("after");
  });

  it("leaves no stale WAL or SHM beside the restored store", () => {
    const directory = root();
    const { databasePath, snapshotPath } = storeWithSnapshot(directory, "before");

    // A write-ahead log belonging to the *outgoing* database must not survive it:
    // left in place, it invites SQLite to replay one store's pages into another.
    const live = openDb(databasePath);
    createConversation(live, { title: "after", source: "web" });
    expect(existsSync(`${databasePath}-wal`)).toBe(true);
    live.close();
    writeFileSync(`${databasePath}-wal`, "");
    writeFileSync(`${databasePath}-shm`, "");

    const result = restoreDatabaseCopy(databasePath, snapshotPath);

    // Either moved aside or checkpointed away by the writer probe; what matters is
    // that nothing stale is adjacent to the file now being served.
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    for (const moved of result.sidecars) {
      expect(existsSync(`${result.preserved!}${moved.slice(databasePath.length)}`)).toBe(true);
    }
    expect(titles(databasePath)).toEqual(["before"]);
  });

  it("restores onto a store that is gone entirely", () => {
    const directory = root();
    const { databasePath, snapshotPath } = storeWithSnapshot(directory, "before");
    rmSync(databasePath);
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });

    const result = restoreDatabaseCopy(databasePath, snapshotPath);

    expect(result.preserved).toBeNull();
    expect(titles(databasePath)).toEqual(["before"]);
  });

  it("refuses an unverifiable source without touching the live store", () => {
    const directory = root();
    const { databasePath } = storeWithSnapshot(directory, "before");
    const corrupt = join(directory, "not-a-database.db");
    writeFileSync(corrupt, "this is not SQLite");

    expect(() => restoreDatabaseCopy(databasePath, corrupt)).toThrow();
    expect(titles(databasePath)).toEqual(["before"]);
    expect(existsSync(`${databasePath}.pre-restore-`)).toBe(false);
  });

  it("refuses to restore while another process holds the writer reservation", () => {
    const directory = root();
    const { databasePath, snapshotPath } = storeWithSnapshot(directory, "before");

    const holder = new Database(databasePath);
    holder.pragma("journal_mode = WAL");
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(() => restoreDatabaseCopy(databasePath, snapshotPath)).toThrow(
        /Another process is writing/u,
      );
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    expect(titles(databasePath)).toEqual(["before"]);
  });

  it("verifies during a dry run without changing anything", () => {
    const directory = root();
    const { databasePath, snapshotPath } = storeWithSnapshot(directory, "before");
    const live = openDb(databasePath);
    createConversation(live, { title: "after", source: "web" });
    live.close();

    const plan = planRestore(databasePath, snapshotPath);

    expect(plan.targetExists).toBe(true);
    expect(plan.source).toBe(snapshotPath);
    expect(titles(databasePath)).toContain("after");
  });

  it("refuses to restore a file over itself", () => {
    const directory = root();
    const { snapshotPath } = storeWithSnapshot(directory, "before");

    expect(() => planRestore(snapshotPath, snapshotPath)).toThrow(/same file/u);
  });

  it("refuses a target directory that does not exist", () => {
    const directory = root();
    const { snapshotPath } = storeWithSnapshot(directory, "before");

    expect(() =>
      planRestore(join(directory, "not-mounted", "zeus.db"), snapshotPath),
    ).toThrow(/does not exist/u);
  });
});

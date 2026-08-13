import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const handles = vi.hoisted(() => ({ openStoreHandles: vi.fn() }));
vi.mock("@/server/db", () => ({ openStoreHandles: handles.openStoreHandles }));

import { createConversation } from "@/core/conversations";
import { checkpointWal, configuredSynchronous, openDb, type Db } from "@/core/db";
import { checkpointOpenStores, resetDurabilityMaintenance } from "./durability";

const temporaryDirectories: string[] = [];
let db: Db;
let databasePath: string;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const base = mkdtempSync(join(tmpdir(), "zeus-durability-"));
  temporaryDirectories.push(base);
  databasePath = join(base, "zeus.db");
  db = openDb(databasePath);
  handles.openStoreHandles.mockReturnValue([db]);
});

afterEach(() => {
  resetDurabilityMaintenance();
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function walSize(): number {
  const path = `${databasePath}-wal`;
  return existsSync(path) ? statSync(path).size : 0;
}

describe("durability settings", () => {
  it("defaults to surviving a host crash, not just a process crash", () => {
    expect(configuredSynchronous()).toBe("full");
    // 2 is SQLite's FULL. NORMAL (1) does not fsync on commit, so a power loss can
    // take the most recently learned facts with it.
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
  });

  it("can be reverted without a code change if a volume makes fsync expensive", () => {
    vi.stubEnv("ZEUS_SYNCHRONOUS", "normal");
    const relaxed = openDb(join(temporaryDirectories[0]!, "relaxed.db"));
    try {
      expect(configuredSynchronous()).toBe("normal");
      expect(relaxed.pragma("synchronous", { simple: true })).toBe(1);
    } finally {
      relaxed.close();
    }
  });

  it("rejects a value that is neither, rather than guessing", () => {
    vi.stubEnv("ZEUS_SYNCHRONOUS", "sometimes");
    expect(() => configuredSynchronous()).toThrow(/'full' or 'normal'/u);
  });
});

describe("write-ahead log maintenance", () => {
  it("empties the log a long-lived process would otherwise grow forever", () => {
    for (let index = 0; index < 200; index += 1) {
      createConversation(db, { title: `conversation ${index}`, source: "web" });
    }
    expect(walSize()).toBeGreaterThan(0);

    const completed = checkpointOpenStores("TRUNCATE");

    expect(completed).toBe(1);
    expect(walSize()).toBe(0);
  });

  it("leaves the store usable, because a checkpoint is maintenance not a close", () => {
    createConversation(db, { title: "before", source: "web" });

    checkpointOpenStores("PASSIVE");

    // A shutdown checkpoint must not pull the database out from under a draining
    // request; the handle still works afterwards.
    expect(() => createConversation(db, { title: "after", source: "web" })).not.toThrow();
  });

  it("reports nothing when no store is open rather than inventing work", () => {
    handles.openStoreHandles.mockReturnValue([]);

    expect(checkpointOpenStores("TRUNCATE")).toBe(0);
  });

  it("never throws when a handle cannot be checkpointed", () => {
    const closed = openDb(join(temporaryDirectories[0]!, "closed.db"));
    closed.close();
    handles.openStoreHandles.mockReturnValue([closed]);

    expect(() => checkpointOpenStores("PASSIVE")).not.toThrow();
    expect(checkpointWal(closed)).toBe(false);
  });

  it("checkpoints every open store, not only the primary one", () => {
    const second = openDb(join(temporaryDirectories[0]!, "account.db"));
    try {
      createConversation(second, { title: "account work", source: "web" });
      handles.openStoreHandles.mockReturnValue([db, second]);

      expect(checkpointOpenStores("TRUNCATE")).toBe(2);
    } finally {
      second.close();
    }
  });
});

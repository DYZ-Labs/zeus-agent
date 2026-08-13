import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConversation } from "./conversations";
import { openDb, openTestDb } from "./db";
import { deleteConversationWithMemory } from "./retention";
import { buildSnapshotLaunchAgentPlist } from "./snapshot-launch-agent";
import {
  configuredSnapshotHour,
  configuredSnapshotRetention,
  createVerifiedSnapshot,
  defaultSnapshotDirectory,
  listManagedSnapshots,
  listRestorableSnapshots,
  purgeManagedSnapshots,
} from "./snapshots";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("verified online snapshots", () => {
  it("captures committed WAL state while another connection has an uncommitted write", () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const snapshotDirectory = join(root, "snapshots");
    const db = openDb(databasePath);
    // Register the durable destination before simulating a long-lived writer. The
    // snapshot itself remains read-only while that other WAL transaction is active.
    createVerifiedSnapshot(db, {
      directory: snapshotDirectory,
      retention: 5,
      createdAt: new Date("2030-01-01T03:04:05.000Z"),
    });
    db.exec("CREATE TABLE snapshot_probe (value TEXT NOT NULL)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("INSERT INTO snapshot_probe (value) VALUES (?)").run("committed in WAL");

    const writer = new Database(databasePath);
    writer.pragma("journal_mode = WAL");
    writer.pragma("busy_timeout = 5000");
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO snapshot_probe (value) VALUES (?)").run("not committed");

    const result = createVerifiedSnapshot(db, {
      directory: snapshotDirectory,
      retention: 5,
      createdAt: new Date("2030-01-02T03:04:05.000Z"),
    });

    expect(writer.inTransaction).toBe(true);
    expect(lstatSync(result.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(snapshotDirectory).mode & 0o777).toBe(0o700);
    expect(readdirSync(snapshotDirectory).some((name) => name.endsWith(".tmp"))).toBe(false);

    const snapshot = new Database(result.path, { readonly: true, fileMustExist: true });
    expect(snapshot.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(snapshot.prepare("SELECT value FROM snapshot_probe ORDER BY rowid").pluck().all()).toEqual([
      "committed in WAL",
    ]);
    snapshot.close();

    writer.exec("ROLLBACK");
    writer.close();
    db.close();
  });

  it("retains only the newest verified copies for one exact source", () => {
    const root = temporaryDirectory();
    const sharedDirectory = join(root, "shared-snapshots");
    const firstPath = join(root, "first", "zeus.db");
    const secondPath = join(root, "second", "zeus.db");
    const first = openDb(firstPath);
    const second = openDb(secondPath);

    const oldest = createVerifiedSnapshot(first, {
      directory: sharedDirectory,
      retention: 2,
      createdAt: new Date("2030-01-01T03:00:00.000Z"),
    }).path;
    const otherSource = createVerifiedSnapshot(second, {
      directory: sharedDirectory,
      retention: 1,
      createdAt: new Date("2030-01-01T03:30:00.000Z"),
    }).path;
    const middle = createVerifiedSnapshot(first, {
      directory: sharedDirectory,
      retention: 2,
      createdAt: new Date("2030-01-02T03:00:00.000Z"),
    }).path;

    const arbitrary = join(sharedDirectory, "unmanaged.db");
    const symlink = join(sharedDirectory, `${basename(middle)}.symlink.db`);
    writeFileSync(arbitrary, "not a snapshot", { mode: 0o600 });
    symlinkSync(arbitrary, symlink);

    const newest = createVerifiedSnapshot(first, {
      directory: sharedDirectory,
      retention: 2,
      createdAt: new Date("2030-01-03T03:00:00.000Z"),
    });

    expect(newest.pruned).toBe(1);
    expect(() => lstatSync(oldest)).toThrow();
    expect(listManagedSnapshots(first, sharedDirectory)).toEqual([middle, newest.path]);
    expect(listManagedSnapshots(second, sharedDirectory)).toEqual([otherSource]);
    expect(readFileSync(arbitrary, "utf8")).toBe("not a snapshot");
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);

    first.close();
    second.close();
  });

  it("does not publish or prune when shared verification fails", () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const snapshotDirectory = join(root, "snapshots");
    const db = openDb(databasePath);
    const prior = createVerifiedSnapshot(db, {
      directory: snapshotDirectory,
      retention: 1,
      createdAt: new Date("2030-01-01T03:00:00.000Z"),
    }).path;

    db.pragma("application_id = 0");
    expect(() =>
      createVerifiedSnapshot(db, {
        directory: snapshotDirectory,
        retention: 1,
        createdAt: new Date("2030-01-02T03:00:00.000Z"),
      }),
    ).toThrow(/Zeus application marker/u);

    expect(readdirSync(snapshotDirectory)).toEqual([basename(prior)]);
    expect(lstatSync(prior).isFile()).toBe(true);
    db.close();
  });

  it("rejects in-memory stores and active transactions before writing", () => {
    const memory = openTestDb();
    expect(() => createVerifiedSnapshot(memory)).toThrow(/in-memory/u);
    memory.close();

    const root = temporaryDirectory();
    const db = openDb(join(root, "zeus.db"));
    db.exec("BEGIN");
    expect(() =>
      createVerifiedSnapshot(db, { directory: join(root, "snapshots") }),
    ).toThrow(/transaction/u);
    expect(readdirSync(root)).not.toContain("snapshots");
    db.exec("ROLLBACK");
    db.close();
  });

  it("purges managed local snapshots when a source is explicitly erased", () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const snapshotDirectory = join(root, "snapshots");
    vi.stubEnv("ZEUS_SNAPSHOT_DIR", snapshotDirectory);
    const db = openDb(databasePath);
    const conversation = createConversation(db, { title: "Delete me" });
    const snapshotPath = createVerifiedSnapshot(db).path;
    const previousDirectory = join(root, "previous-snapshot-target");
    const previousSnapshot = createVerifiedSnapshot(db, {
      directory: previousDirectory,
      retention: 2,
    }).path;
    expect(
      db.prepare("SELECT directory FROM snapshot_destination ORDER BY directory").pluck().all(),
    ).toEqual([realpathSync(snapshotDirectory), realpathSync(previousDirectory)].sort());
    const corruptPublished = snapshotPath.replace(/\.db$/u, "-corrupt.db");
    const interruptedTemporary = snapshotPath.replace(/\.db$/u, "-interrupted.db.tmp");
    const unrelated = join(snapshotDirectory, "unrelated.db.tmp");
    writeFileSync(corruptPublished, "recoverable but no longer valid", { mode: 0o600 });
    writeFileSync(interruptedTemporary, readFileSync(snapshotPath), { mode: 0o600 });
    writeFileSync(unrelated, "not managed by this source", { mode: 0o600 });
    expect(lstatSync(snapshotPath).isFile()).toBe(true);

    deleteConversationWithMemory(db, conversation.id);

    expect(listManagedSnapshots(db)).toEqual([]);
    expect(() => lstatSync(snapshotPath)).toThrow();
    expect(() => lstatSync(corruptPublished)).toThrow();
    expect(() => lstatSync(interruptedTemporary)).toThrow();
    expect(() => lstatSync(previousSnapshot)).toThrow();
    expect(readFileSync(unrelated, "utf8")).toBe("not managed by this source");
    db.close();
  });

  it("fails before deleting rows when a registered destination is unavailable", () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const snapshotDirectory = join(root, "removable-target");
    const db = openDb(databasePath);
    const conversation = createConversation(db, { title: "Must survive failure" });
    createVerifiedSnapshot(db, { directory: snapshotDirectory });
    rmSync(snapshotDirectory, { recursive: true });

    expect(() => deleteConversationWithMemory(db, conversation.id)).toThrow(/unavailable/u);
    expect(
      db.prepare("SELECT COUNT(*) FROM conversation WHERE id = ?").pluck().get(conversation.id),
    ).toBe(1);
    db.close();
  });

  it("waits on the source-wide snapshot lock before explicit erasure", async () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const db = openDb(databasePath);
    const conversation = createConversation(db, { title: "Coordinated deletion" });
    const holder = spawnLockHolder(`${databasePath}.zeus-snapshot.lock`, 250);
    await holder.ready;

    const started = Date.now();
    deleteConversationWithMemory(db, conversation.id);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await holder.done;
    expect(
      db.prepare("SELECT COUNT(*) FROM conversation WHERE id = ?").pluck().get(conversation.id),
    ).toBe(0);
    db.close();
  });
});

describe("snapshot configuration and scheduling", () => {
  it("recovers a day-old orphaned snapshot lock", () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const snapshotDirectory = join(root, "snapshots");
    const db = openDb(databasePath);
    createVerifiedSnapshot(db, { directory: snapshotDirectory });
    const lockPath = `${databasePath}.zeus-snapshot.lock`;
    writeFileSync(lockPath, '{"pid":2147483647}\n', { mode: 0o600 });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);

    expect(purgeManagedSnapshots(db, snapshotDirectory)).toBe(1);
    expect(() => lstatSync(lockPath)).toThrow();
    db.close();
  });

  it("defaults beside the database and validates environment values", () => {
    const root = temporaryDirectory();
    expect(defaultSnapshotDirectory(join(root, "zeus.db"))).toBe(join(root, "snapshots"));
    expect(configuredSnapshotRetention()).toBe(14);
    expect(configuredSnapshotHour()).toBe(3);

    vi.stubEnv("ZEUS_SNAPSHOT_RETENTION", "7");
    vi.stubEnv("ZEUS_SNAPSHOT_HOUR", "23");
    expect(configuredSnapshotRetention()).toBe(7);
    expect(configuredSnapshotHour()).toBe(23);

    vi.stubEnv("ZEUS_SNAPSHOT_RETENTION", "0");
    vi.stubEnv("ZEUS_SNAPSHOT_HOUR", "24");
    expect(() => configuredSnapshotRetention()).toThrow(/between 1 and 10000/u);
    expect(() => configuredSnapshotHour()).toThrow(/between 0 and 23/u);

    vi.stubEnv("ZEUS_SNAPSHOT_DIR", "/");
    expect(() => defaultSnapshotDirectory(join(root, "zeus.db"))).toThrow(/filesystem root/u);
    vi.stubEnv("ZEUS_SNAPSHOT_DIR", "relative/snapshots");
    expect(() => defaultSnapshotDirectory(join(root, "zeus.db"))).toThrow(/absolute/u);
  });

  it("renders a shell-free daily LaunchAgent with fixed snapshot policy", () => {
    const plist = buildSnapshotLaunchAgentPlist({
      nodePath: "/opt/node & runtime/bin/node",
      tsxCliPath: "/opt/zeus/node_modules/tsx.mjs",
      workerPath: "/opt/zeus/scripts/snapshot.ts",
      databasePath: "/Volumes/Private & Local/zeus.db",
      snapshotDirectory: "/Volumes/Backup & Local/snapshots",
      retention: 14,
      hour: 3,
      stdoutPath: "/tmp/zeus-snapshot.out",
      stderrPath: "/tmp/zeus-snapshot.err",
    });

    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<integer>3</integer>");
    expect(plist).toContain("<string>--retention</string>");
    expect(plist).toContain("<string>14</string>");
    expect(plist).toContain("/Volumes/Backup &amp; Local/snapshots");
    expect(plist).not.toMatch(/(?:sh|zsh|bash) -c/u);
  });
});

describe("recovery-time snapshot lookup", () => {
  it("lists a store's snapshots after the store itself is gone", () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const snapshotDirectory = join(root, "snapshots");
    const db = openDb(databasePath);
    const first = createVerifiedSnapshot(db, {
      directory: snapshotDirectory,
      createdAt: new Date("2026-01-01T03:00:00.000Z"),
    });
    const second = createVerifiedSnapshot(db, {
      directory: snapshotDirectory,
      createdAt: new Date("2026-01-02T03:00:00.000Z"),
    });
    db.close();
    // The disaster this exists for: the store it protects is unopenable or absent.
    rmSync(databasePath);

    const found = listRestorableSnapshots(databasePath, snapshotDirectory);

    expect(found).toEqual([first.path, second.path]);
    expect(found.at(-1)).toBe(second.path);
  });

  it("keeps each store's snapshots separate in a shared directory", () => {
    const root = temporaryDirectory();
    const snapshotDirectory = join(root, "snapshots");
    const primaryPath = join(root, "zeus.db");
    const accountPath = join(root, "account.db");
    const primary = openDb(primaryPath);
    const account = openDb(accountPath);
    const primarySnapshot = createVerifiedSnapshot(primary, { directory: snapshotDirectory });
    const accountSnapshot = createVerifiedSnapshot(account, { directory: snapshotDirectory });
    primary.close();
    account.close();

    expect(listRestorableSnapshots(primaryPath, snapshotDirectory)).toEqual([
      primarySnapshot.path,
    ]);
    expect(listRestorableSnapshots(accountPath, snapshotDirectory)).toEqual([
      accountSnapshot.path,
    ]);
  });

  it("ignores an unverifiable file that merely looks like a snapshot", () => {
    const root = temporaryDirectory();
    const databasePath = join(root, "zeus.db");
    const snapshotDirectory = join(root, "snapshots");
    const db = openDb(databasePath);
    const real = createVerifiedSnapshot(db, { directory: snapshotDirectory });
    db.close();
    writeFileSync(real.path.replace(/-[^-]+\.db$/u, "-forged.db"), "not SQLite");

    expect(listRestorableSnapshots(databasePath, snapshotDirectory)).toEqual([real.path]);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "zeus-snapshot-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function spawnLockHolder(
  path: string,
  holdMilliseconds: number,
): { ready: Promise<void>; done: Promise<void> } {
  const script = `
    const fs = require("node:fs");
    const path = process.argv[1];
    const hold = Number(process.argv[2]);
    fs.writeFileSync(path, JSON.stringify({ pid: process.pid }) + "\\n", { flag: "wx", mode: 0o600 });
    process.stdout.write("locked\\n");
    setTimeout(() => { fs.unlinkSync(path); process.exit(0); }, hold);
  `;
  const child = spawn(process.execPath, ["-e", script, path, String(holdMilliseconds)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk: string) => {
      if (chunk.includes("locked")) resolveReady();
      else rejectReady(new Error(`Unexpected lock-holder output: ${chunk}`));
    });
    child.once("error", rejectReady);
  });
  const done = new Promise<void>((resolveDone, rejectDone) => {
    child.once("exit", (code) => {
      if (code === 0) resolveDone();
      else rejectDone(new Error(`Lock holder exited ${String(code)}: ${stderr}`));
    });
    child.once("error", rejectDone);
  });
  return { ready, done };
}

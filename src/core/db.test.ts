import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listManagedMigrationBackups,
  migrate,
  openTestDb,
  purgeManagedMigrationBackups,
} from "./db";
import type { Migration } from "./migrations";

const FIRST: Migration = {
  id: "001_init",
  sql: "CREATE TABLE private_memory (value TEXT NOT NULL);",
};
const SECOND: Migration = {
  id: "002_seed",
  sql: "ALTER TABLE private_memory ADD COLUMN category TEXT;",
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("serialized migrations and verified backups", () => {
  it("backs up the committed pre-migration state beside an existing store", () => {
    const { db, path } = existingStore();
    db.prepare("INSERT INTO private_memory (value) VALUES (?)").run("only in backup");

    migrate(db, [FIRST, SECOND]);

    const backups = listManagedMigrationBackups(path);
    expect(backups).toHaveLength(1);
    const backupPath = backups[0];
    expect(backupPath).toBeDefined();
    expect(lstatSync(backupPath!).isSymbolicLink()).toBe(false);
    expect(lstatSync(backupPath!).mode & 0o777).toBe(0o600);

    const backup = new Database(backupPath!, { readonly: true, fileMustExist: true });
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(backup.prepare("SELECT value FROM private_memory").pluck().all()).toEqual([
      "only in backup",
    ]);
    expect(
      backup.prepare("SELECT id FROM schema_migration ORDER BY id").pluck().all(),
    ).toEqual([FIRST.id]);
    expect(() => backup.prepare("SELECT category FROM private_memory").get()).toThrow();
    backup.close();

    expect(
      db.prepare("SELECT id FROM schema_migration ORDER BY id").pluck().all(),
    ).toEqual([FIRST.id, SECOND.id]);
    db.close();
  });

  it("puts a backup beside the exact database file rather than beside a symlink", () => {
    const directory = temporaryDirectory();
    const databaseDirectory = join(directory, "store");
    const aliasDirectory = join(directory, "alias");
    mkdirSync(databaseDirectory);
    mkdirSync(aliasDirectory);
    const actualPath = join(databaseDirectory, "zeus.db");
    const aliasPath = join(aliasDirectory, "zeus.db");
    const seed = database(actualPath);
    migrate(seed, [FIRST]);
    seed.close();
    symlinkSync(actualPath, aliasPath);

    const throughAlias = database(aliasPath);
    migrate(throughAlias, [FIRST, SECOND]);
    throughAlias.close();

    expect(listManagedMigrationBackups(actualPath)).toHaveLength(1);
    expect(listManagedMigrationBackups(aliasPath)).toEqual([]);
  });

  it("does not back up memory, a new store, or an already-current store", () => {
    const memory = new Database(":memory:");
    migrate(memory, [FIRST]);
    migrate(memory, [FIRST]);
    expect(listManagedMigrationBackups(":memory:")).toEqual([]);
    memory.close();

    const directory = temporaryDirectory();
    const path = join(directory, "new.db");
    const fresh = database(path);
    migrate(fresh, [FIRST, SECOND]);
    expect(listManagedMigrationBackups(path)).toEqual([]);
    migrate(fresh, [FIRST, SECOND]);
    expect(listManagedMigrationBackups(path)).toEqual([]);
    fresh.close();
  });

  it("aborts before schema changes when backup verification fails", () => {
    const { db, path } = existingStore();
    vi.spyOn(db, "serialize").mockReturnValue(Buffer.from("not a sqlite database"));

    expect(() => migrate(db, [FIRST, SECOND])).toThrow();

    expect(
      db.prepare("SELECT id FROM schema_migration ORDER BY id").pluck().all(),
    ).toEqual([FIRST.id]);
    expect(() => db.prepare("SELECT category FROM private_memory").get()).toThrow();
    expect(listManagedMigrationBackups(path)).toEqual([]);
    db.close();
  });

  it("waits for the migration writer and rechecks the ledger after acquiring the lock", async () => {
    const { db, path } = existingStore();
    db.pragma("busy_timeout = 5000");
    const child = spawnMigrationWriter(path);
    await child.ready;

    migrate(db, [FIRST, SECOND]);
    await child.done;

    expect(
      db.prepare("SELECT id FROM schema_migration ORDER BY id").pluck().all(),
    ).toEqual([FIRST.id, SECOND.id]);
    expect(db.prepare("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'private_memory_2'").pluck().get()).toBe(1);
    // This process observed no pending migration once its reserved lock was granted.
    expect(listManagedMigrationBackups(path)).toEqual([]);
    db.close();
  });

  it.each([
    ["unknown", [FIRST.id, "999_unknown"]],
    ["gap", [SECOND.id]],
    ["out of order", [SECOND.id, FIRST.id]],
  ])("fails closed on a %s migration ledger", (_label, ledger) => {
    const path = join(temporaryDirectory(), "drifted.db");
    const db = database(path);
    db.exec(`
      CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    `);
    const insert = db.prepare("INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)");
    for (const id of ledger) insert.run(id, "2026-08-12T00:00:00.000Z");

    expect(() => migrate(db, [FIRST, SECOND])).toThrow(/exact ordered prefix/u);
    expect(
      db.prepare("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'private_memory'").pluck().get(),
    ).toBe(0);
    expect(listManagedMigrationBackups(path)).toEqual([]);
    db.close();
  });

  it("enables FTS5 secure-delete on every searchable memory table", () => {
    const db = openTestDb();

    for (const table of ["fact_fts", "message_fts", "passage_fts", "facet_fts"]) {
      expect(
        db.prepare(`SELECT v FROM ${table}_config WHERE k = 'secure-delete'`).pluck().get(),
      ).toBe(1);
    }
    db.close();
  });
});

describe("managed migration backup cleanup", () => {
  it("purges only regular backups belonging to the exact database", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "zeus.db");
    const db = database(path);
    migrate(db, [FIRST]);
    migrate(db, [FIRST, SECOND]);
    db.close();
    const managed = listManagedMigrationBackups(path)[0];
    expect(managed).toBeDefined();
    const lookalike = `${path}.pre-migration-lookalike.backup`;
    const otherDatabase = join(directory, "other.db.pre-migration-2026-08-12.backup");
    const arbitrary = `${path}.backup`;
    const symlink = `${path}.pre-migration-symlink.backup`;
    writeFileSync(lookalike, "not a Zeus SQLite backup", { mode: 0o600 });
    writeFileSync(otherDatabase, "other", { mode: 0o600 });
    writeFileSync(arbitrary, "arbitrary", { mode: 0o600 });
    symlinkSync(arbitrary, symlink);

    expect(listManagedMigrationBackups(path)).toEqual([managed]);
    expect(purgeManagedMigrationBackups(path)).toBe(1);
    expect(listManagedMigrationBackups(path)).toEqual([]);
    expect(readFileSync(lookalike, "utf8")).toBe("not a Zeus SQLite backup");
    expect(readFileSync(otherDatabase, "utf8")).toBe("other");
    expect(readFileSync(arbitrary, "utf8")).toBe("arbitrary");
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
  });
});

function existingStore(): { db: Database.Database; path: string } {
  const path = join(temporaryDirectory(), "zeus.db");
  const db = database(path);
  migrate(db, [FIRST]);
  return { db, path };
}

function database(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  chmodSync(path, 0o600);
  return db;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "zeus-db-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function spawnMigrationWriter(path: string): {
  ready: Promise<void>;
  done: Promise<void>;
} {
  const script = `
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1]);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => {
      db.exec("CREATE TABLE private_memory_2 (id INTEGER); INSERT INTO schema_migration (id, applied_at) VALUES ('002_seed', '2026-08-12T00:00:00.000Z'); COMMIT");
      db.close();
      process.exit(0);
    }, 150);
  `;
  const child = spawn(process.execPath, ["-e", script, path], {
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
      else rejectReady(new Error(`Unexpected migration-writer output: ${chunk}`));
    });
    child.once("error", rejectReady);
  });
  const done = new Promise<void>((resolveDone, rejectDone) => {
    child.once("exit", (code) => {
      if (code === 0) resolveDone();
      else rejectDone(new Error(`Migration writer exited ${String(code)}: ${stderr}`));
    });
    child.once("error", rejectDone);
  });
  return { ready, done };
}

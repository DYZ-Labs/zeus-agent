import Database from "better-sqlite3";
import { spawn } from "node:child_process";

// db.ts binds `statfsSync` as a named ESM import, so a spy on the module object would
// not intercept it. Mock with passthrough and let one test substitute a full volume.
const fsMocks = vi.hoisted(() => ({
  statfs: null as null | (() => { bavail: number; bsize: number }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statfsSync: (...args: Parameters<typeof actual.statfsSync>) =>
      fsMocks.statfs ? fsMocks.statfs() : actual.statfsSync(...args),
  };
});

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
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MIGRATION_BACKUP_RETENTION,
  listManagedMigrationBackups,
  migrate,
  openTestDb,
  purgeManagedMigrationBackups,
} from "./db";
import { MIGRATIONS, type Migration } from "./migrations";
import { CAPABILITY_SLOT_EFFECTS, CapabilitySlot } from "./schema";
import { SAFE_EFFECT_KINDS } from "./work-plans";
import { ACCOUNTS_DIRECTORY } from "./stores";

const FIRST: Migration = {
  id: "001_init",
  sql: "CREATE TABLE private_memory (value TEXT NOT NULL);",
};
const SECOND: Migration = {
  id: "002_seed",
  sql: "ALTER TABLE private_memory ADD COLUMN category TEXT;",
};
const THIRD: Migration = {
  id: "003_note",
  sql: "ALTER TABLE private_memory ADD COLUMN note TEXT;",
};
/** A pair that leaves a child row pointing at a parent that was never written. */
const LINKED: Migration = {
  id: "004_link",
  sql: `
    CREATE TABLE evidence (id INTEGER PRIMARY KEY);
    CREATE TABLE claim (id INTEGER PRIMARY KEY, evidence_id INTEGER REFERENCES evidence(id));
  `,
};
const ORPHANED: Migration = {
  id: "005_orphan",
  sql: "INSERT INTO claim (id, evidence_id) VALUES (1, 404);",
};

const ACCOUNT_ID = "019ff232-f8e0-7ce2-8e83-d416444aed06";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  // Migrating an on-disk store reports itself. Capture those lines rather than letting
  // every store test in this file print them.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fsMocks.statfs = null;
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

// A hosted deployment migrates its primary store during the health check, and every
// other account's store on that account's next request — possibly days later, in a
// process nobody is watching. These are the only lines that say a schema change happened
// at all, so they have to be present, distinguishable, and free of the store's path.
describe("visibility of a schema change", () => {
  it("reports the start of pending work and the end of it", () => {
    const { db } = existingStore();
    forgetEvents();

    migrate(db, [FIRST, SECOND]);

    const events = emittedEvents();
    expect(events).toEqual([
      // No outcome on the start line: there is not one yet, and a migration killed
      // between these two lines is exactly what the first one is for.
      { event: "migration_started", store: "primary", count: 1 },
      {
        event: "migration_applied",
        outcome: "ok",
        store: "primary",
        count: 1,
        duration_ms: expect.any(Number),
      },
    ]);
    db.close();
  });

  it("counts the whole backlog when a store has fallen several releases behind", () => {
    const { db } = existingStore();
    forgetEvents();

    migrate(db, [FIRST, SECOND, THIRD]);

    expect(emittedEvents().map((event) => event.count)).toEqual([2, 2]);
    db.close();
  });

  it("stays silent for a store that is already current", () => {
    const { db } = existingStore();
    forgetEvents();

    migrate(db, [FIRST]);

    // An event per connection would drown the log and hide the one migration that
    // matters; every ordinary open of a healthy store lands here.
    expect(emittedEvents()).toEqual([]);
    db.close();
  });

  it("keeps a throwaway in-memory store out of the log entirely", () => {
    // openTestDb() applies the whole ledger, and every suite in the repository calls it.
    const memory = openTestDb();

    expect(emittedEvents()).toEqual([]);
    memory.close();
  });

  it("names the rollback case rather than reporting a generic failure", () => {
    const path = join(temporaryDirectory(), "drifted.db");
    const db = database(path);
    db.exec("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
    const insert = db.prepare("INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)");
    for (const id of [FIRST.id, "999_unknown"]) insert.run(id, "2026-08-12T00:00:00.000Z");
    forgetEvents();

    expect(() => migrate(db, [FIRST, SECOND])).toThrow(/exact ordered prefix/u);

    // The store is ahead of the code: the fix is to roll the deploy forward, never to
    // touch the database. Nothing else in the log says that.
    expect(emittedEvents()).toEqual([
      {
        event: "migration_failed",
        outcome: "error",
        reason: "ledger_mismatch",
        store: "primary",
        duration_ms: expect.any(Number),
        error_name: "Error",
        error_site: expect.stringMatching(/^src\/core\/db\.ts:\d+$/u),
      },
    ]);
    db.close();
  });

  it("separates a volume with no room from a store that cannot migrate", () => {
    const { db } = storeAtMigration(1);
    fsMocks.statfs = () => ({ bavail: 0, bsize: 4096 });
    forgetEvents();

    expect(() => migrate(db, MIGRATIONS.slice(0, 2))).toThrow(/Not enough free space/u);

    const events = emittedEvents();
    expect(events.map((event) => event.event)).toEqual([
      "migration_started",
      "migration_failed",
    ]);
    expect(events[1]).toMatchObject({
      outcome: "error",
      reason: "backup_space",
      store: "primary",
      // The work that was pending when it failed, not a guess at what got applied.
      count: 1,
    });
    db.close();
  });

  it("reports provenance that did not survive the schema change", () => {
    const db = database(join(temporaryDirectory(), "linked.db"));
    forgetEvents();

    expect(() => migrate(db, [LINKED, ORPHANED])).toThrow(/dangling references/u);

    // One account's evidence links broken while every other account is fine: without
    // this the only symptom is that person's memory never loading.
    expect(emittedEvents()[1]).toMatchObject({
      event: "migration_failed",
      outcome: "error",
      reason: "dangling_references",
      count: 2,
    });
    db.close();
  });

  it("distinguishes an account store from the primary one", () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, ACCOUNTS_DIRECTORY));
    const path = join(directory, ACCOUNTS_DIRECTORY, `${ACCOUNT_ID}.db`);
    const db = database(path);
    forgetEvents();

    migrate(db, [FIRST]);

    const events = emittedEvents();
    expect(events.map((event) => event.store)).toEqual(["account", "account"]);
    // Which account, not merely that it was one: "this person cannot open their memory"
    // and "nobody can" are the same line without it. The file name is the account's own
    // pseudonymous UUID, which is what the `account` field carries everywhere else — so
    // it is reported through that field, where the allowlist validates its shape, rather
    // than as part of a path.
    expect(events.map((event) => event.account)).toEqual([ACCOUNT_ID, ACCOUNT_ID]);
    db.close();
  });

  it("never writes a store's location, however the migration ends", () => {
    const { db, path } = existingStore();
    forgetEvents();

    migrate(db, [FIRST, SECOND]);
    fsMocks.statfs = () => ({ bavail: 0, bsize: 4096 });
    // This failure's own message quotes the database file name; the log may not.
    expect(() => migrate(db, [FIRST, SECOND, THIRD])).toThrow(/zeus\.db/u);

    const events = emittedEvents();
    // Anchored before the absence is asserted. An empty array contains no path either, so
    // without this the whole check would keep passing if the events stopped being emitted
    // at all — reading as assurance while proving nothing.
    expect(events.map((event) => event.event)).toContain("migration_failed");
    expect(events.length).toBeGreaterThan(1);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain(dirname(path));
    expect(serialized).not.toContain(basename(path));
    expect(serialized).not.toContain(basename(dirname(path)));
    expect(serialized).not.toContain(tmpdir());
    db.close();
  });
});

// 023 relaxes a CHECK on work_step, which SQLite can only do by swapping the table out.
// Four tables reference it, so a modern RENAME would repoint them at the legacy copy and
// then cascade their rows away on DROP. These assertions are the reason the migration
// brackets itself in legacy_alter_table.
describe("external-action migration rebuilds work_step in place", () => {
  const externalActionsIndex = MIGRATIONS.findIndex(
    (migration) => migration.id === "023_external_actions",
  );
  const upToTwentyTwo = MIGRATIONS.slice(0, externalActionsIndex);
  const externalActions = MIGRATIONS[externalActionsIndex];

  function storeAtTwentyTwo(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, upToTwentyTwo);
    db.exec(`
      INSERT INTO conversation (id, title, source, started_at, updated_at)
      VALUES (1, 'Work requests', 'web', '2026-08-14T00:00:00.000Z',
              '2026-08-14T00:00:00.000Z');
      INSERT INTO message (id, conversation_id, role, content, created_at)
      VALUES (1, 1, 'user', 'compare the options', '2026-08-14T00:00:00.000Z');
      INSERT INTO work_plan
        (id, objective, status, plan_hash, allowed_effects_json, completion_criteria_json,
         max_steps, max_model_tool_calls, max_retries_per_step, max_duration_seconds,
         source_message_id, origin, created_at, updated_at)
      VALUES (1, 'compare', 'authorized', '${"a".repeat(64)}', '["memory_read"]', '["done"]',
              12, 20, 2, 900, 1, 'explicit_request', '2026-08-14T00:00:00.000Z',
              '2026-08-14T00:00:00.000Z');
      INSERT INTO work_step (id, work_plan_id, position, title, instruction, effect_kind, status)
      VALUES (10, 1, 1, 'recall', 'recall memory', 'memory_read', 'completed'),
             (11, 1, 2, 'draft', 'draft a brief', 'prepare_local', 'pending');
      INSERT INTO work_step_dependency (work_step_id, depends_on_step_id) VALUES (11, 10);
      INSERT INTO work_authorization
        (id, work_plan_id, plan_hash, authorization_kind, allowed_effects_json,
         max_model_tool_calls, max_retries_per_step, max_duration_seconds, expires_at,
         source_message_id, created_at)
      VALUES (1, 1, '${"a".repeat(64)}', 'explicit_request', '["memory_read"]', 20, 2, 900,
              '2099-01-01T00:00:00.000Z', 1, '2026-08-14T00:00:00.000Z');
      INSERT INTO work_run
        (id, work_plan_id, authorization_id, plan_hash, status, model_call_count,
         tool_call_count, started_at, updated_at, deadline_at)
      VALUES (1, 1, 1, '${"a".repeat(64)}', 'completed', 0, 1, '2026-08-14T00:00:00.000Z',
              '2026-08-14T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      INSERT INTO work_artifact
        (id, work_plan_id, work_run_id, work_step_id, kind, title, content, citations_json,
         created_at, updated_at)
      VALUES (1, 1, 1, 10, 'research_notes', 'notes', 'body', '[]',
              '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO tool_receipt
        (id, work_run_id, work_step_id, tool_name, effect_kind, call_index, input_json,
         output_json, citations_json, status, idempotency_key, started_at, completed_at)
      VALUES (1, 1, 10, 'memory_recall', 'memory_read', 1, '{}', '{}', '[]', 'completed',
              'idem-1', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);
    return db;
  }

  it("keeps every dependent row and reference across the swap", () => {
    if (!externalActions) throw new Error("023_external_actions is missing");
    const db = storeAtTwentyTwo();

    migrate(db, MIGRATIONS);

    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT id FROM work_step ORDER BY id").pluck().all()).toEqual([10, 11]);
    expect(db.prepare("SELECT depends_on_step_id FROM work_step_dependency").pluck().all())
      .toEqual([10]);
    expect(db.prepare("SELECT work_step_id FROM work_artifact").pluck().all()).toEqual([10]);
    expect(db.prepare("SELECT work_step_id FROM tool_receipt").pluck().all()).toEqual([10]);
    const dependencySql = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'work_step_dependency'")
      .pluck()
      .get() as string;
    expect(dependencySql).toMatch(/REFERENCES work_step\s*\(/u);
    expect(dependencySql).not.toMatch(/safe_legacy/u);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'work_step_plan_idx'",
        )
        .pluck()
        .get(),
    ).toBe("work_step_plan_idx");
    db.close();
  });

  it("admits external reads while still refusing to record a purchase", () => {
    const db = storeAtTwentyTwo();
    migrate(db, MIGRATIONS);

    db.exec(
      `INSERT INTO work_step (work_plan_id, position, title, instruction, effect_kind)
       VALUES (1, 3, 'calendar', 'read the calendar', 'external_read')`,
    );

    expect(
      db.prepare("SELECT effect_kind FROM work_step WHERE position = 3").pluck().get(),
    ).toBe("external_read");
    expect(() =>
      db.exec(
        `INSERT INTO tool_receipt
           (work_run_id, tool_name, effect_kind, call_index, input_json, status,
            idempotency_key, started_at)
         VALUES (1, 'connector_call', 'purchase', 2, '{}', 'started', 'idem-2',
                 '2026-08-14T00:00:00.000Z')`,
      ),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      db.exec(
        `INSERT INTO tool_receipt
           (work_run_id, tool_name, effect_kind, call_index, input_json, status,
            idempotency_key, started_at)
         VALUES (1, 'connector_call', 'schedule', 3, '{}', 'started', 'idem-3',
                 '2026-08-14T00:00:00.000Z')`,
      ),
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });

  it("refuses an effect decision that cites an assistant message", () => {
    const db = storeAtTwentyTwo();
    migrate(db, MIGRATIONS);
    db.exec(`
      INSERT INTO message (id, conversation_id, role, content, created_at)
      VALUES (2, 1, 'assistant', 'I have scheduled it', '2026-08-14T00:00:00.000Z');
      INSERT INTO connector
        (id, label, transport, command, source_message_id, status, created_at, updated_at)
      VALUES (1, 'Calendar', 'stdio', 'node', 1, 'ready', '2026-08-14T00:00:00.000Z',
              '2026-08-14T00:00:00.000Z');
      INSERT INTO connector_capability
        (id, connector_id, slot, remote_tool_name, effect_kind, input_schema_json,
         schema_hash, enabled, source_message_id, created_at, updated_at)
      VALUES (1, 1, 'calendar.create_event', 'create_event', 'schedule', '{}',
              '${"b".repeat(64)}', 1, 1, '2026-08-14T00:00:00.000Z',
              '2026-08-14T00:00:00.000Z');
      INSERT INTO proposed_effect
        (id, work_run_id, work_step_id, connector_capability_id, effect_kind, payload_json,
         payload_hash, preview_text, idempotency_key, provider_request_key, expires_at,
         created_at, updated_at)
      VALUES (1, 1, 11, 1, 'schedule', '{"title":"Dinner"}', '${"c".repeat(64)}',
              'Create Dinner', 'effect-1', 'req-1', '2099-01-01T00:00:00.000Z',
              '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);

    expect(() =>
      db.exec(
        `INSERT INTO effect_event (proposed_effect_id, event_type, source_message_id, created_at)
         VALUES (1, 'confirmed', 2, '2026-08-14T00:00:00.000Z')`,
      ),
    ).toThrow(/must cite a user message/u);

    db.exec(
      `INSERT INTO effect_event (proposed_effect_id, event_type, source_message_id, created_at)
       VALUES (1, 'confirmed', 1, '2026-08-14T00:00:00.000Z')`,
    );
    expect(() =>
      db.exec("UPDATE effect_event SET event_type = 'declined' WHERE proposed_effect_id = 1"),
    ).toThrow(/append-only/u);
    db.close();
  });
});

describe("connector preset migration", () => {
  it("preserves manual connectors and permits only one row per preset", () => {
    const presetMigrationIndex = MIGRATIONS.findIndex(
      (migration) => migration.id === "024_connector_presets",
    );
    const beforePresets = MIGRATIONS.slice(0, presetMigrationIndex);
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, beforePresets);
    db.exec(`
      INSERT INTO conversation (id, title, source, started_at, updated_at)
      VALUES (1001, 'Connections', 'web', '2026-08-14T00:00:00.000Z',
              '2026-08-14T00:00:00.000Z');
      INSERT INTO message (id, conversation_id, role, content, created_at)
      VALUES (1001, 1001, 'user', 'connect my calendar', '2026-08-14T00:00:00.000Z');
      INSERT INTO connector
        (id, label, transport, command, source_message_id, created_at, updated_at)
      VALUES (1001, 'Manual calendar', 'stdio', 'node', 1001,
              '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);

    migrate(db, MIGRATIONS);

    expect(
      db.prepare("SELECT preset_id FROM connector WHERE id = 1001").get(),
    ).toEqual({ preset_id: null });
    db.exec(`
      UPDATE connector SET preset_id = 'google-calendar-official' WHERE id = 1001;
      INSERT INTO connector
        (id, label, transport, command, source_message_id, created_at, updated_at)
      VALUES (1002, 'Another manual server', 'stdio', 'node', 1001,
              '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);
    expect(() =>
      db.exec(`
        UPDATE connector
        SET preset_id = 'google-calendar-official'
        WHERE id = 1002;
      `),
    ).toThrow(/UNIQUE constraint failed/u);
    expect(
      db.prepare("SELECT COUNT(*) FROM connector WHERE preset_id IS NULL").pluck().get(),
    ).toBe(1);
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

// These use real MIGRATIONS slices rather than the synthetic FIRST/SECOND pair above:
// a managed backup is only listed when its ledger is a genuine prefix of this build, so
// invented migration ids produce copies that verification correctly refuses to see.
describe("bounded migration backup retention", () => {
  it("keeps only the newest copies as releases accumulate", () => {
    const { db, path } = storeAtMigration(1);
    vi.stubEnv("ZEUS_MIGRATION_BACKUP_RETENTION", "2");

    // Four migrating releases against the same store.
    for (let count = 2; count <= 5; count += 1) migrate(db, MIGRATIONS.slice(0, count));

    const backups = listManagedMigrationBackups(path);
    expect(backups).toHaveLength(2);
    // The survivors are the newest — the ones a rollback would actually reach for.
    expect(ledgerOf(backups.at(-1)!)).toEqual(migrationIds(4));
    expect(ledgerOf(backups[0]!)).toEqual(migrationIds(3));
  });

  it("still keeps this migration's own copy at the minimum retention", () => {
    const { db, path } = storeAtMigration(1);
    vi.stubEnv("ZEUS_MIGRATION_BACKUP_RETENTION", "1");

    migrate(db, MIGRATIONS.slice(0, 2));
    migrate(db, MIGRATIONS.slice(0, 3));

    const backups = listManagedMigrationBackups(path);
    expect(backups).toHaveLength(1);
    expect(ledgerOf(backups[0]!)).toEqual(migrationIds(2));
  });

  it("defaults to a bounded number rather than growing forever", () => {
    const { db, path } = storeAtMigration(1);

    for (let count = 2; count <= 6; count += 1) migrate(db, MIGRATIONS.slice(0, count));

    expect(listManagedMigrationBackups(path)).toHaveLength(
      DEFAULT_MIGRATION_BACKUP_RETENTION,
    );
  });

  it("never prunes a copy belonging to another database", () => {
    const { db, path } = storeAtMigration(1);
    const { db: otherDb, path: other } = storeAtMigration(1);
    migrate(otherDb, MIGRATIONS.slice(0, 2));
    otherDb.close();
    vi.stubEnv("ZEUS_MIGRATION_BACKUP_RETENTION", "1");

    migrate(db, MIGRATIONS.slice(0, 2));
    migrate(db, MIGRATIONS.slice(0, 3));

    expect(listManagedMigrationBackups(path)).toHaveLength(1);
    expect(listManagedMigrationBackups(other)).toHaveLength(1);
  });

  it("rejects a retention setting that would disable rollback", () => {
    const { db } = storeAtMigration(1);
    vi.stubEnv("ZEUS_MIGRATION_BACKUP_RETENTION", "0");

    expect(() => migrate(db, MIGRATIONS.slice(0, 2))).toThrow(/between 1 and 1000/u);
  });

  it("refuses to start a backup the volume cannot hold, before any schema change", () => {
    const { db, path } = storeAtMigration(1);
    // A volume with no usable blocks left.
    fsMocks.statfs = () => ({ bavail: 0, bsize: 4096 });

    expect(() => migrate(db, MIGRATIONS.slice(0, 2))).toThrow(/Not enough free space/u);
    expect(listManagedMigrationBackups(path)).toEqual([]);
    // Failing early means the schema is untouched, not half-migrated.
    expect(ledgerOf(path)).toEqual(migrationIds(1));
  });
});

function storeAtMigration(count: number): { db: Database.Database; path: string } {
  const path = join(temporaryDirectory(), "zeus.db");
  const db = database(path);
  migrate(db, MIGRATIONS.slice(0, count));
  return { db, path };
}

function migrationIds(count: number): string[] {
  return MIGRATIONS.slice(0, count).map((migration) => migration.id);
}

function ledgerOf(backupPath: string): string[] {
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    return backup
      .prepare<[], { id: string }>("SELECT id FROM schema_migration ORDER BY rowid")
      .all()
      .map((row) => row.id);
  } finally {
    backup.close();
  }
}

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

function emittedEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
}

/** Discard what setting the store up emitted; the assertions are about what follows. */
function forgetEvents(): void {
  vi.mocked(console.error).mockClear();
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

/**
 * 029 widens `calendar_outcome.kind` so a cleared window can be recorded at all.
 *
 * SQLite cannot alter a CHECK in place, so the table is rebuilt and copied — and an outcome
 * lost in that copy is a change Zeus made and can no longer say it made, which is exactly the
 * failure the table exists to prevent.
 */
describe("clear-window migration keeps every stored outcome", () => {
  const clearIndex = MIGRATIONS.findIndex(
    (migration) => migration.id === "030_calendar_clear_outcome_kind",
  );
  const beforeClear = MIGRATIONS.slice(0, clearIndex);

  function storeAtTwentyEight(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, beforeClear);
    db.exec(`
      INSERT INTO conversation (id, title, source, started_at, updated_at)
      VALUES (1, 'Calendar', 'web', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO message (id, conversation_id, role, content, created_at)
      VALUES (1, 1, 'user', 'add lunch', '2026-08-14T00:00:00.000Z'),
             (2, 1, 'assistant', 'Added.', '2026-08-14T00:00:00.000Z');
      INSERT INTO calendar_outcome
        (assistant_message_id, kind, status, outcome_json, created_at)
      VALUES (2, 'create', 'done', '{"kind":"create"}', '2026-08-14T00:00:00.000Z');
    `);
    return db;
  }

  it("carries existing rows across and accepts the new kind", () => {
    const db = storeAtTwentyEight();
    expect(() =>
      db
        .prepare(
          `INSERT INTO calendar_outcome
             (assistant_message_id, kind, status, outcome_json, created_at)
           VALUES (1, 'clear', 'done', '{}', '2026-08-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();

    migrate(db, MIGRATIONS.slice(0, clearIndex + 1));

    expect(
      db.prepare("SELECT kind, status FROM calendar_outcome WHERE assistant_message_id = 2").get(),
    ).toEqual({ kind: "create", status: "done" });
    db.prepare(
      `INSERT INTO calendar_outcome
         (assistant_message_id, kind, status, outcome_json, created_at)
       VALUES (1, 'clear', 'awaiting_confirmation', '{}', '2026-08-14T00:00:00.000Z')`,
    ).run();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM calendar_outcome").get(),
    ).toEqual({ count: 2 });
    db.close();
  });

  it("still refuses a kind nothing in the code can produce", () => {
    const db = storeAtTwentyEight();
    migrate(db, MIGRATIONS.slice(0, clearIndex + 1));
    expect(() =>
      db
        .prepare(
          `INSERT INTO calendar_outcome
             (assistant_message_id, kind, status, outcome_json, created_at)
           VALUES (1, 'purchase', 'done', '{}', '2026-08-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("keeps the row tied to its message, so deleting a source still takes it", () => {
    const db = storeAtTwentyEight();
    migrate(db, MIGRATIONS.slice(0, clearIndex + 1));
    db.prepare("DELETE FROM message WHERE id = 2").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM calendar_outcome").get()).toEqual({
      count: 0,
    });
    db.close();
  });
});

// 033 widens the capability-slot CHECK for email, which again means swapping the table out.
// `connector_capability` is the first rebuild target that write-path ledgers point at:
// `proposed_effect` is ON DELETE RESTRICT and `tool_receipt` is ON DELETE SET NULL, so a
// modern RENAME would repoint both at the legacy copy and the DROP would take a receipt's
// provenance with it. Same bracketing as 023, asserted the same way.
describe("email-slot migration rebuilds connector_capability in place", () => {
  const emailSlotsIndex = MIGRATIONS.findIndex(
    (migration) => migration.id === "033_email_capability_slots",
  );
  const upToThirtyTwo = MIGRATIONS.slice(0, emailSlotsIndex);

  function storeAtThirtyTwo(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, upToThirtyTwo);
    const hash = "b".repeat(64);
    db.exec(`
      INSERT INTO conversation (id, title, source, started_at, updated_at)
      VALUES (1, 'Calendar', 'web', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
      INSERT INTO message (id, conversation_id, role, content, created_at)
      VALUES (1, 1, 'user', 'move my 3pm', '2026-08-19T00:00:00.000Z');
      INSERT INTO connector
        (id, label, transport, url, status, enabled, source_message_id, created_at, updated_at)
      VALUES (1, 'Calendar', 'http', 'https://example.test/mcp', 'ready', 1, 1,
              '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
      INSERT INTO connector_capability
        (id, connector_id, slot, remote_tool_name, effect_kind, input_schema_json, schema_hash,
         enabled, source_message_id, created_at, updated_at)
      VALUES (7, 1, 'calendar.update_event', 'update_event', 'modify_external', '{}', '${hash}',
              1, 1, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
      INSERT INTO work_plan
        (id, objective, status, plan_hash, allowed_effects_json, completion_criteria_json,
         max_steps, max_model_tool_calls, max_retries_per_step, max_duration_seconds,
         source_message_id, origin, created_at, updated_at)
      VALUES (1, 'move it', 'authorized', '${hash}', '["modify_external"]', '["done"]',
              12, 20, 2, 900, 1, 'explicit_request', '2026-08-19T00:00:00.000Z',
              '2026-08-19T00:00:00.000Z');
      INSERT INTO work_step (id, work_plan_id, position, title, instruction, effect_kind, status)
      VALUES (10, 1, 1, 'move', 'move the event', 'modify_external', 'pending');
      INSERT INTO work_authorization
        (id, work_plan_id, plan_hash, authorization_kind, allowed_effects_json,
         max_model_tool_calls, max_retries_per_step, max_duration_seconds, expires_at,
         source_message_id, created_at)
      VALUES (1, 1, '${hash}', 'explicit_request', '["modify_external"]', 20, 2, 900,
              '2099-01-01T00:00:00.000Z', 1, '2026-08-19T00:00:00.000Z');
      INSERT INTO work_run
        (id, work_plan_id, authorization_id, plan_hash, status, model_call_count,
         tool_call_count, started_at, updated_at, deadline_at)
      VALUES (1, 1, 1, '${hash}', 'running', 0, 0, '2026-08-19T00:00:00.000Z',
              '2026-08-19T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      INSERT INTO proposed_effect
        (id, work_run_id, work_step_id, connector_capability_id, effect_kind, payload_json,
         payload_hash, preview_text, status, idempotency_key, provider_request_key,
         expires_at, created_at, updated_at)
      VALUES (1, 1, 10, 7, 'modify_external', '{}', '${"c".repeat(64)}', 'Move it',
              'pending_confirmation', 'idem-1', 'req-1', '2099-01-01T00:00:00.000Z',
              '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
      INSERT INTO tool_receipt
        (id, work_run_id, work_step_id, connector_capability_id, tool_name, effect_kind,
         call_index, input_json, output_json, citations_json, status, idempotency_key,
         started_at)
      VALUES (1, 1, 10, 7, 'connector_call', 'modify_external', 1, '{}', '{}', '[]', 'completed',
              'idem-r1', '2026-08-19T00:00:00.000Z');
    `);
    return db;
  }

  it("keeps the capability and both ledgers pointing at it across the swap", () => {
    const db = storeAtThirtyTwo();

    migrate(db, MIGRATIONS);

    expect(db.pragma("foreign_key_check")).toEqual([]);
    // Same row, same id — the id is what the two ledgers hold.
    expect(db.prepare("SELECT slot FROM connector_capability WHERE id = 7").pluck().get())
      .toBe("calendar.update_event");
    expect(db.prepare("SELECT connector_capability_id FROM proposed_effect").pluck().all())
      .toEqual([7]);
    expect(db.prepare("SELECT connector_capability_id FROM tool_receipt").pluck().all())
      .toEqual([7]);
    // The references name the live table, not the copy that was dropped.
    for (const table of ["proposed_effect", "tool_receipt"]) {
      const sql = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
        .pluck()
        .get(table) as string;
      expect(sql).toMatch(/REFERENCES connector_capability\s*\(/u);
      expect(sql).not.toMatch(/email_legacy/u);
    }
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'connector_capability_slot_idx'",
        )
        .pluck()
        .get(),
    ).toBe("connector_capability_slot_idx");
    db.close();
  });

  it("still refuses to delete a capability a pending request depends on", () => {
    // ON DELETE RESTRICT is the whole reason the reference has to survive: a grant cannot be
    // deleted out from under a request the user has not answered yet.
    const db = storeAtThirtyTwo();
    migrate(db, MIGRATIONS);

    expect(() => db.exec("DELETE FROM connector_capability WHERE id = 7")).toThrow(
      /FOREIGN KEY/u,
    );
    db.close();
  });

  it("pairs every email slot with exactly one effect kind, send included", () => {
    const db = storeAtThirtyTwo();
    migrate(db, MIGRATIONS);

    const insert = (slot: string, effect: string) =>
      db.exec(
        `INSERT INTO connector_capability
           (connector_id, slot, remote_tool_name, effect_kind, input_schema_json, schema_hash,
            enabled, source_message_id, created_at, updated_at)
         VALUES (1, '${slot}', 'tool', '${effect}', '{}', '${"d".repeat(64)}', 0, 1,
                 '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`,
      );

    expect(() => insert("email.search_threads", "external_read")).not.toThrow();
    expect(() => insert("email.get_thread", "external_read")).not.toThrow();
    expect(() => insert("email.create_draft", "modify_external")).not.toThrow();
    expect(() => insert("email.trash_thread", "modify_external")).not.toThrow();
    expect(() => insert("email.untrash_thread", "modify_external")).not.toThrow();
    expect(() => insert("email.send_message", "send")).not.toThrow();

    // This table used to refuse `send` outright, and a test here said so. It no longer does,
    // because the user asked for sending — so what survives is the narrower claim, and it is
    // the one that was doing the real work all along: exactly one slot may send, and it may
    // do nothing else.
    expect(() => insert("email.create_draft", "send")).toThrow(/CHECK/u);
    expect(() => insert("email.trash_thread", "send")).toThrow(/CHECK/u);
    expect(() => insert("email.untrash_thread", "send")).toThrow(/CHECK/u);
    expect(() => insert("calendar.update_event", "send")).toThrow(/CHECK/u);
    expect(() => insert("email.send_message", "modify_external")).toThrow(/CHECK/u);
    expect(() => insert("email.send_message", "external_read")).toThrow(/CHECK/u);
    db.close();
  });

  it("keeps sending out of reach of any plan a model writes", () => {
    // The database stopped being the thing that prevents a send, so this is where the
    // replacement guarantee is stated. `SAFE_EFFECT_KINDS` is the entire vocabulary a
    // generated proposal may use — `isSafeSurfacedProposal` rejects anything else before a
    // plan row exists — so `send` being absent from it is what keeps sending reachable only
    // from a builder written in this repository.
    expect(SAFE_EFFECT_KINDS as readonly string[]).not.toContain("send");
    expect(SAFE_EFFECT_KINDS as readonly string[]).not.toContain("modify_external");

    // And exactly one slot carries it, so reviewing the bound slots is still enough to know
    // what a connector may do.
    const senders = CapabilitySlot.options.filter(
      (slot) => CAPABILITY_SLOT_EFFECTS[slot] === "send",
    );
    expect(senders).toEqual(["email.send_message"]);
  });
});

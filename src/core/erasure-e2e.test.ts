import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import { listManagedMigrationBackups, openDb } from "./db";
import { recordFact } from "./facts";
import { mcpMutationRequestHash, recordMcpMutationEvent } from "./mcp-audit";
import { deleteConversationWithMemory } from "./retention";
import { selfEntity } from "./entities";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source erasure and export", () => {
  it("removes source bytes from the database/WAL and from a reused export destination", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "zeus-erasure-e2e-"));
    roots.push(root);
    const dbPath = join(root, "zeus.db");
    const exportPath = join(root, "export");
    const sentinel = `ERASE-ME-${randomUUID()}`;
    const db = openDb(dbPath);
    expect(db.pragma("secure_delete", { simple: true })).toBe(1);
    expect(
      db.prepare<[], { v: number }>(
        "SELECT v FROM message_fts_config WHERE k = 'secure-delete'",
      ).get()?.v,
    ).toBe(1);
    const conversation = createConversation(db, { title: `Private ${sentinel}` });
    const source = appendMessage(db, conversation.id, "user", `My private source is ${sentinel}.`);
    recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "note",
      object: sentinel,
      sourceMessageId: source.id,
    });
    const requestHash = mcpMutationRequestHash("zeus_update_open_loop", {
      note: sentinel,
    });
    recordMcpMutationEvent(db, {
      operationId: "erasure-e2e",
      toolName: "zeus_update_open_loop",
      requestHash,
      eventType: "approval_requested",
    });
    recordMcpMutationEvent(db, {
      operationId: "erasure-e2e",
      toolName: "zeus_update_open_loop",
      requestHash,
      eventType: "approved",
      sourceMessageId: source.id,
    });

    runExport(dbPath, exportPath);
    expect(readExportTree(exportPath)).toContain(sentinel);
    db.pragma("wal_checkpoint(TRUNCATE)");
    const managedBackup = `${dbPath}.pre-migration-test.backup`;
    copyFileSync(dbPath, managedBackup);
    expect(listManagedMigrationBackups(dbPath)).toEqual([managedBackup]);

    deleteConversationWithMemory(db, conversation.id);
    expect(
      db.prepare<[], { event_type: string }>(
        "SELECT event_type FROM mcp_mutation_event ORDER BY id",
      ).all(),
    ).toEqual([{ event_type: "approval_requested" }]);
    expect(listManagedMigrationBackups(dbPath)).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    runExport(dbPath, exportPath);
    expect(readExportTree(exportPath)).not.toContain(sentinel);
    db.close();

    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
    }
    expectPrivateTree(exportPath);
  });
});

function runExport(dbPath: string, exportPath: string): void {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/export.ts", exportPath], {
    cwd: process.cwd(),
    env: { ...process.env, ZEUS_DB: dbPath },
    stdio: "pipe",
  });
}

function readExportTree(root: string): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return files.join("\n");
}

function expectPrivateTree(root: string): void {
  const visit = (path: string): void => {
    const stat = statSync(path);
    expect(stat.mode & 0o077).toBe(0);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    }
  };
  // Prove the assertion is meaningful even under a permissive invoking umask.
  chmodSync(root, 0o700);
  visit(root);
}

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendMessage, createConversation } from "./conversations";
import { openDb, openTestDb } from "./db";
import { generateExportEntries } from "./export-generator";
import { collectSqliteExport } from "./export-sqlite";

describe("store-independent export", () => {
  it("renders the same portable entries from a serializable snapshot", () => {
    const db = openTestDb();
    const conversation = createConversation(db, { title: "Export me" });
    appendMessage(db, conversation.id, "user", "A unique export sentence.");
    const snapshot = collectSqliteExport(db, "2026-08-12T00:00:00.000Z");
    const entries = generateExportEntries(structuredClone(snapshot));

    expect(entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "conversations.md",
      "about-you.md",
      "plans.md",
      "review.md",
      "data.json",
    ]);
    expect(entries.find((entry) => entry.path === "conversations.md")?.content)
      .toContain("A unique export sentence.");
    expect(JSON.parse(entries.find((entry) => entry.path === "data.json")!.content))
      .toMatchObject({ format: "zeus-data-export", version: 1 });
    expect(snapshot.tables).toHaveProperty("response_context");
    expect(snapshot.tables).toHaveProperty("memory_job");
    expect(snapshot.tables).not.toHaveProperty("message_fts");
  });

  it("keeps every exported table on one SQLite read snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "zeus-export-snapshot-"));
    const path = join(directory, "zeus.db");
    const reader = openDb(path);
    const writer = openDb(path);
    try {
      const conversation = createConversation(reader, { title: "Snapshot" });
      appendMessage(reader, conversation.id, "user", "Present before the snapshot.");

      // Establish the reader snapshot, then commit a concurrent writer. The export
      // transaction must consistently see the earlier database version.
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM message").get();
      appendMessage(writer, conversation.id, "user", "Committed during the snapshot.");
      const snapshot = collectSqliteExport(reader, "2026-08-12T00:00:00.000Z");
      reader.exec("COMMIT");

      expect(snapshot.tables.message?.map((row) => row.content)).toEqual([
        "Present before the snapshot.",
      ]);
      expect(writer.prepare("SELECT COUNT(*) AS count FROM message").get())
        .toEqual({ count: 2 });
    } finally {
      if (reader.inTransaction) reader.exec("ROLLBACK");
      reader.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

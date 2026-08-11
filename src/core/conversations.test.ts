import { describe, expect, it } from "vitest";

import {
  appendMessage,
  createConversation,
  listRecentChats,
} from "./conversations";
import { openTestDb } from "./db";

describe("recent chats", () => {
  it("uses the first user message as a title and excludes memory curation", () => {
    const db = openTestDb();
    const older = createConversation(db);
    const newer = createConversation(db, { title: "Named chat" });
    const curation = createConversation(db, { title: "Memory curation" });

    appendMessage(db, older.id, "user", "  Plan   the launch\nwith the team.  ");
    appendMessage(db, newer.id, "user", "This title should not replace the saved title.");
    appendMessage(db, curation.id, "user", "A curation audit message.");
    db.prepare<[string, number]>("UPDATE conversation SET updated_at = ? WHERE id = ?").run(
      "2026-01-01T00:00:00.000Z",
      older.id,
    );
    db.prepare<[string, number]>("UPDATE conversation SET updated_at = ? WHERE id = ?").run(
      "2026-01-02T00:00:00.000Z",
      newer.id,
    );

    expect(listRecentChats(db)).toEqual([
      { id: newer.id, title: "Named chat" },
      { id: older.id, title: "Plan the launch with the team." },
    ]);
  });
});

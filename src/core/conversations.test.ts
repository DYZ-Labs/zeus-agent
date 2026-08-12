import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  appendMessage,
  createConversation,
  getConversation,
  hideAllConversationsFromHistory,
  hideConversationFromHistory,
  listChatHistory,
  listRecentChats,
  messagesIn,
} from "./conversations";
import { openTestDb } from "./db";
import { MIGRATIONS } from "./migrations";

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

  it("hides chats from history without deleting their transcripts", () => {
    const db = openTestDb();
    const hidden = createConversation(db, { title: "Hidden chat" });
    const visible = createConversation(db, { title: "Visible chat" });
    appendMessage(db, hidden.id, "user", "Keep this source message.");
    appendMessage(db, visible.id, "user", "Keep this chat visible.");

    expect(hideConversationFromHistory(db, hidden.id)).toBe(true);
    expect(listRecentChats(db).map((chat) => chat.id)).toEqual([visible.id]);
    expect(listChatHistory(db).map((chat) => chat.id)).toEqual([visible.id]);
    expect(getConversation(db, hidden.id)).not.toBeNull();
    expect(messagesIn(db, hidden.id)).toHaveLength(1);

    expect(hideAllConversationsFromHistory(db)).toBe(1);
    expect(listChatHistory(db)).toEqual([]);
    expect(getConversation(db, visible.id)).not.toBeNull();
  });

  it("limits the sidebar to the 12 newest chats with deterministic tie ordering", () => {
    const db = openTestDb();
    const chats = Array.from({ length: 14 }, (_, index) => {
      const chat = createConversation(db, { title: `Chat ${index + 1}` });
      appendMessage(db, chat.id, "user", `Message ${index + 1}`);
      db.prepare<[string, number]>("UPDATE conversation SET updated_at = ? WHERE id = ?").run(
        "2026-01-01T00:00:00.000Z",
        chat.id,
      );
      return chat;
    });

    expect(listRecentChats(db).map((chat) => chat.id)).toEqual(
      chats
        .slice(-12)
        .reverse()
        .map((chat) => chat.id),
    );
  });

  it("adds history visibility state to an existing conversation store", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 10)) db.exec(migration.sql);
    const conversation = createConversation(db, { title: "Existing chat" });

    expect(() => db.exec(MIGRATIONS[10]!.sql)).not.toThrow();
    expect(listChatHistory(db).map((chat) => chat.id)).toEqual([conversation.id]);
    expect(hideConversationFromHistory(db, conversation.id)).toBe(true);
    expect(getConversation(db, conversation.id)).not.toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});

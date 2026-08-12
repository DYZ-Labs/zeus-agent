import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  archiveConversation,
  appendMessage,
  conversationHistoryCounts,
  conversationHistoryItems,
  createConversation,
  getConversation,
  hideAllConversationsFromHistory,
  hideConversationFromHistory,
  listChatHistory,
  listRecentChats,
  messagesIn,
  restoreConversationToHistory,
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
    expect(conversationHistoryItems(db, { visibility: "archived" })).toMatchObject([
      { id: hidden.id, title: "Hidden chat", archivedAt: expect.any(String) },
    ]);
    expect(conversationHistoryCounts(db)).toEqual({ active: 1, archived: 1 });

    expect(restoreConversationToHistory(db, hidden.id)).toBe(true);
    expect(listChatHistory(db).map((chat) => chat.id)).toEqual([visible.id, hidden.id]);
    expect(conversationHistoryCounts(db)).toEqual({ active: 2, archived: 0 });

    expect(hideAllConversationsFromHistory(db)).toBe(2);
    expect(listChatHistory(db)).toEqual([]);
    expect(getConversation(db, visible.id)).not.toBeNull();
  });

  it("searches full message text and keeps archived results in their own view", () => {
    const db = openTestDb();
    const messageMatch = createConversation(db, { title: "Quarterly planning" });
    const titleMatch = createConversation(db, { title: "Orchid notes" });
    const archived = createConversation(db, { title: "Older research" });
    const unrelated = createConversation(db, { title: "Dinner" });
    appendMessage(
      db,
      messageMatch.id,
      "user",
      "We should compare the cobalt supplier proposals before Friday.",
    );
    appendMessage(db, titleMatch.id, "user", "This body does not contain the flower name.");
    appendMessage(db, archived.id, "user", "The archived cobalt decision is still evidence.");
    appendMessage(db, unrelated.id, "user", "Book a table near home.");
    archiveConversation(db, archived.id);

    expect(conversationHistoryItems(db, { query: "cobalt" })).toMatchObject([
      {
        id: messageMatch.id,
        matchingMessage: "We should compare the cobalt supplier proposals before Friday.",
      },
    ]);
    expect(conversationHistoryItems(db, { query: "orchid" })).toMatchObject([
      { id: titleMatch.id, matchingMessage: null },
    ]);
    expect(
      conversationHistoryItems(db, { visibility: "archived", query: "cobalt" }),
    ).toMatchObject([
      {
        id: archived.id,
        matchingMessage: "The archived cobalt decision is still evidence.",
      },
    ]);
    expect(() => conversationHistoryItems(db, { query: `" OR NOT ( )` })).not.toThrow();
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

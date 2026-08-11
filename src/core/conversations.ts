import type { Db } from "./db";
import { now } from "./db";
import type { Conversation, ConversationSource, Message, MessageRole } from "./schema";

/**
 * The episodic log. Every fact points at the message that produced it, so this table
 * is what makes provenance real rather than decorative — you can always walk from a
 * claim back to the exact sentence you said.
 */

export function createConversation(
  db: Db,
  options: { title?: string | null; source?: ConversationSource } = {},
): Conversation {
  const timestamp = now();
  const result = db
    .prepare<[string | null, ConversationSource, string, string]>(
      "INSERT INTO conversation (title, source, started_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(options.title ?? null, options.source ?? "web", timestamp, timestamp);

  const conversation = getConversation(db, Number(result.lastInsertRowid));
  if (!conversation) throw new Error("Conversation vanished immediately after insert");
  return conversation;
}

export function getConversation(db: Db, id: number): Conversation | null {
  return (
    db
      .prepare<[number], Conversation>(
        "SELECT id, title, source, started_at, updated_at FROM conversation WHERE id = ?",
      )
      .get(id) ?? null
  );
}

export function listConversations(db: Db, limit = 50): Conversation[] {
  return db
    .prepare<[number], Conversation>(
      `SELECT id, title, source, started_at, updated_at
       FROM conversation ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function setConversationTitle(db: Db, id: number, title: string): void {
  db.prepare<[string, string, number]>(
    "UPDATE conversation SET title = ?, updated_at = ? WHERE id = ?",
  ).run(title, now(), id);
}

export function appendMessage(
  db: Db,
  conversationId: number,
  role: MessageRole,
  content: string,
): Message {
  const timestamp = now();

  return db.transaction((): Message => {
    const result = db
      .prepare<[number, MessageRole, string, string]>(
        "INSERT INTO message (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(conversationId, role, content, timestamp);

    const id = Number(result.lastInsertRowid);
    db.prepare<[number, string]>("INSERT INTO message_fts (rowid, text) VALUES (?, ?)").run(
      id,
      content,
    );
    db.prepare<[string, number]>("UPDATE conversation SET updated_at = ? WHERE id = ?").run(
      timestamp,
      conversationId,
    );

    const message = getMessage(db, id);
    if (!message) throw new Error("Message vanished immediately after insert");
    return message;
  })();
}

export function getMessage(db: Db, id: number): Message | null {
  return (
    db
      .prepare<[number], Message>(
        "SELECT id, conversation_id, role, content, created_at FROM message WHERE id = ?",
      )
      .get(id) ?? null
  );
}

export function messagesIn(db: Db, conversationId: number, limit = 200): Message[] {
  return db
    .prepare<[number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at
       FROM message WHERE conversation_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(conversationId, limit);
}

/** The last N messages of a conversation, oldest-first — the window sent to the model. */
export function recentMessages(db: Db, conversationId: number, limit = 20): Message[] {
  const rows = db
    .prepare<[number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at
       FROM message WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(conversationId, limit);
  return rows.reverse();
}

/** Rebuild the message FTS index. Used by `scripts/reindex.ts`. */
export function reindexMessages(db: Db): number {
  const rows = db
    .prepare<[], { id: number; content: string }>("SELECT id, content FROM message")
    .all();

  db.transaction(() => {
    db.exec("DELETE FROM message_fts");
    const insert = db.prepare<[number, string]>(
      "INSERT INTO message_fts (rowid, text) VALUES (?, ?)",
    );
    for (const row of rows) insert.run(row.id, row.content);
  })();

  return rows.length;
}

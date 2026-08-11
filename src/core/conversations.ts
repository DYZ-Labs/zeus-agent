import type { Db } from "./db";
import { now } from "./db";
import type {
  Conversation,
  ConversationSource,
  Message,
  MessageOrigin,
  MessageRecallState,
  MessageRole,
} from "./schema";

export type RecentChat = {
  id: number;
  title: string;
};

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

/** Conversations visible in user-facing chat history. Hidden rows remain stored so
 * their messages can continue to serve as inspectable evidence for accepted memory. */
export function listChatHistory(db: Db, limit = 500): Conversation[] {
  return db
    .prepare<[number], Conversation>(
      `SELECT c.id, c.title, c.source, c.started_at, c.updated_at
       FROM conversation c
       WHERE COALESCE(c.title, '') != 'Memory curation'
         AND NOT EXISTS (
           SELECT 1 FROM conversation_history_state h WHERE h.conversation_id = c.id
         )
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

/** Compact, display-ready history for the navigation sidebar. */
export function listRecentChats(db: Db, limit = 12): RecentChat[] {
  const rows = db
    .prepare<
      [number],
      {
        id: number;
        title: string | null;
        first_user_message: string | null;
      }
    >(
      `SELECT c.id, c.title,
              (SELECT m.content
               FROM message m
               WHERE m.conversation_id = c.id AND m.role = 'user'
               ORDER BY m.id LIMIT 1) AS first_user_message
       FROM conversation c
       WHERE COALESCE(c.title, '') != 'Memory curation'
         AND NOT EXISTS (
           SELECT 1 FROM conversation_history_state h WHERE h.conversation_id = c.id
         )
         AND EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id)
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(limit);

  return rows.map((row) => ({
    id: row.id,
    title: row.title?.trim() || chatTitle(row.first_user_message, row.id),
  }));
}

/** Remove one conversation from visible chat history without deleting its transcript,
 * evidence, facts, goals, commitments, or any other source-backed data. */
export function hideConversationFromHistory(db: Db, conversationId: number): boolean {
  const result = db
    .prepare<[string, number]>(
      `INSERT OR IGNORE INTO conversation_history_state (hidden_at, conversation_id)
       SELECT ?, id FROM conversation
       WHERE id = ? AND COALESCE(title, '') != 'Memory curation'`,
    )
    .run(now(), conversationId);
  return result.changes > 0;
}

/** Hide every ordinary chat while preserving the complete underlying data store. */
export function hideAllConversationsFromHistory(db: Db): number {
  const result = db
    .prepare<[string]>(
      `INSERT OR IGNORE INTO conversation_history_state (conversation_id, hidden_at)
       SELECT id, ? FROM conversation
       WHERE COALESCE(title, '') != 'Memory curation'`,
    )
    .run(now());
  return result.changes;
}

function chatTitle(content: string | null, conversationId: number): string {
  const normalized = content?.replace(/\s+/gu, " ").trim();
  if (!normalized) return `Conversation ${conversationId}`;
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
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
  options: { origin?: MessageOrigin; recallState?: MessageRecallState } = {},
): Message {
  const timestamp = now();
  const origin = options.origin ?? "conversation";
  const recallState = options.recallState ?? (role === "assistant" ? "blocked" : "unclassified");

  return db.transaction((): Message => {
    const result = db
      .prepare<[number, MessageRole, string, string, MessageOrigin, MessageRecallState]>(
        `INSERT INTO message
           (conversation_id, role, content, created_at, origin, recall_state)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, role, content, timestamp, origin, recallState);

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
        `SELECT id, conversation_id, role, content, created_at, origin, recall_state
         FROM message WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function messagesIn(db: Db, conversationId: number, limit = 200): Message[] {
  return db
    .prepare<[number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at
              , origin, recall_state
       FROM message WHERE conversation_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(conversationId, limit);
}

/** The last N messages of a conversation, oldest-first — the window sent to the model. */
export function recentMessages(db: Db, conversationId: number, limit = 20): Message[] {
  const rows = db
    .prepare<[number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at
              , origin, recall_state
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

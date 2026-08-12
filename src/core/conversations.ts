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

export type ConversationHistoryVisibility = "active" | "archived";

export type ConversationHistoryItem = {
  id: number;
  title: string;
  updatedAt: string;
  archivedAt: string | null;
  /** Present only when a stored message matched a full-text search. */
  matchingMessage: string | null;
};

export type ConversationHistoryCounts = {
  active: number;
  archived: number;
};

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
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ?`,
    )
    .all(limit);
}

/** Display-ready conversations for the active or archived history view. Search uses
 * the message FTS index, while titles retain a small escaped LIKE fallback because
 * conversation titles are not part of that index. */
export function conversationHistoryItems(
  db: Db,
  options: {
    visibility?: ConversationHistoryVisibility;
    query?: string;
    limit?: number;
  } = {},
): ConversationHistoryItem[] {
  const visibility = options.visibility ?? "active";
  const limit = Math.max(1, Math.min(500, options.limit ?? 500));
  const query = options.query?.replace(/\s+/gu, " ").trim().slice(0, 500) ?? "";
  const ftsQuery = conversationFtsQuery(query);
  const archiveClause = visibility === "archived"
    ? "h.conversation_id IS NOT NULL"
    : "h.conversation_id IS NULL";

  const rows = ftsQuery
    ? db
      .prepare<
        [string, string, number],
        {
          id: number;
          title: string | null;
          updated_at: string;
          archived_at: string | null;
          first_user_message: string | null;
          matching_message: string | null;
        }
      >(
        `WITH matched_conversation AS (
           SELECT m.conversation_id, MAX(m.id) AS message_id
           FROM message_fts
           JOIN message m ON m.id = message_fts.rowid
           WHERE message_fts MATCH ?
           GROUP BY m.conversation_id
         )
         SELECT c.id, c.title, c.updated_at, h.hidden_at AS archived_at,
                (SELECT first.content
                 FROM message first
                 WHERE first.conversation_id = c.id AND first.role = 'user'
                 ORDER BY first.id LIMIT 1) AS first_user_message,
                matched.content AS matching_message
         FROM conversation c
         LEFT JOIN conversation_history_state h ON h.conversation_id = c.id
         LEFT JOIN matched_conversation match ON match.conversation_id = c.id
         LEFT JOIN message matched ON matched.id = match.message_id
         WHERE COALESCE(c.title, '') != 'Memory curation'
           AND ${archiveClause}
           AND (LOWER(COALESCE(c.title, '')) LIKE ? ESCAPE '\\'
                OR match.conversation_id IS NOT NULL)
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT ?`,
      )
      .all(ftsQuery, `%${escapedLike(query.toLocaleLowerCase())}%`, limit)
    : db
      .prepare<
        Array<string | number>,
        {
          id: number;
          title: string | null;
          updated_at: string;
          archived_at: string | null;
          first_user_message: string | null;
          matching_message: null;
        }
      >(
        `SELECT c.id, c.title, c.updated_at, h.hidden_at AS archived_at,
                (SELECT first.content
                 FROM message first
                 WHERE first.conversation_id = c.id AND first.role = 'user'
                 ORDER BY first.id LIMIT 1) AS first_user_message,
                NULL AS matching_message
         FROM conversation c
         LEFT JOIN conversation_history_state h ON h.conversation_id = c.id
         WHERE COALESCE(c.title, '') != 'Memory curation'
           AND ${archiveClause}
           ${query ? "AND LOWER(COALESCE(c.title, '')) LIKE ? ESCAPE '\\'" : ""}
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT ?`,
      )
      .all(
        ...(query
          ? [`%${escapedLike(query.toLocaleLowerCase())}%`, limit]
          : [limit]),
      );

  return rows.map((row) => ({
    id: row.id,
    title: row.title?.trim() || chatTitle(row.first_user_message, row.id),
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    matchingMessage: row.matching_message,
  }));
}

export function conversationHistoryCounts(db: Db): ConversationHistoryCounts {
  const row = db
    .prepare<[], { active: number; archived: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN h.conversation_id IS NULL THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN h.conversation_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS archived
       FROM conversation c
       LEFT JOIN conversation_history_state h ON h.conversation_id = c.id
       WHERE COALESCE(c.title, '') != 'Memory curation'`,
    )
    .get();
  return row ?? { active: 0, archived: 0 };
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
       ORDER BY c.updated_at DESC, c.id DESC
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

/** Consumer-facing name for the existing non-destructive history operation. */
export function archiveConversation(db: Db, conversationId: number): boolean {
  return hideConversationFromHistory(db, conversationId);
}

/** Restore an archived chat to Recents and the active history view. */
export function restoreConversationToHistory(db: Db, conversationId: number): boolean {
  const result = db
    .prepare<[number]>(
      `DELETE FROM conversation_history_state
       WHERE conversation_id = ?`,
    )
    .run(conversationId);
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

function conversationFtsQuery(raw: string): string | null {
  const terms = raw
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.slice(0, 16)
    .map((term) => `"${term.replace(/"/gu, '""')}"`) ?? [];
  return terms.length > 0 ? terms.join(" AND ") : null;
}

function escapedLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
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
  options: {
    origin?: MessageOrigin;
    recallState?: MessageRecallState;
    crossChatRecallEligible?: boolean;
  } = {},
): Message {
  const timestamp = now();
  const origin = options.origin ?? "conversation";
  const recallState = options.recallState ?? (role === "assistant" ? "blocked" : "unclassified");

  return db.transaction((): Message => {
    const supportsRecallEligibility = hasCrossChatRecallEligibility(db);
    if (!supportsRecallEligibility && options.crossChatRecallEligible === false) {
      throw new Error("This store must be migrated before saving a recall-ineligible message");
    }
    const result = supportsRecallEligibility
      ? db
        .prepare<[
          number,
          MessageRole,
          string,
          string,
          MessageOrigin,
          MessageRecallState,
          number,
        ]>(
          `INSERT INTO message
             (conversation_id, role, content, created_at, origin, recall_state,
              cross_chat_recall_eligible)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversationId,
          role,
          content,
          timestamp,
          origin,
          recallState,
          options.crossChatRecallEligible === false ? 0 : 1,
        )
      : db
        .prepare<[
          number,
          MessageRole,
          string,
          string,
          MessageOrigin,
          MessageRecallState,
        ]>(
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
        `SELECT id, conversation_id, role, content, created_at, origin, recall_state,
                ${crossChatRecallEligibilityProjection(db)}
         FROM message WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function messagesIn(db: Db, conversationId: number, limit = 200): Message[] {
  return db
    .prepare<[number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at
              , origin, recall_state, ${crossChatRecallEligibilityProjection(db)}
       FROM message WHERE conversation_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(conversationId, limit);
}

/** The last N messages of a conversation, oldest-first — the window sent to the model. */
export function recentMessages(db: Db, conversationId: number, limit = 20): Message[] {
  const rows = db
    .prepare<[number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at
              , origin, recall_state, ${crossChatRecallEligibilityProjection(db)}
       FROM message WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(conversationId, limit);
  return rows.reverse();
}

function hasCrossChatRecallEligibility(db: Db): boolean {
  return (db.pragma("table_info(message)") as Array<{ name: string }>).some(
    (column) => column.name === "cross_chat_recall_eligible",
  );
}

function crossChatRecallEligibilityProjection(db: Db): string {
  return hasCrossChatRecallEligibility(db)
    ? "cross_chat_recall_eligible"
    : "1 AS cross_chat_recall_eligible";
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

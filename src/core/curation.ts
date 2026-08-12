import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import type { Conversation, Message } from "./schema";

export const MEMORY_CURATION_CONVERSATION_TITLE = "Memory curation";

/**
 * Persist an explicit curation decision as a real user-authored action record.
 *
 * These messages may serve as provenance for the exact wording the user approved,
 * but they are deliberately hidden from normal chat history and excluded from raw
 * episodic recall and historical backfill.
 */
export function recordUserCurationMessage(db: Db, content: string): Message {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("A curation source message cannot be empty");

  const conversation = db
    .prepare<[string], Conversation>(
      `SELECT id, title, source, started_at, updated_at
       FROM conversation WHERE title = ? ORDER BY id LIMIT 1`,
    )
    .get(MEMORY_CURATION_CONVERSATION_TITLE) ??
    createConversation(db, {
      title: MEMORY_CURATION_CONVERSATION_TITLE,
      source: "web",
    });

  return appendMessage(db, conversation.id, "user", normalized, {
    origin: "user_action",
    recallState: "blocked",
    crossChatRecallEligible: false,
  });
}

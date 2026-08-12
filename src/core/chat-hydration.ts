import type { MemoryJobView, ResourceId } from "./contracts";
import { messagesIn } from "./conversations";
import type { Db } from "./db";
import { memoryJobsForConversation } from "./memory-jobs";
import { resourceId } from "./resource-id";

/** Browser-safe persisted turn state. No local SQLite key crosses this boundary. */
export type ChatHydrationTurn = {
  id: ResourceId;
  role: "user" | "assistant";
  text: string;
  responseId?: ResourceId | null;
  recalled?: number;
  memoryJobId?: ResourceId | null;
  memory?: MemoryJobView;
  memoryError?: string | null;
};

/** Reconstruct response provenance and exact memory notices after a page refresh. */
export function hydrateConversationTurns(
  db: Db,
  conversationId: number,
  limit = 400,
): ChatHydrationTurn[] {
  const jobs = new Map(
    memoryJobsForConversation(db, conversationId).map((entry) => [
      entry.assistantMessageId,
      entry.job,
    ]),
  );
  const recallCounts = new Map(
    db
      .prepare<
        [number],
        { assistant_message_id: number; recalled: number }
      >(
        `SELECT rc.assistant_message_id, COUNT(*) AS recalled
         FROM response_context rc
         JOIN message response ON response.id = rc.assistant_message_id
         WHERE response.conversation_id = ?
         GROUP BY rc.assistant_message_id`,
      )
      .all(conversationId)
      .map((row) => [row.assistant_message_id, row.recalled]),
  );

  return messagesIn(db, conversationId, limit).map((message) => {
    const id = resourceId("message", message.id);
    if (message.role === "user") return { id, role: message.role, text: message.content };
    const memory = jobs.get(message.id);
    return {
      id,
      role: message.role,
      text: message.content,
      responseId: id,
      recalled: recallCounts.get(message.id) ?? 0,
      memoryJobId: memory?.id ?? null,
      memory,
      memoryError: memory?.status === "failed" ? memory.error : null,
    };
  });
}

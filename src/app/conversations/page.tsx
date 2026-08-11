import {
  ConversationHistory,
  type ConversationHistoryEntry,
} from "@/components/conversation-history";
import { listChatHistory } from "@/core/conversations";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default function ConversationsPage() {
  const db = getDb();
  const conversations = listChatHistory(db, 500);
  const chats: ConversationHistoryEntry[] = conversations.map((conversation) => {
    const firstUserMessage = db
      .prepare<[number], { content: string }>(
        `SELECT content FROM message
         WHERE conversation_id = ? AND role = 'user'
         ORDER BY id LIMIT 1`,
      )
      .get(conversation.id);

    return {
      id: conversation.id,
      title: conversation.title ?? titleFrom(firstUserMessage?.content, conversation.id),
      updatedAt: conversation.updated_at,
    };
  });

  return <ConversationHistory chats={chats} referenceDate={new Date().toISOString()} />;
}

function titleFrom(content: string | undefined, conversationId: number): string {
  const normalized = content?.replace(/\s+/gu, " ").trim();
  if (!normalized) return `Conversation ${conversationId}`;
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
}

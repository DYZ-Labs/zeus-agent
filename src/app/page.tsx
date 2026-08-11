import { Chat, type ChatHistoryTurn } from "@/components/chat";
import { getConversation, messagesIn } from "@/core/conversations";
import { hasCredentials } from "@/core/openai";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string; conversation?: string }>;
}) {
  const params = await searchParams;
  const prompt = params.prompt?.slice(0, 4_000);
  const requestedConversationId = Number(params.conversation);
  const db = getDb();
  const conversation = Number.isInteger(requestedConversationId) && requestedConversationId > 0
    ? getConversation(db, requestedConversationId)
    : null;
  const initialTurns: ChatHistoryTurn[] = conversation
    ? messagesIn(db, conversation.id, 400).map((message) => ({
        id: `stored-${message.id}`,
        role: message.role,
        text: message.content,
      }))
    : [];

  return (
    <Chat
      key={`${conversation?.id ?? "new"}:${prompt ?? "empty"}`}
      hasCredentials={hasCredentials()}
      initialPrompt={prompt}
      initialTurns={initialTurns}
      initialConversationId={conversation?.id}
    />
  );
}

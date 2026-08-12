import { Chat, type ChatHistoryTurn } from "@/components/chat";
import { getConversation, messagesIn } from "@/core/conversations";
import { hasCredentials } from "@/core/openai";
import { getOwnerAccess } from "@/server/auth/access";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{
    prompt?: string;
    conversation?: string;
    code?: string;
    error?: string;
    error_code?: string;
  }>;
}) {
  const params = await searchParams;
  // If Supabase falls back to its configured Site URL instead of an allow-listed
  // callback, recover the PKCE flow rather than leaving an unused code on `/`.
  if (params.code && params.code.length <= 2_000) {
    redirect(`/auth/confirm?code=${encodeURIComponent(params.code)}`);
  }
  if (params.error || params.error_code) {
    redirect("/auth/login?error=Supabase%20could%20not%20complete%20authentication.");
  }
  const prompt = params.prompt?.slice(0, 4_000);
  const requestedConversationId = Number(params.conversation);
  const access = await getOwnerAccess();
  const db = access.canAccessPrivateData ? access.db : null;
  const conversation = db && Number.isInteger(requestedConversationId) && requestedConversationId > 0
    ? getConversation(db, requestedConversationId)
    : null;
  const initialTurns: ChatHistoryTurn[] = conversation && db
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
      canAccessPrivateData={access.canAccessPrivateData}
      canUseChat={access.canAccessPrivateData || access.state === "signed_out"}
      showAuthActions={access.state !== "authorized"}
      initialPrompt={prompt}
      initialTurns={initialTurns}
      initialConversationId={conversation?.id}
    />
  );
}

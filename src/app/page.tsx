import { Chat, type ChatHistoryTurn } from "@/components/chat";
import { calendarOutcomesIn } from "@/core/calendar-outcome";
import { getConversation, messagesIn } from "@/core/conversations";
import { pendingConfirmationOffer } from "@/core/effects";
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
  // Rehydrated so a reload still shows what Zeus actually did, rather than leaving the
  // assistant's own sentences as the only surviving account of it.
  const storedOutcomes = conversation && db ? calendarOutcomesIn(db, conversation.id) : null;
  const initialTurns: ChatHistoryTurn[] = conversation && db
    ? messagesIn(db, conversation.id, 400).map((message) => ({
        id: `stored-${message.id}`,
        role: message.role,
        text: message.content,
        calendar: storedOutcomes?.get(message.id) ?? null,
      }))
    : [];

  return (
    <Chat
      key={`${conversation?.id ?? "new"}:${prompt ?? "empty"}`}
      hasCredentials={hasCredentials()}
      canAccessPrivateData={access.canAccessPrivateData}
      showAuthActions={access.state !== "authorized"}
      initialPrompt={prompt}
      initialTurns={initialTurns}
      initialConversationId={conversation?.id}
      awaitingConfirmation={db ? pendingConfirmationOffer(db) : null}
    />
  );
}

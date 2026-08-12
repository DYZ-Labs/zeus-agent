import { Chat, type ChatAccessMode } from "@/components/chat";
import {
  hydrateConversationTurns,
  type ChatHydrationTurn,
} from "@/core/chat-hydration";
import { getConversation } from "@/core/conversations";
import { getExperienceSettings } from "@/core/experience";
import { hasCredentials } from "@/core/openai";
import { numericResourceId, resourceId } from "@/core/resource-id";
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
    redirect("/auth/login?error=Account%20login%20could%20not%20be%20completed.");
  }
  const prompt = params.prompt?.slice(0, 4_000);
  const requestedConversationId = numericResourceId(params.conversation, "conversation");
  const access = await getOwnerAccess();
  const accessMode: ChatAccessMode = access.canAccessPrivateData
    ? "durable"
    : access.state === "signed_out"
      ? "guest"
      : "blocked";
  const db = access.canAccessPrivateData ? access.db : null;
  const conversation = db && requestedConversationId !== null
    ? getConversation(db, requestedConversationId)
    : null;
  const initialTurns: ChatHydrationTurn[] = conversation && db
    ? hydrateConversationTurns(db, conversation.id, 400)
    : [];
  const experience = db ? getExperienceSettings(db) : null;

  return (
    <Chat
      key={`${accessMode}:${conversation?.id ?? "new"}:${prompt ?? "empty"}`}
      hasCredentials={hasCredentials()}
      accessMode={accessMode}
      showAuthActions={access.state !== "authorized"}
      initialPrompt={prompt}
      initialTurns={initialTurns}
      initialConversationId={conversation ? resourceId("conversation", conversation.id) : undefined}
      onboardingStatus={experience?.onboardingStatus ?? "complete"}
    />
  );
}

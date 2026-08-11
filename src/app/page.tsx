import { Chat } from "@/components/chat";
import { MODEL, hasCredentials } from "@/core/openai";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>;
}) {
  const prompt = (await searchParams).prompt?.slice(0, 4_000);
  return (
    <Chat
      key={prompt ?? "empty"}
      hasCredentials={hasCredentials()}
      model={MODEL}
      initialPrompt={prompt}
    />
  );
}

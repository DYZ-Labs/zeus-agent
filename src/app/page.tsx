import { Chat } from "@/components/chat";
import { MODEL, hasCredentials } from "@/core/openai";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return <Chat hasCredentials={hasCredentials()} model={MODEL} />;
}

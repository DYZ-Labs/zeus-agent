import {
  ConversationHistory,
  type ConversationHistoryEntry,
} from "@/components/conversation-history";
import {
  conversationHistoryCounts,
  conversationHistoryItems,
  type ConversationHistoryVisibility,
} from "@/core/conversations";
import { resourceId } from "@/core/resource-id";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const db = await requireOwnerPageDb();
  const params = await searchParams;
  const visibility: ConversationHistoryVisibility = params.view === "hidden"
    ? "archived"
    : "active";
  const query = params.q?.replace(/\s+/gu, " ").trim().slice(0, 500) ?? "";
  const conversations = conversationHistoryItems(db, { visibility, query, limit: 500 });
  const counts = conversationHistoryCounts(db);
  const chats: ConversationHistoryEntry[] = conversations.map((conversation) => ({
    id: resourceId("conversation", conversation.id),
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    excerpt: conversation.matchingMessage
      ? matchingExcerpt(conversation.matchingMessage, query)
      : null,
  }));

  return (
    <ConversationHistory
      chats={chats}
      referenceDate={new Date().toISOString()}
      query={query}
      view={visibility === "archived" ? "hidden" : "active"}
      counts={counts}
    />
  );
}

function matchingExcerpt(content: string, query: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 180) return normalized;
  const term = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/u)?.[0] ?? "";
  const matchAt = term ? normalized.toLocaleLowerCase().indexOf(term) : 0;
  const start = Math.max(0, matchAt - 60);
  const end = Math.min(normalized.length, start + 180);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${
    end < normalized.length ? "…" : ""
  }`;
}

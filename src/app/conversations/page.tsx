import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { listConversations } from "@/core/conversations";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default function ConversationsPage() {
  const db = getDb();
  const conversations = listConversations(db, 500).filter(
    (conversation) => conversation.title !== "Memory curation",
  );

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title="Recent chats" meta={`${conversations.length} conversations`} />
      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <div className="flex max-w-[68ch] flex-wrap items-baseline justify-between gap-3">
          <p className="text-[0.88rem] leading-6" style={{ color: "var(--shell-muted)" }}>
            Open a conversation to review it or continue where you left off.
          </p>
          <Link
            href="/settings#data"
            className="font-mono text-[0.66rem] underline underline-offset-2"
            style={{ color: "var(--shell-faint)" }}
          >
            manage stored data
          </Link>
        </div>

        {conversations.length > 0 ? (
          <ul className="mt-7 max-w-[54rem]">
            {conversations.map((conversation) => {
              const firstUserMessage = db
                .prepare<[number], { content: string }>(
                  `SELECT content FROM message
                   WHERE conversation_id = ? AND role = 'user'
                   ORDER BY id LIMIT 1`,
                )
                .get(conversation.id);
              const messageCount = db
                .prepare<[number], { count: number }>(
                  "SELECT COUNT(*) AS count FROM message WHERE conversation_id = ?",
                )
                .get(conversation.id)?.count ?? 0;
              const title = conversation.title ?? titleFrom(firstUserMessage?.content, conversation.id);

              return (
                <li key={conversation.id} className="border-b" style={{ borderColor: "var(--shell-line)" }}>
                  <Link
                    href={`/?conversation=${conversation.id}`}
                    className="group flex items-center gap-4 rounded-md px-2 py-4 transition-colors hover:bg-white/[0.03]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.94rem]">{title}</p>
                      <p className="mt-1.5 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
                        {conversation.updated_at.slice(0, 10)} · {messageCount} messages
                      </p>
                    </div>
                    <span
                      aria-hidden
                      className="text-[1rem] opacity-40 transition-opacity group-hover:opacity-100"
                      style={{ color: "var(--shell-muted)" }}
                    >
                      →
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <div
            className="mt-7 max-w-[54rem] rounded-[6px] border border-dashed px-5 py-6"
            style={{ borderColor: "var(--shell-line-strong)" }}
          >
            <p className="text-[0.93rem]">No conversations yet.</p>
            <Link href="/" className="mt-2 inline-block text-[0.87rem] underline underline-offset-2">
              Start a new chat
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function titleFrom(content: string | undefined, conversationId: number): string {
  const normalized = content?.replace(/\s+/gu, " ").trim();
  if (!normalized) return `Conversation ${conversationId}`;
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
}

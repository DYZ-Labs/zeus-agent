import Link from "next/link";

import { deleteConversationAction } from "@/app/actions";
import { PageHeader } from "@/components/page-header";
import { listConversations } from "@/core/conversations";
import { conversationDependencies } from "@/core/retention";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default function ConversationsPage() {
  const db = getDb();
  const conversations = listConversations(db, 500);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title="Sources" meta={`${conversations.length} conversations`} />
      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <p className="max-w-[68ch] text-[0.88rem] leading-6" style={{ color: "var(--shell-muted)" }}>
          Conversations are retained locally until you explicitly delete them. Deletion also removes memories supported only by that conversation; multiply evidenced facts keep their remaining source.
        </p>

        {conversations.length ? (
          <ul className="mt-7">
            {conversations.map((conversation) => {
              const dependencies = conversationDependencies(db, conversation.id);
              const firstMessage = db
                .prepare<[number], { id: number }>(
                  "SELECT id FROM message WHERE conversation_id = ? ORDER BY id LIMIT 1",
                )
                .get(conversation.id);
              return (
                <li key={conversation.id} className="border-b py-5" style={{ borderColor: "var(--shell-line)" }}>
                  <div className="flex flex-wrap items-start gap-5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[0.94rem]">{conversation.title ?? `Conversation ${conversation.id}`}</p>
                      <p className="mt-1.5 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
                        {conversation.source} · {conversation.started_at.slice(0, 10)} · {dependencies.messages} messages · {dependencies.factsOnlyHere} exclusive facts · {dependencies.factsWithOtherEvidence} shared facts · {dependencies.candidates} candidates · {dependencies.goals} goals · {dependencies.commitments} commitments
                      </p>
                      {firstMessage && (
                        <Link href={`/source/${firstMessage.id}`} className="mt-2 inline-block font-mono text-[0.66rem] underline underline-offset-2" style={{ color: "var(--shell-accent)" }}>
                          inspect transcript
                        </Link>
                      )}
                    </div>
                    <form action={deleteConversationAction} className="flex items-center gap-2 font-mono text-[0.65rem]">
                      <input type="hidden" name="id" value={conversation.id} />
                      <label htmlFor={`delete-${conversation.id}`} className="sr-only">
                        Type delete to confirm
                      </label>
                      <input
                        id={`delete-${conversation.id}`}
                        name="confirmation"
                        placeholder="type delete"
                        required
                        pattern="delete"
                        className="w-[92px] rounded-[3px] border px-2 py-1"
                        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
                      />
                      <button type="submit" style={{ color: "var(--shell-muted)" }}>
                        delete source
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-7 text-[0.9rem]">No conversations have been stored.</p>
        )}
      </div>
    </div>
  );
}

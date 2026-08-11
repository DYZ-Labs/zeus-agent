import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { getMessage } from "@/core/conversations";
import { recalledForResponse } from "@/core/response-context";
import type { RecallItem } from "@/core/schema";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function ResponseSourcesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = getDb();
  const message = getMessage(db, id);
  if (!message || message.role !== "assistant") notFound();
  const recalled = recalledForResponse(db, id);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title="Response sources" meta={`${recalled.length} memory items`} />
      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link href="/" className="font-mono text-[0.68rem] underline underline-offset-2" style={{ color: "var(--shell-muted)" }}>
          ← chat
        </Link>

        <section className="mt-7 rounded-[6px] border px-5 py-4" style={{ borderColor: "var(--shell-line-strong)" }}>
          <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
            Zeus answered
          </h2>
          <p className="mt-3 whitespace-pre-wrap text-[0.92rem]">{message.content}</p>
        </section>

        <section className="mt-9">
          <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
            Memory supplied to that answer
          </h2>
          {recalled.length ? (
            <ol className="mt-2">
              {recalled.map((item, index) => (
                <RecallRow key={key(item)} item={item} rank={index + 1} />
              ))}
            </ol>
          ) : (
            <p className="mt-4 text-[0.88rem]" style={{ color: "var(--shell-muted)" }}>
              No memory was supplied to this response.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function RecallRow({ item, rank }: { item: RecallItem; rank: number }) {
  let title: string;
  let detail: string;
  let source: number | null = null;
  if (item.kind === "fact") {
    title = `${item.fact.subject_slug === "self" ? "You" : item.fact.subject_name} ${item.fact.predicate.replace(/_/gu, " ")} ${item.fact.object}`;
    detail = `canonical fact · ${item.evidence.length} evidence source${item.evidence.length === 1 ? "" : "s"}`;
    source = item.fact.source_message_id;
  } else if (item.kind === "episode") {
    title = `“${item.episode.excerpt}”`;
    detail = `dated episode · ${item.episode.message.created_at.slice(0, 10)}`;
    source = item.episode.message.id;
  } else if (item.kind === "goal") {
    title = item.goal.title;
    detail = `goal · ${item.goal.status}${item.goal.target_at ? ` · target ${item.goal.target_at.slice(0, 10)}` : ""}`;
    source = item.goal.source_message_id;
  } else {
    title = item.commitment.title;
    detail = `commitment · ${item.commitment.status}${item.commitment.due_at ? ` · due ${item.commitment.due_at.slice(0, 10)}` : ""}`;
    source = item.commitment.source_message_id;
  }

  return (
    <li className="flex gap-3 border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
      <span className="font-mono text-[0.63rem]" style={{ color: "var(--shell-faint)" }}>
        {rank}
      </span>
      <div className="min-w-0">
        <p className="text-[0.9rem]">{title}</p>
        <p className="mt-1 font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
          {detail}
          {source !== null && (
            <>
              {" · "}
              <Link href={`/source/${source}`} className="underline underline-offset-2">
                source
              </Link>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

function key(item: RecallItem): string {
  return item.kind === "fact"
    ? `fact-${item.fact.id}`
    : item.kind === "episode"
      ? `episode-${item.episode.message.id}`
      : item.kind === "goal"
        ? `goal-${item.goal.id}`
        : `commitment-${item.commitment.id}`;
}

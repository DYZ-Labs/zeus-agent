import Link from "next/link";
import { notFound } from "next/navigation";

import { FactRow } from "@/components/fact-row";
import { PageHeader } from "@/components/page-header";
import { getConversation, getMessage, messagesIn } from "@/core/conversations";
import { getFacts } from "@/core/facts";
import { getCommitment, getGoal } from "@/core/intentions";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * The other end of a fact's provenance: the exact message it came from, in the context
 * of the conversation around it. Provenance you cannot follow is just decoration.
 */
export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const messageId = Number(id);
  if (!Number.isInteger(messageId)) notFound();

  const db = getDb();
  const message = getMessage(db, messageId);
  if (!message) notFound();

  const conversation = getConversation(db, message.conversation_id);
  const transcript = messagesIn(db, message.conversation_id, 400);

  const derivedIds = db
    .prepare<[number, number], { id: number }>(
      `SELECT DISTINCT f.id
       FROM fact f
       LEFT JOIN fact_evidence e ON e.fact_id = f.id
       WHERE f.source_message_id = ? OR e.source_message_id = ?`,
    )
    .all(messageId, messageId)
    .map((row) => row.id);
  const derived = getFacts(db, derivedIds);
  const goalIds = db
    .prepare<[number, number], { id: number }>(
      `SELECT id FROM goal WHERE source_message_id = ?
       UNION SELECT goal_id AS id FROM goal_event WHERE source_message_id = ?`,
    )
    .all(messageId, messageId)
    .map((row) => row.id);
  const goals = goalIds.flatMap((goalId) => {
    const goal = getGoal(db, goalId);
    return goal ? [goal] : [];
  });
  const commitmentIds = db
    .prepare<[number, number], { id: number }>(
      `SELECT id FROM commitment WHERE source_message_id = ?
       UNION SELECT commitment_id AS id FROM commitment_event WHERE source_message_id = ?`,
    )
    .all(messageId, messageId)
    .map((row) => row.id);
  const commitments = commitmentIds.flatMap((commitmentId) => {
    const commitment = getCommitment(db, commitmentId);
    return commitment ? [commitment] : [];
  });

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        eyebrow="source"
        title={conversation?.title ?? `Conversation ${message.conversation_id}`}
        meta={message.created_at.slice(0, 16).replace("T", " ")}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link
          href="/memory"
          className="font-mono text-[0.68rem] underline underline-offset-2"
          style={{ color: "var(--shell-muted)" }}
        >
          ← all memory
        </Link>

        {derived.length > 0 && (
          <section className="mt-7">
            <h2
              className="font-mono text-[0.65rem] uppercase tracking-[0.14em]"
              style={{ color: "var(--shell-faint)" }}
            >
              Learned from this message
            </h2>
            <ul className="mt-2">
              {derived.map((fact) => (
                <FactRow key={fact.id} fact={fact} />
              ))}
            </ul>
          </section>
        )}

        {goals.length + commitments.length > 0 && (
          <section className="mt-7">
            <h2
              className="font-mono text-[0.65rem] uppercase tracking-[0.14em]"
              style={{ color: "var(--shell-faint)" }}
            >
              Open-loop changes from this message
            </h2>
            <ul className="mt-2 space-y-2 text-[0.9rem]">
              {goals.map((goal) => (
                <li key={`goal-${goal.id}`}>
                  goal · {goal.title} · {goal.status} · {goal.priority} priority
                </li>
              ))}
              {commitments.map((commitment) => (
                <li key={`commitment-${commitment.id}`}>
                  commitment · {commitment.title} · {commitment.status}
                </li>
              ))}
            </ul>
            <Link
              href="/open-loops"
              className="mt-3 inline-block font-mono text-[0.67rem] underline underline-offset-2"
              style={{ color: "var(--shell-accent)" }}
            >
              review open loops
            </Link>
          </section>
        )}

        <section className="mt-9">
          <h2
            className="font-mono text-[0.65rem] uppercase tracking-[0.14em]"
            style={{ color: "var(--shell-faint)" }}
          >
            Transcript
          </h2>
          <ol className="mt-3 space-y-5">
            {transcript.map((entry) => {
              const isSource = entry.id === messageId;
              return (
                <li
                  key={entry.id}
                  id={`m${entry.id}`}
                  className="flex gap-3.5 border-l-2 py-1 pl-3"
                  style={{
                    borderColor: isSource ? "var(--shell-accent)" : "transparent",
                    background: isSource ? "var(--shell-accent-soft)" : "transparent",
                  }}
                >
                  <span
                    aria-hidden
                    className="mt-[3px] w-[38px] shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.12em]"
                    style={{
                      color: entry.role === "assistant" ? "var(--shell-accent)" : "var(--shell-faint)",
                    }}
                  >
                    {entry.role === "assistant" ? "Zeus" : "You"}
                  </span>
                  <p className="min-w-0 flex-1 whitespace-pre-wrap text-[0.92rem]">
                    {entry.content}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

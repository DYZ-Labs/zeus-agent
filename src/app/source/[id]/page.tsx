import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { getConversation, getMessage, messagesIn } from "@/core/conversations";
import { getFacts } from "@/core/facts";
import { getCommitment, getGoal } from "@/core/intentions";
import { getPassage } from "@/core/passages";
import { numericResourceId, resourceId } from "@/core/resource-id";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

/**
 * The other end of a fact's provenance: the exact message it came from, in the context
 * of the conversation around it. Provenance you cannot follow is just decoration.
 */
export default async function SourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ passage?: string }>;
}) {
  const { id } = await params;
  const messageId = numericResourceId(id, "message");
  if (messageId === null) notFound();

  const db = await requireOwnerPageDb();
  const message = getMessage(db, messageId);
  if (!message) notFound();
  const passageId = numericResourceId((await searchParams).passage, "passage");
  const requestedPassage = passageId === null ? null : getPassage(db, passageId);
  const passage = requestedPassage?.message_id === messageId ? requestedPassage : null;

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
        title={conversation?.title ?? "Untitled chat"}
        meta={message.created_at.slice(0, 16).replace("T", " ")}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link
          href="/about-you"
          className="text-sm underline underline-offset-4"
          style={{ color: "var(--shell-muted)" }}
        >
          ← About you
        </Link>

        {passage && (
          <section
            className="mt-7 border-l-2 py-2 pl-4"
            style={{ borderColor: "var(--shell-accent)" }}
          >
            <h2
              className="text-xs font-medium uppercase tracking-[0.12em]"
              style={{ color: "var(--shell-faint)" }}
            >
              Supporting quote
            </h2>
            <p className="mt-2 whitespace-pre-wrap text-[0.92rem]">{passage.text}</p>
          </section>
        )}

        {derived.length > 0 && (
          <section className="mt-7">
            <h2
              className="text-xs font-medium uppercase tracking-[0.12em]"
              style={{ color: "var(--shell-faint)" }}
            >
              Saved from this message
            </h2>
            <ul className="mt-2">
              {derived.map((fact) => (
                <li key={fact.id} className="border-b py-3 text-sm" style={{ borderColor: "var(--shell-line)" }}>
                  <span className="font-medium">{fact.subject_slug === "self" ? "You" : fact.subject_name}</span>{" "}
                  <span style={{ color: "var(--shell-muted)" }}>{fact.predicate.replace(/_/gu, " ")}</span>{" "}
                  <span>{fact.object}</span>
                  {fact.valid_to && <span className="ml-2 text-xs" style={{ color: "var(--shell-faint)" }}>No longer true</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {goals.length + commitments.length > 0 && (
          <section className="mt-7">
            <h2
              className="text-xs font-medium uppercase tracking-[0.12em]"
              style={{ color: "var(--shell-faint)" }}
            >
              Plan changes from this message
            </h2>
            <ul className="mt-2 space-y-2 text-[0.9rem]">
              {goals.map((goal) => (
                <li key={`goal-${goal.id}`}>
                  Goal: {goal.title} · {goal.status.replace(/_/gu, " ")}
                </li>
              ))}
              {commitments.map((commitment) => (
                <li key={`commitment-${commitment.id}`}>
                  Plan: {commitment.title} · {commitment.status.replace(/_/gu, " ")}
                </li>
              ))}
            </ul>
            <Link
              href="/today#plans"
              className="mt-3 inline-block text-sm underline underline-offset-4"
              style={{ color: "var(--shell-accent)" }}
            >
              Review your plans
            </Link>
          </section>
        )}

        <section className="mt-9">
          <h2
            className="text-xs font-medium uppercase tracking-[0.12em]"
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
                  id={resourceId("message", entry.id)}
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

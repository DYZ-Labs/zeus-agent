import Link from "next/link";

import {
  deleteConversationAction,
  followThroughDecisionAction,
  setStewardshipModeAction,
} from "@/app/actions";
import { PageHeader } from "@/components/page-header";
import { listConversations } from "@/core/conversations";
import { conversationDependencies } from "@/core/retention";
import type {
  FollowThroughEventView,
  StewardshipMode,
} from "@/core/schema";
import {
  followThroughMetrics,
  getStewardshipSetting,
  listFollowThroughEvents,
} from "@/core/stewardship";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const db = getDb();
  const setting = getStewardshipSetting(db);
  const metrics = followThroughMetrics(db);
  const events = listFollowThroughEvents(db, 20);
  const conversations = listConversations(db, 500);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title="Settings" meta="control and privacy" />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <section className="max-w-[54rem]">
          <SectionTitle>Follow-through</SectionTitle>
          <h2 className="mt-3 text-[1rem] font-medium">When Zeus should speak up</h2>
          <p className="mt-2 max-w-[65ch] text-[0.82rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            This controls when Zeus may surface a plan. Snoozes and dismissals always take priority.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {MODE_OPTIONS.map((option) => (
              <form action={setStewardshipModeAction} key={option.mode}>
                <input type="hidden" name="mode" value={option.mode} />
                <button
                  type="submit"
                  aria-pressed={setting.mode === option.mode}
                  className="h-full w-full rounded-lg border px-4 py-3 text-left"
                  style={{
                    background:
                      setting.mode === option.mode ? "var(--shell-elevated)" : "var(--shell-panel)",
                    borderColor:
                      setting.mode === option.mode
                        ? "var(--shell-accent-line)"
                        : "var(--shell-line)",
                  }}
                >
                  <span className="block text-[0.84rem] font-medium">{option.label}</span>
                  <span className="mt-1 block text-[0.72rem] leading-5" style={{ color: "var(--shell-faint)" }}>
                    {option.description}
                  </span>
                </button>
              </form>
            ))}
          </div>

          <details className="mt-6 rounded-lg border px-4 py-3" style={{ borderColor: "var(--shell-line)" }}>
            <summary className="cursor-pointer text-[0.82rem]">Follow-through activity</summary>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric value={metrics.progressWithoutRegret} label="progress, no regret signal" />
              <Metric value={metrics.accepted} label="offers accepted" />
              <Metric value={metrics.controlsExercised} label="snoozed or dismissed" />
              <Metric value={metrics.regrets} label="regret signals" />
            </div>
            <p className="mt-3 max-w-[65ch] text-[0.75rem] leading-5" style={{ color: "var(--shell-faint)" }}>
              These are transparent signals, not an engagement score. Completion only counts when
              it follows a Zeus recommendation, and regret remains visible.
            </p>
            {events.length > 0 && (
              <ol className="mt-4">
                {events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ol>
            )}
          </details>
        </section>

        <section id="data" className="mt-14 max-w-[64rem] scroll-mt-4 pb-8">
          <SectionTitle>Data and privacy</SectionTitle>
          <h2 className="mt-3 text-[1rem] font-medium">Stored conversations</h2>
          <p className="mt-2 max-w-[72ch] text-[0.82rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            Zeus stores conversations locally on this device. Deleting one also removes memories
            supported only by that conversation; memories with another source keep their surviving evidence.
          </p>

          {conversations.length > 0 ? (
            <ul className="mt-6">
              {conversations.map((conversation) => {
                const dependencies = conversationDependencies(db, conversation.id);
                const firstMessage = db
                  .prepare<[number], { id: number }>(
                    "SELECT id FROM message WHERE conversation_id = ? ORDER BY id LIMIT 1",
                  )
                  .get(conversation.id);
                const isCuration = conversation.title === "Memory curation";
                const inspectHref = firstMessage
                  ? isCuration
                    ? `/source/${firstMessage.id}`
                    : `/?conversation=${conversation.id}`
                  : null;

                return (
                  <li key={conversation.id} className="border-b py-5" style={{ borderColor: "var(--shell-line)" }}>
                    <div className="flex flex-wrap items-start gap-5">
                      <div className="min-w-0 flex-1">
                        <p className="text-[0.94rem]">
                          {conversation.title ?? `Conversation ${conversation.id}`}
                        </p>
                        <p className="mt-1.5 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
                          {conversation.started_at.slice(0, 10)} · {dependencies.messages} messages · stored locally
                        </p>
                        <div className="mt-2 flex flex-wrap gap-4 font-mono text-[0.66rem]">
                          {inspectHref && (
                            <Link
                              href={inspectHref}
                              className="underline underline-offset-2"
                              style={{ color: "var(--shell-accent)" }}
                            >
                              inspect
                            </Link>
                          )}
                          <details style={{ color: "var(--shell-faint)" }}>
                            <summary className="cursor-pointer">deletion impact</summary>
                            <p className="mt-2 max-w-[72ch] leading-5">
                              {dependencies.factsOnlyHere} exclusive facts ·{" "}
                              {dependencies.factsWithOtherEvidence} facts with other evidence ·{" "}
                              {dependencies.candidates} candidates · {dependencies.goals} goals ·{" "}
                              {dependencies.commitments} commitments ·{" "}
                              {dependencies.followThroughEvents} follow-through events
                            </p>
                          </details>
                        </div>
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
                          delete
                        </button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-6 text-[0.9rem]">No conversations are stored.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: FollowThroughEventView }) {
  return (
    <li className="flex flex-wrap items-start gap-4 border-b py-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="min-w-0 flex-1">
        <p className="text-[0.84rem]">{event.commitment_title}</p>
        <p className="mt-1 font-mono text-[0.62rem]" style={{ color: "var(--shell-faint)" }}>
          {event.created_at.slice(0, 10)} · {event.event_type} ·{" "}
          {event.reason.replace(/_/gu, " ")} · {event.action_kind}
          {event.goal_title ? ` · ${event.goal_title}` : ""}
        </p>
      </div>
      {event.event_type === "completed" && (
        <form action={followThroughDecisionAction}>
          <input type="hidden" name="id" value={event.commitment_id} />
          <input type="hidden" name="decision" value="regretted" />
          <button type="submit" className="font-mono text-[0.62rem]" style={{ color: "var(--shell-faint)" }}>
            this caused regret
          </button>
        </form>
      )}
    </li>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ background: "var(--shell-panel)" }}>
      <p className="text-[1.35rem] font-medium tabular-nums">{value}</p>
      <p className="mt-1 text-[0.69rem]" style={{ color: "var(--shell-faint)" }}>
        {label}
      </p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[0.65rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
      {children}
    </p>
  );
}

const MODE_OPTIONS: readonly {
  mode: StewardshipMode;
  label: string;
  description: string;
}[] = [
  { mode: "quiet", label: "Quiet", description: "Only relevant or clearly overdue items." },
  { mode: "balanced", label: "Balanced", description: "Relevant, due, waiting, or forgotten items." },
  { mode: "proactive", label: "Proactive", description: "Earlier notice with a shorter cooldown." },
];

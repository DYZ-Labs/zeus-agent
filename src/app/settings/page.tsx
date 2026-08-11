import Link from "next/link";

import {
  deleteConversationAction,
  followThroughDecisionAction,
  setStewardshipModeAction,
} from "@/app/actions";
import { DeleteAllConversations } from "@/components/delete-all-conversations";
import { SettingsModal } from "@/components/settings-modal";
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
    <SettingsModal>
      <div className="mx-auto w-full max-w-[48rem] px-5 py-6 sm:px-8 sm:py-7">
        <section id="follow-through" className="scroll-mt-6">
          <h2 className="text-lg font-semibold leading-6">Follow-through</h2>
          <h3 className="mt-6 text-sm font-medium leading-5">When Zeus should speak up</h3>
          <p className="mt-2 max-w-[65ch] text-sm leading-6" style={{ color: "var(--shell-muted)" }}>
            This controls when Zeus may surface a plan. Snoozes and dismissals always take priority.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {MODE_OPTIONS.map((option) => (
              <form action={setStewardshipModeAction} key={option.mode}>
                <input type="hidden" name="mode" value={option.mode} />
                <button
                  type="submit"
                  aria-pressed={setting.mode === option.mode}
                  className="h-full w-full rounded-xl border px-4 py-3 text-left"
                  style={{
                    background:
                      setting.mode === option.mode ? "var(--shell-elevated)" : "var(--shell-panel)",
                    borderColor:
                      setting.mode === option.mode
                        ? "var(--shell-accent-line)"
                        : "var(--shell-line)",
                  }}
                >
                  <span className="block text-sm font-medium leading-5">{option.label}</span>
                  <span className="mt-1 block text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
                    {option.description}
                  </span>
                </button>
              </form>
            ))}
          </div>

          <details className="mt-6 rounded-xl border px-4 py-3" style={{ borderColor: "var(--shell-line)" }}>
            <summary className="cursor-pointer text-sm leading-5">Follow-through activity</summary>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric value={metrics.progressWithoutRegret} label="progress, no regret signal" />
              <Metric value={metrics.accepted} label="offers accepted" />
              <Metric value={metrics.controlsExercised} label="snoozed or dismissed" />
              <Metric value={metrics.regrets} label="regret signals" />
            </div>
            <p className="mt-3 max-w-[65ch] text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
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

        <section
          id="data"
          className="mt-10 scroll-mt-6 border-t pt-8"
          style={{ borderColor: "var(--shell-line)" }}
        >
          <h2 className="text-lg font-semibold leading-6">Data controls</h2>
          <h3 className="mt-6 text-sm font-medium leading-5">Stored conversations</h3>
          <p className="mt-2 max-w-[72ch] text-sm leading-6" style={{ color: "var(--shell-muted)" }}>
            Zeus stores conversations locally on this device. Deleting one also removes memories
            supported only by that conversation; memories with another source keep their surviving evidence.
          </p>

          <div
            className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border px-4 py-4"
            style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)" }}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium leading-5">Delete all conversations</p>
              <p className="mt-1 max-w-[58ch] text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
                This also removes saved details and open loops that have no evidence outside those conversations.
              </p>
            </div>
            <DeleteAllConversations disabled={conversations.length === 0} />
          </div>

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
                        <p className="text-sm font-medium leading-5">
                          {conversation.title ?? `Conversation ${conversation.id}`}
                        </p>
                        <p className="mt-1.5 text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
                          {conversation.started_at.slice(0, 10)} · {dependencies.messages} messages · stored locally
                        </p>
                        <div className="mt-2 flex flex-wrap gap-4 text-xs leading-5">
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
                      <form action={deleteConversationAction} className="flex items-center gap-2 text-xs leading-5">
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
                          className="w-[92px] rounded-md border px-2 py-1"
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
            <p className="mt-6 text-sm leading-5">No conversations are stored.</p>
          )}
        </section>
      </div>
    </SettingsModal>
  );
}

function EventRow({ event }: { event: FollowThroughEventView }) {
  return (
    <li className="flex flex-wrap items-start gap-4 border-b py-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5">{event.commitment_title}</p>
        <p className="mt-1 text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
          {event.created_at.slice(0, 10)} · {event.event_type} ·{" "}
          {event.reason.replace(/_/gu, " ")} · {event.action_kind}
          {event.goal_title ? ` · ${event.goal_title}` : ""}
        </p>
      </div>
      {event.event_type === "completed" && (
        <form action={followThroughDecisionAction}>
          <input type="hidden" name="id" value={event.commitment_id} />
          <input type="hidden" name="decision" value="regretted" />
          <button type="submit" className="text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
            this caused regret
          </button>
        </form>
      )}
    </li>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border px-4 py-3" style={{ background: "var(--shell-elevated)" }}>
      <p className="text-xl font-medium leading-6 tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
        {label}
      </p>
    </div>
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

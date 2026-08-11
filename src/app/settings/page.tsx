import Link from "next/link";

import {
  deleteConversationAction,
  followThroughDecisionAction,
  setStewardshipModeAction,
} from "@/app/actions";
import { DeleteAllConversations } from "@/components/delete-all-conversations";
import { SettingsModal } from "@/components/settings-modal";
import { listConversations } from "@/core/conversations";
import type { Db } from "@/core/db";
import { conversationDependencies } from "@/core/retention";
import type {
  Conversation,
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
    <SettingsModal
      followThrough={
        <FollowThroughSettings
          mode={setting.mode}
          metrics={metrics}
          events={events}
        />
      }
      dataControls={<DataControlsSettings db={db} conversations={conversations} />}
    />
  );
}

function FollowThroughSettings({
  mode,
  metrics,
  events,
}: {
  mode: StewardshipMode;
  metrics: ReturnType<typeof followThroughMetrics>;
  events: FollowThroughEventView[];
}) {
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Follow-through</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        Choose when Zeus may surface one useful next action.
      </p>

      <div className="mt-6">
        <h2 className="text-sm font-medium leading-5">When Zeus should speak up</h2>
        <p className="mt-1 text-[13px] leading-5" style={{ color: "var(--shell-faint)" }}>
          Snoozes and dismissals always take priority over this setting.
        </p>
        <div className="mt-3 overflow-hidden rounded-xl border" style={{ borderColor: "var(--shell-line-strong)" }}>
          {MODE_OPTIONS.map((option, index) => {
            const selected = mode === option.mode;

            return (
              <form action={setStewardshipModeAction} key={option.mode}>
                <input type="hidden" name="mode" value={option.mode} />
                <button
                  type="submit"
                  aria-pressed={selected}
                  className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.05]"
                  style={{
                    background: selected ? "var(--shell-elevated)" : "var(--shell-panel)",
                    borderTop: index > 0 ? "1px solid var(--shell-line)" : undefined,
                  }}
                >
                  <span
                    aria-hidden
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                    style={{
                      borderColor: selected ? "var(--shell-fg)" : "var(--shell-line-strong)",
                    }}
                  >
                    {selected && <span className="h-2 w-2 rounded-full" style={{ background: "var(--shell-fg)" }} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-5">{option.label}</span>
                    <span className="block text-[13px] leading-5" style={{ color: "var(--shell-faint)" }}>
                      {option.description}
                    </span>
                  </span>
                </button>
              </form>
            );
          })}
        </div>
      </div>

      <details className="mt-6 border-t pt-4" style={{ borderColor: "var(--shell-line)" }}>
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm leading-5">
          <span>Follow-through activity</span>
          <ChevronIcon />
        </summary>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Metric value={metrics.progressWithoutRegret} label="Progress without regret" />
          <Metric value={metrics.accepted} label="Offers accepted" />
          <Metric value={metrics.controlsExercised} label="Snoozed or dismissed" />
          <Metric value={metrics.regrets} label="Regret signals" />
        </div>
        <p className="mt-3 text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
          These are transparent control signals, not an engagement score.
        </p>
        {events.length > 0 && (
          <ol className="mt-3">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}

function DataControlsSettings({ db, conversations }: { db: Db; conversations: Conversation[] }) {
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Data controls</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        Review and remove the conversations Zeus stores locally on this device.
      </p>

      <div className="mt-5 border-y" style={{ borderColor: "var(--shell-line)" }}>
        <div className="flex min-h-16 items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm leading-5">Stored conversations</p>
            <p className="mt-0.5 text-[13px] leading-5" style={{ color: "var(--shell-faint)" }}>
              Includes chat messages and their source-backed memory.
            </p>
          </div>
          <span className="shrink-0 text-sm" style={{ color: "var(--shell-muted)" }}>
            {conversations.length}
          </span>
        </div>
        <div
          className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-t py-3"
          style={{ borderColor: "var(--shell-line)" }}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-5">Delete all conversations</p>
            <p className="mt-0.5 text-[13px] leading-5" style={{ color: "var(--shell-faint)" }}>
              Also removes details and open loops with no surviving evidence.
            </p>
          </div>
          <DeleteAllConversations disabled={conversations.length === 0} />
        </div>
      </div>

      <h2 className="mt-6 text-sm font-medium leading-5">Conversations</h2>
      {conversations.length > 0 ? (
        <div className="mt-2">
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
              <details
                key={conversation.id}
                className="group border-b py-1"
                style={{ borderColor: "var(--shell-line)" }}
              >
                <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.04]">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm leading-5">
                      {conversation.title ?? `Conversation ${conversation.id}`}
                    </p>
                    <p className="mt-0.5 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
                      {conversation.started_at.slice(0, 10)} · {dependencies.messages} messages
                    </p>
                  </div>
                  <span
                    className="shrink-0 rounded-full border px-3 py-1.5 text-xs"
                    style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
                  >
                    Manage
                  </span>
                </summary>
                <div
                  className="mb-3 ml-2 mr-2 rounded-lg border p-3"
                  style={{ background: "var(--shell-sidebar)", borderColor: "var(--shell-line)" }}
                >
                  <p className="text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
                    Deletion removes {dependencies.factsOnlyHere} exclusive facts, {dependencies.candidates} candidates,
                    {` ${dependencies.goals}`} goals, {dependencies.commitments} commitments, and {dependencies.followThroughEvents}
                    {" follow-through events. Facts with other evidence are kept."}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    {inspectHref ? (
                      <Link href={inspectHref} className="text-xs underline underline-offset-2">
                        Open conversation
                      </Link>
                    ) : (
                      <span />
                    )}
                    <form action={deleteConversationAction} className="flex items-center gap-2 text-xs">
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
                        className="h-8 w-[92px] rounded-lg border px-2 text-xs outline-none"
                        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
                      />
                      <button type="submit" className="h-8 rounded-lg px-2.5" style={{ color: "#ff6767" }}>
                        Delete
                      </button>
                    </form>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-sm leading-5" style={{ color: "var(--shell-faint)" }}>
          No conversations are stored.
        </p>
      )}
    </section>
  );
}

function EventRow({ event }: { event: FollowThroughEventView }) {
  return (
    <li className="flex flex-wrap items-start gap-3 border-t py-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5">{event.commitment_title}</p>
        <p className="mt-0.5 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
          {event.created_at.slice(0, 10)} · {event.event_type} · {event.reason.replace(/_/gu, " ")}
          {event.goal_title ? ` · ${event.goal_title}` : ""}
        </p>
      </div>
      {event.event_type === "completed" && (
        <form action={followThroughDecisionAction}>
          <input type="hidden" name="id" value={event.commitment_id} />
          <input type="hidden" name="decision" value="regretted" />
          <button type="submit" className="text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
            Caused regret
          </button>
        </form>
      )}
    </li>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--shell-elevated)" }}>
      <p className="text-base font-medium leading-5 tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
        {label}
      </p>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m8.5 10 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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

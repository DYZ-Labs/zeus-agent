import Link from "next/link";

import {
  followThroughDecisionAction,
  setStewardshipModeAction,
} from "@/app/actions";
import { PageHeader } from "@/components/page-header";
import { hasCredentials } from "@/core/openai";
import type {
  FollowThroughEventView,
  FollowThroughRecommendation,
  StewardshipMode,
} from "@/core/schema";
import {
  followThroughMetrics,
  getStewardshipSetting,
  listFollowThroughEvents,
  recommendationForCommitment,
  recommendNextAction,
} from "@/core/stewardship";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const db = getDb();
  const focus = Number((await searchParams).focus);
  const recommendation = Number.isInteger(focus) && focus > 0
    ? recommendationForCommitment(db, focus)
    : recommendNextAction(db, "", { force: true });
  const setting = getStewardshipSetting(db);
  const metrics = followThroughMetrics(db);
  const events = listFollowThroughEvents(db, 20);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Today"
        meta={recommendation ? "one useful next action" : "nothing needs your attention"}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <p className="max-w-[68ch] text-[0.9rem] leading-6" style={{ color: "var(--shell-muted)" }}>
          Zeus ranks what is timely, meaningful, and actionable. It offers one step at a time,
          records your corrections, and leaves external actions under your control.
        </p>

        <section className="mt-8 max-w-[54rem]">
          {recommendation ? (
            <RecommendationCard recommendation={recommendation} canChat={hasCredentials()} />
          ) : (
            <div
              className="rounded-xl border border-dashed px-5 py-8"
              style={{ borderColor: "var(--shell-line-strong)" }}
            >
              <h2 className="text-[1rem] font-medium">Nothing worth interrupting you for.</h2>
              <p className="mt-2 max-w-[60ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
                That is a valid outcome. Zeus will stay quiet until an accepted commitment becomes
                relevant, urgent, stale, or explicitly important.
              </p>
            </div>
          )}
        </section>

        <section className="mt-11 max-w-[54rem]">
          <SectionTitle>Intervention control</SectionTitle>
          <p className="mt-2 text-[0.82rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            This changes when Zeus may interrupt. Snoozes and dismissals always override the mode.
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
        </section>

        <section className="mt-11 max-w-[54rem]">
          <SectionTitle>Progress and regret</SectionTitle>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric value={metrics.progressWithoutRegret} label="progress, no regret signal" />
            <Metric value={metrics.accepted} label="offers accepted" />
            <Metric value={metrics.controlsExercised} label="snoozed or dismissed" />
            <Metric value={metrics.regrets} label="regret signals" />
          </div>
          <p className="mt-3 max-w-[65ch] text-[0.75rem] leading-5" style={{ color: "var(--shell-faint)" }}>
            These are transparent signals, not an engagement score. Completion only counts here when
            it follows a Zeus recommendation; regret remains visible rather than being optimized away.
          </p>
        </section>

        {events.length > 0 && (
          <section className="mt-11 max-w-[54rem] pb-8">
            <SectionTitle>Decision history</SectionTitle>
            <ol className="mt-2">
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}

function RecommendationCard({
  recommendation,
  canChat,
}: {
  recommendation: FollowThroughRecommendation;
  canChat: boolean;
}) {
  return (
    <article
      className="rounded-xl border px-5 py-5"
      style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
    >
      <p
        className="font-mono text-[0.62rem] uppercase tracking-[0.14em]"
        style={{ color: "var(--shell-faint)" }}
      >
        Best current next step · {recommendation.reason.replace(/_/gu, " ")}
      </p>
      <h2 className="mt-3 text-[1.1rem] font-medium leading-6">
        {recommendation.suggested_action}
      </h2>
      <p className="mt-3 max-w-[68ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
        {recommendation.why}
      </p>
      {recommendation.requires_confirmation && (
        <p className="mt-3 font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
          Zeus may prepare the work; sending, scheduling, purchasing, or changing external state
          still requires your explicit confirmation.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 text-[0.78rem]">
        <DecisionForm id={recommendation.commitment_id} decision="accepted">
          <button
            type="submit"
            disabled={!canChat}
            className="rounded-md px-3 py-1.5 font-medium disabled:opacity-50"
            style={{ background: "var(--shell-accent)", color: "#000000" }}
          >
            Help me do this
          </button>
        </DecisionForm>
        <DecisionForm id={recommendation.commitment_id} decision="completed">
          <button type="submit">Already done</button>
        </DecisionForm>
        <DecisionForm id={recommendation.commitment_id} decision="snoozed">
          <button type="submit">Not now</button>
        </DecisionForm>
        <DecisionForm id={recommendation.commitment_id} decision="dismissed">
          <button type="submit" style={{ color: "var(--shell-faint)" }}>Not useful</button>
        </DecisionForm>
      </div>
      {!canChat && (
        <p className="mt-2 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
          Add an OpenAI API key to start this work in chat.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-4 font-mono text-[0.63rem]" style={{ color: "var(--shell-faint)" }}>
        <Link
          href={`/source/${recommendation.commitment_source_message_id}`}
          className="underline underline-offset-2"
        >
          source commitment
        </Link>
        {recommendation.goal_id && (
          <Link href="/open-loops" className="underline underline-offset-2">
            {recommendation.goal_priority ?? "normal"} priority goal
          </Link>
        )}
      </div>
    </article>
  );
}

function DecisionForm({
  id,
  decision,
  children,
}: {
  id: number;
  decision: "accepted" | "dismissed" | "snoozed" | "completed" | "regretted";
  children: React.ReactNode;
}) {
  return (
    <form action={followThroughDecisionAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      {children}
    </form>
  );
}

function EventRow({ event }: { event: FollowThroughEventView }) {
  return (
    <li className="flex flex-wrap items-start gap-4 border-b py-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="min-w-0 flex-1">
        <p className="text-[0.84rem]">{event.commitment_title}</p>
        <p className="mt-1 font-mono text-[0.62rem]" style={{ color: "var(--shell-faint)" }}>
          {event.created_at.slice(0, 10)} · {event.event_type} · {event.reason.replace(/_/gu, " ")} · {event.action_kind}
          {event.goal_title ? ` · ${event.goal_title}` : ""}
        </p>
      </div>
      {event.event_type === "completed" && (
        <DecisionForm id={event.commitment_id} decision="regretted">
          <button type="submit" className="font-mono text-[0.62rem]" style={{ color: "var(--shell-faint)" }}>
            this caused regret
          </button>
        </DecisionForm>
      )}
    </li>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ background: "var(--shell-panel)" }}>
      <p className="text-[1.35rem] font-medium tabular-nums">{value}</p>
      <p className="mt-1 text-[0.69rem]" style={{ color: "var(--shell-faint)" }}>{label}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
      {children}
    </h2>
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

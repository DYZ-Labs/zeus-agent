import Link from "next/link";

import {
  setGoalPriorityAction,
  snoozeCommitmentAction,
  updateCommitmentStatusAction,
  updateGoalStatusAction,
} from "@/app/actions";
import {
  commitmentEvents,
  goalEvents,
  listCommitments,
  listGoals,
} from "@/core/intentions";
import type {
  CommitmentStatus,
  CommitmentView,
  Goal,
  GoalPriority,
  GoalStatus,
} from "@/core/schema";
import { getDb } from "@/server/db";

export function Plans({ showCompleted }: { showCompleted: boolean }) {
  const db = getDb();
  const goals = listGoals(db, { includeClosed: showCompleted, limit: 300 });
  const commitments = listCommitments(db, { includeClosed: showCompleted, limit: 500 });

  return (
    <section id="plans" className="mt-12 max-w-[54rem] scroll-mt-4 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle>Plans</SectionTitle>
          <p className="mt-2 max-w-[62ch] text-[0.82rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            Goals and commitments are tracked quietly. Come here when you want to correct,
            pause, or close one.
          </p>
        </div>
        <Link
          href={showCompleted ? "/today#plans" : "/today?show=completed#plans"}
          className="font-mono text-[0.68rem] underline underline-offset-2"
          style={{ color: "var(--shell-muted)" }}
        >
          {showCompleted ? "hide completed" : "include completed"}
        </Link>
      </div>

      <section className="mt-7">
        <PlanGroupTitle title="Goals" count={goals.length} />
        {goals.length ? (
          <ul className="mt-2">
            {goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} />
            ))}
          </ul>
        ) : (
          <Empty>Tell Zeus what you are trying to achieve and it will appear here.</Empty>
        )}
      </section>

      <section className="mt-9">
        <PlanGroupTitle title="Commitments" count={commitments.length} />
        {commitments.length ? (
          <ul className="mt-2">
            {commitments.map((commitment) => (
              <CommitmentRow key={commitment.id} commitment={commitment} />
            ))}
          </ul>
        ) : (
          <Empty>Concrete promises and next actions will appear here.</Empty>
        )}
      </section>
    </section>
  );
}

function GoalRow({ goal }: { goal: Goal }) {
  const events = goalEvents(getDb(), goal.id);
  const actions: GoalStatus[] =
    goal.status === "active"
      ? ["paused", "achieved", "abandoned"]
      : goal.status === "paused"
        ? ["active", "achieved", "abandoned"]
        : ["active"];

  return (
    <li className="border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[0.94rem]">{goal.title}</p>
          <p className="mt-1.5 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
            {goal.status} · {goal.priority} priority
            {goal.target_at ? ` · target ${goal.target_at.slice(0, 10)}` : ""} ·{" "}
            <Link href={`/source/${goal.source_message_id}`} className="underline underline-offset-2">
              source
            </Link>
          </p>
        </div>
        <StatusActions id={goal.id} statuses={actions} action={updateGoalStatusAction} />
      </div>
      {(goal.status === "active" || goal.status === "paused") && (
        <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-[0.64rem]">
          <span style={{ color: "var(--shell-faint)" }}>priority</span>
          {(["low", "normal", "high"] as GoalPriority[]).map((priority) => (
            <form action={setGoalPriorityAction} key={priority}>
              <input type="hidden" name="id" value={goal.id} />
              <input type="hidden" name="priority" value={priority} />
              <button
                type="submit"
                disabled={priority === goal.priority}
                style={{ color: priority === goal.priority ? "var(--shell-fg)" : "var(--shell-faint)" }}
              >
                {priority}
              </button>
            </form>
          ))}
        </div>
      )}
      <EventHistory
        events={events.map(
          (event) =>
            `${event.created_at.slice(0, 10)} · ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.detail_json ? ` · ${event.detail_json}` : ""}`,
        )}
      />
    </li>
  );
}

function CommitmentRow({ commitment }: { commitment: CommitmentView }) {
  const events = commitmentEvents(getDb(), commitment.id);
  const actions: CommitmentStatus[] =
    commitment.status === "open"
      ? ["waiting", "done", "cancelled"]
      : commitment.status === "waiting"
        ? ["open", "done", "cancelled"]
        : ["open"];

  return (
    <li className="border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[0.94rem]">{commitment.title}</p>
          <p className="mt-1.5 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
            {commitment.status} · owner {commitment.owner_name}
            {commitment.goal_title ? ` · ${commitment.goal_title}` : ""}
            {commitment.due_at ? ` · due ${commitment.due_at.slice(0, 10)}` : ""} ·{" "}
            <Link href={`/source/${commitment.source_message_id}`} className="underline underline-offset-2">
              source
            </Link>
          </p>
          {commitment.snoozed_until && (
            <p className="mt-1 font-mono text-[0.64rem]" style={{ color: "var(--shell-muted)" }}>
              nudges snoozed until {commitment.snoozed_until.slice(0, 10)}
            </p>
          )}
        </div>
        <StatusActions
          id={commitment.id}
          statuses={actions}
          action={updateCommitmentStatusAction}
        />
      </div>
      {(commitment.status === "open" || commitment.status === "waiting") && (
        <form action={snoozeCommitmentAction} className="mt-3 flex items-center gap-2 font-mono text-[0.66rem]">
          <input type="hidden" name="id" value={commitment.id} />
          <label htmlFor={`snooze-${commitment.id}`} style={{ color: "var(--shell-faint)" }}>
            snooze nudges
          </label>
          <input
            id={`snooze-${commitment.id}`}
            name="until"
            type="date"
            required
            className="rounded-[3px] border px-2 py-1"
            style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
          />
          <button type="submit" style={{ color: "var(--shell-accent)" }}>
            save
          </button>
        </form>
      )}
      <EventHistory
        events={events.map(
          (event) =>
            `${event.created_at.slice(0, 10)} · ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.detail_json ? ` · ${event.detail_json}` : ""}`,
        )}
      />
    </li>
  );
}

function StatusActions<T extends string>({
  id,
  statuses,
  action,
}: {
  id: number;
  statuses: T[];
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap gap-3 font-mono text-[0.66rem]">
      {statuses.map((status) => (
        <form action={action} key={status}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value={status} />
          <button type="submit" style={{ color: "var(--shell-muted)" }}>
            {status}
          </button>
        </form>
      ))}
    </div>
  );
}

function EventHistory({ events }: { events: string[] }) {
  return (
    <details className="mt-3 font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
      <summary className="cursor-pointer">history · {events.length}</summary>
      <ol className="mt-2 space-y-1 border-l pl-3" style={{ borderColor: "var(--shell-line-strong)" }}>
        {events.map((event, index) => (
          <li key={`${event}-${index}`}>{event}</li>
        ))}
      </ol>
    </details>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
      {children}
    </h2>
  );
}

function PlanGroupTitle({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="font-mono text-[0.65rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
      {title} · {count}
    </h3>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="mt-3 rounded-[6px] border border-dashed px-4 py-5 text-[0.88rem]"
      style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
    >
      {children}
    </p>
  );
}

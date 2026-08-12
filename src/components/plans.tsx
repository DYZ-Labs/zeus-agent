import Link from "next/link";

import {
  recordProjectProgressAction,
  setProjectBlockedAction,
  setGoalPriorityAction,
  snoozeCommitmentAction,
  updateCommitmentStatusAction,
  updateGoalStatusAction,
  updateProjectStatusAction,
} from "@/app/actions";
import {
  commitmentEvents,
  goalEvents,
  listCommitments,
  listGoals,
} from "@/core/intentions";
import type { Db } from "@/core/db";
import { listProjects, projectEvents } from "@/core/projects";
import type {
  CommitmentStatus,
  CommitmentView,
  Goal,
  GoalPriority,
  GoalStatus,
  ProjectStatus,
  ProjectView,
} from "@/core/schema";

export function Plans({ db, showCompleted }: { db: Db; showCompleted: boolean }) {
  const goals = listGoals(db, { includeClosed: showCompleted, limit: 300 });
  const commitments = listCommitments(db, { includeClosed: showCompleted, limit: 500 });
  const projects = listProjects(db, { includeClosed: showCompleted, limit: 300 });
  const projectNames = new Map(projects.map((project) => [project.id, project.entity_name]));

  return (
    <section id="plans" className="mt-12 max-w-[54rem] scroll-mt-4 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle>Plans</SectionTitle>
          <p className="mt-2 max-w-[62ch] text-[0.82rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            Projects, goals, and commitments are tracked quietly. Come here when you want to
            record progress, correct status, pause, or close one.
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
        <PlanGroupTitle title="Projects" count={projects.length} />
        {projects.length ? (
          <ul className="mt-2">
            {projects.map((project) => (
              <ProjectRow key={project.id} db={db} project={project} />
            ))}
          </ul>
        ) : (
          <Empty>Tell Zeus about a project and its lifecycle will appear here.</Empty>
        )}
      </section>

      <section className="mt-9">
        <PlanGroupTitle title="Goals" count={goals.length} />
        {goals.length ? (
          <ul className="mt-2">
            {goals.map((goal) => (
              <GoalRow
                key={goal.id}
                db={db}
                goal={goal}
                projectName={goal.project_id === null ? null : projectNames.get(goal.project_id) ?? null}
              />
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
              <CommitmentRow
                key={commitment.id}
                db={db}
                commitment={commitment}
                projectName={commitment.project_id === null ? null : projectNames.get(commitment.project_id) ?? null}
              />
            ))}
          </ul>
        ) : (
          <Empty>Concrete promises and next actions will appear here.</Empty>
        )}
      </section>
    </section>
  );
}

function ProjectRow({ db, project }: { db: Db; project: ProjectView }) {
  const events = projectEvents(db, project.id);
  const actions: ProjectStatus[] =
    project.status === "planned"
      ? ["active", "paused", "completed", "abandoned"]
      : project.status === "active"
        ? ["paused", "completed", "abandoned"]
        : project.status === "paused"
          ? ["active", "completed", "abandoned"]
          : ["active"];

  return (
    <li className="border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[0.94rem]">{project.entity_name}</p>
          <p className="mt-1.5 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
            {project.status}
            {project.progress_percent === null
              ? ""
              : ` · ${Math.round(project.progress_percent * 100)}%`}
            {project.blocked_at ? " · blocked" : ""} ·{" "}
            <Link href={`/source/${project.source_message_id}`} className="underline underline-offset-2">
              source
            </Link>
          </p>
          {project.progress_summary && (
            <p className="mt-1 text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              {project.progress_summary}
            </p>
          )}
        </div>
        <StatusActions id={project.id} statuses={actions} action={updateProjectStatusAction} />
      </div>

      {!['completed', 'abandoned'].includes(project.status) && (
        <form action={recordProjectProgressAction} className="mt-3 flex flex-wrap items-end gap-2 text-[0.7rem]">
          <input type="hidden" name="id" value={project.id} />
          <label className="min-w-[14rem] flex-1" style={{ color: "var(--shell-faint)" }}>
            Progress note
            <input
              name="summary"
              maxLength={2000}
              placeholder="What changed?"
              className="mt-1 block min-h-9 w-full rounded-md border px-2.5 text-[0.78rem]"
              style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
            />
          </label>
          <label style={{ color: "var(--shell-faint)" }}>
            Percent
            <input
              name="percent"
              type="number"
              min="0"
              max="100"
              step="1"
              defaultValue={project.progress_percent === null ? "" : Math.round(project.progress_percent * 100)}
              className="mt-1 block min-h-9 w-20 rounded-md border px-2 text-[0.78rem]"
              style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
            />
          </label>
          <button type="submit" className="min-h-9" style={{ color: "var(--shell-accent)" }}>
            record
          </button>
        </form>
      )}

      {!['completed', 'abandoned'].includes(project.status) && (
        <form action={setProjectBlockedAction} className="mt-3 flex flex-wrap items-end gap-2 text-[0.7rem]">
          <input type="hidden" name="id" value={project.id} />
          <input type="hidden" name="blocked" value={project.blocked_at ? "false" : "true"} />
          <label className="min-w-[14rem] flex-1" style={{ color: "var(--shell-faint)" }}>
            {project.blocked_at ? "Resolution" : "Blocker"} (optional)
            <input
              name="reason"
              maxLength={1000}
              className="mt-1 block min-h-9 w-full rounded-md border px-2.5 text-[0.78rem]"
              style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
            />
          </label>
          <button type="submit" className="min-h-9" style={{ color: "var(--shell-muted)" }}>
            {project.blocked_at ? "clear blocker" : "mark blocked"}
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

function GoalRow({ db, goal, projectName }: { db: Db; goal: Goal; projectName: string | null }) {
  const events = goalEvents(db, goal.id);
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
            {projectName ? ` · project ${projectName}` : ""}
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

function CommitmentRow({
  db,
  commitment,
  projectName,
}: {
  db: Db;
  commitment: CommitmentView;
  projectName: string | null;
}) {
  const events = commitmentEvents(db, commitment.id);
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
            {projectName ? ` · project ${projectName}` : ""}
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

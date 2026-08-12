import Link from "next/link";

import {
  updateCommitmentStatusAction,
  updateGoalStatusAction,
  updateProjectStatusAction,
} from "@/app/actions";
import type { PlanItemDto } from "@/core/plan-dtos";

type PlanAction = { label: string; status: string; destructive?: boolean };

export function Plans({
  items,
  showCompleted,
}: {
  items: readonly PlanItemDto[];
  showCompleted: boolean;
}) {
  return (
    <section id="plans" className="mt-12 max-w-[54rem] scroll-mt-4 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Your plans</h2>
          <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
            The projects, outcomes, and promises Zeus is helping you follow through on.
          </p>
        </div>
        <Link
          href={showCompleted ? "/today#plans" : "/today?show=completed#plans"}
          className="text-sm underline underline-offset-4"
          style={{ color: "var(--shell-muted)" }}
        >
          {showCompleted ? "Hide finished" : "Show finished"}
        </Link>
      </div>

      {items.length > 0 ? (
        <ul className="mt-5 overflow-hidden rounded-xl border" style={{ borderColor: "var(--shell-line-strong)" }}>
          {items.map((item) => <PlanRow key={item.id} item={item} />)}
        </ul>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed px-5 py-7" style={{ borderColor: "var(--shell-line-strong)" }}>
          <p className="text-sm" style={{ color: "var(--shell-muted)" }}>
            Tell Zeus what you want to make progress on and it will appear here.
          </p>
          <Link href="/?prompt=Remember%20what%20I%27m%20working%20on" className="mt-3 inline-block text-sm font-medium underline underline-offset-4">
            Start in chat
          </Link>
        </div>
      )}
    </section>
  );
}

function PlanRow({ item }: { item: PlanItemDto }) {
  const action = item.kind === "project"
    ? updateProjectStatusAction
    : item.kind === "goal"
      ? updateGoalStatusAction
      : updateCommitmentStatusAction;
  const actions = item.closed ? resumeAction(item) : openActions(item);

  return (
    <li id={item.id} className="scroll-mt-4 border-b px-4 py-4 last:border-b-0" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium leading-5">{item.title}</p>
            <span className="rounded-full border px-2 py-0.5 text-xs" style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}>
              {item.statusLabel}
            </span>
          </div>
          {(item.detail || item.dueDate) && (
            <p className="mt-1.5 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
              {[item.detail, item.dueDate ? `By ${formatDate(item.dueDate)}` : null].filter(Boolean).join(" · ")}
            </p>
          )}
          <Link href={`/source/${item.sourceId}`} className="mt-2 inline-block text-xs underline underline-offset-4" style={{ color: "var(--shell-faint)" }}>
            Why Zeus knows this
          </Link>
        </div>
        <div className="flex flex-wrap justify-end gap-x-3 gap-y-2 text-xs">
          {actions.map((entry) => (
            <form action={action} key={entry.status}>
              <input type="hidden" name="id" value={item.id} />
              <button type="submit" name="status" value={entry.status} style={{ color: entry.destructive ? "#ff8585" : "var(--shell-muted)" }}>
                {entry.label}
              </button>
            </form>
          ))}
        </div>
      </div>
    </li>
  );
}

function openActions(item: PlanItemDto): PlanAction[] {
  if (item.kind === "commitment") {
    return item.status === "waiting"
      ? [
          { label: "Resume", status: "open" },
          { label: "Mark done", status: "done" },
          { label: "Stop tracking", status: "cancelled", destructive: true },
        ]
      : [
          { label: "Waiting on someone", status: "waiting" },
          { label: "Mark done", status: "done" },
          { label: "Stop tracking", status: "cancelled", destructive: true },
        ];
  }
  if (item.kind === "goal") {
    return item.status === "paused"
      ? [
          { label: "Resume", status: "active" },
          { label: "Mark done", status: "achieved" },
          { label: "Stop tracking", status: "abandoned", destructive: true },
        ]
      : [
          { label: "Pause", status: "paused" },
          { label: "Mark done", status: "achieved" },
          { label: "Stop tracking", status: "abandoned", destructive: true },
        ];
  }
  return item.status === "paused"
    ? [
        { label: "Resume", status: "active" },
        { label: "Mark done", status: "completed" },
        { label: "Stop tracking", status: "abandoned", destructive: true },
      ]
    : [
        { label: "Pause", status: "paused" },
        { label: "Mark done", status: "completed" },
        { label: "Stop tracking", status: "abandoned", destructive: true },
      ];
}

function resumeAction(item: PlanItemDto): PlanAction[] {
  return [{ label: "Track again", status: item.kind === "commitment" ? "open" : "active" }];
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

import { z } from "zod";

import type { Db } from "./db";
import { listCommitments, listGoals } from "./intentions";
import { listProjects } from "./projects";
import { resourceId } from "./resource-id";

export const PlanItemDto = z
  .object({
    id: z.string(),
    kind: z.enum(["project", "goal", "commitment"]),
    title: z.string(),
    status: z.string(),
    statusLabel: z.string(),
    detail: z.string().nullable(),
    dueDate: z.string().nullable(),
    sourceId: z.string(),
    closed: z.boolean(),
  })
  .strict();
export type PlanItemDto = z.infer<typeof PlanItemDto>;

export function planItems(db: Db, includeClosed = false): PlanItemDto[] {
  const projects = listProjects(db, { includeClosed, limit: 300 }).map((project) => ({
    id: resourceId("project", project.id),
    kind: "project" as const,
    title: project.entity_name,
    status: project.status,
    statusLabel: project.blocked_at ? "Blocked" : humanStatus(project.status),
    detail: project.progress_summary ?? (
      project.progress_percent === null
        ? null
        : `${Math.round(project.progress_percent * 100)}% complete`
    ),
    dueDate: null,
    sourceId: resourceId("message", project.source_message_id),
    closed: project.status === "completed" || project.status === "abandoned",
  }));
  const goals = listGoals(db, { includeClosed, limit: 300 }).map((goal) => ({
    id: resourceId("goal", goal.id),
    kind: "goal" as const,
    title: goal.title,
    status: goal.status,
    statusLabel: humanStatus(goal.status),
    detail: goal.priority === "high" ? "Important" : null,
    dueDate: goal.target_at,
    sourceId: resourceId("message", goal.source_message_id),
    closed: goal.status === "achieved" || goal.status === "abandoned",
  }));
  const commitments = listCommitments(db, { includeClosed, limit: 500 }).map((item) => ({
    id: resourceId("commitment", item.id),
    kind: "commitment" as const,
    title: item.title,
    status: item.status,
    statusLabel: item.status === "waiting" ? "Waiting on someone" : humanStatus(item.status),
    detail: item.goal_title ? `For ${item.goal_title}` : null,
    dueDate: item.due_at,
    sourceId: resourceId("message", item.source_message_id),
    closed: item.status === "done" || item.status === "cancelled",
  }));

  return PlanItemDto.array().parse([...commitments, ...goals, ...projects]);
}

function humanStatus(value: string): string {
  const labels: Record<string, string> = {
    abandoned: "Stopped",
    achieved: "Done",
    active: "Active",
    cancelled: "Stopped",
    completed: "Done",
    done: "Done",
    open: "In progress",
    paused: "Paused",
    planned: "Planned",
    waiting: "Waiting on someone",
  };
  return labels[value] ?? value.replace(/_/gu, " ");
}

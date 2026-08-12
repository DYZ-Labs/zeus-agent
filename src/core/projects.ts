import type { Db } from "./db";
import { now } from "./db";
import { getEntity } from "./entities";
import type {
  ProjectEvent,
  ProjectStatus,
  ProjectView,
} from "./schema";

export type ProjectInput = {
  entityId: number;
  status?: ProjectStatus;
  progressSummary?: string | null;
  progressPercent?: number | null;
  confidence?: number;
  sourceMessageId: number;
  passageId?: number | null;
};

export type ProjectEventSource = {
  sourceMessageId?: number | null;
  sourceKind?: "message" | "user_action";
  passageId?: number | null;
};

export type ProjectUpdate = ProjectEventSource & {
  status?: ProjectStatus;
  progressSummary?: string | null;
  progressPercent?: number | null;
  confidence?: number;
};

export type ProjectProgressInput = ProjectEventSource & {
  summary?: string | null;
  percent?: number | null;
};

export type ProjectBlockedInput = ProjectEventSource & {
  reason?: string | null;
};

export type ProjectUnblockedInput = ProjectEventSource & {
  resolution?: string | null;
};

const SELECT_PROJECT = `
  SELECT p.id, p.entity_id, p.status, p.progress_summary, p.progress_percent,
         p.blocked_at, p.confidence, p.source_message_id, p.created_at,
         p.updated_at, p.closed_at, e.name AS entity_name, e.slug AS entity_slug
  FROM project p
  JOIN entity e ON e.id = p.entity_id
`;

export function getProject(db: Db, id: number): ProjectView | null {
  return db.prepare<[number], ProjectView>(`${SELECT_PROJECT} WHERE p.id = ?`).get(id) ?? null;
}

export function getProjectByEntityId(db: Db, entityId: number): ProjectView | null {
  return (
    db
      .prepare<[number], ProjectView>(`${SELECT_PROJECT} WHERE p.entity_id = ?`)
      .get(entityId) ?? null
  );
}

export function listProjects(
  db: Db,
  options: { includeClosed?: boolean; limit?: number } = {},
): ProjectView[] {
  const open = options.includeClosed
    ? ""
    : "WHERE p.status IN ('planned','active','paused')";
  return db
    .prepare<[number], ProjectView>(
      `${SELECT_PROJECT} ${open}
       ORDER BY p.blocked_at IS NOT NULL DESC,
                CASE p.status
                  WHEN 'active' THEN 0 WHEN 'planned' THEN 1 WHEN 'paused' THEN 2
                  WHEN 'completed' THEN 3 ELSE 4
                END,
                p.updated_at DESC, p.id
       LIMIT ?`,
    )
    .all(options.limit ?? 200);
}

/**
 * Create the durable lifecycle record for an existing project entity.
 *
 * The entity and the project are deliberately separate: entity identity handles names,
 * aliases, and graph links, while this row tracks source-backed project state over time.
 */
export function createProject(db: Db, input: ProjectInput): ProjectView {
  const entity = getEntity(db, input.entityId);
  if (!entity) throw new Error(`Project entity ${input.entityId} does not exist`);
  if (entity.kind !== "project") {
    throw new Error(`Entity ${input.entityId} is not a project entity`);
  }
  assertUserSource(db, input.sourceMessageId);
  assertPassageMatchesSource(db, input.sourceMessageId, input.passageId ?? null);

  const status = input.status ?? "planned";
  const progressSummary = normalizeText(input.progressSummary ?? null);
  const progressPercent = normalizeProgress(input.progressPercent ?? null);
  const confidence = clampConfidence(input.confidence ?? 0.9);
  const existing = getProjectByEntityId(db, input.entityId);

  if (existing) {
    if (
      existing.source_message_id === input.sourceMessageId &&
      (input.status === undefined || existing.status === status) &&
      (input.progressSummary === undefined || existing.progress_summary === progressSummary) &&
      (input.progressPercent === undefined || existing.progress_percent === progressPercent) &&
      (input.confidence === undefined || existing.confidence === confidence)
    ) {
      return existing;
    }
    return (
      updateProject(db, existing.id, {
        status: input.status,
        progressSummary: input.progressSummary,
        progressPercent: input.progressPercent,
        confidence: input.confidence,
        sourceMessageId: input.sourceMessageId,
        sourceKind: "message",
        passageId: input.passageId,
      }) ?? existing
    );
  }

  const timestamp = now();
  const created = db.transaction(() => {
    const inserted = db
      .prepare<[
        number,
        ProjectStatus,
        string | null,
        number | null,
        number,
        number,
        string,
        string,
        string | null,
      ]>(
        `INSERT INTO project
           (entity_id, status, progress_summary, progress_percent, confidence,
            source_message_id, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.entityId,
        status,
        progressSummary,
        progressPercent,
        confidence,
        input.sourceMessageId,
        timestamp,
        timestamp,
        isClosed(status) ? timestamp : null,
      );
    const id = Number(inserted.lastInsertRowid);
    insertProjectEvent(
      db,
      id,
      "created",
      null,
      status,
      {
        entity_id: input.entityId,
        progress_summary: progressSummary,
        progress_percent: progressPercent,
        confidence,
      },
      {
        sourceMessageId: input.sourceMessageId,
        sourceKind: "message",
        passageId: input.passageId ?? null,
      },
    );
    return getProject(db, id);
  })();

  if (!created) throw new Error("Project vanished immediately after insert");
  return created;
}

export function updateProject(db: Db, id: number, update: ProjectUpdate): ProjectView | null {
  const existing = getProject(db, id);
  if (!existing) return null;
  const source = normalizeEventSource(db, update);
  const status = update.status ?? existing.status;
  const progressSummary =
    update.progressSummary === undefined
      ? existing.progress_summary
      : normalizeText(update.progressSummary);
  const progressPercent =
    update.progressPercent === undefined
      ? existing.progress_percent
      : normalizeProgress(update.progressPercent);
  const confidence =
    update.confidence === undefined
      ? existing.confidence
      : clampConfidence(update.confidence);
  const blockedAt = isClosed(status) ? null : existing.blocked_at;

  if (
    status === existing.status &&
    progressSummary === existing.progress_summary &&
    progressPercent === existing.progress_percent &&
    confidence === existing.confidence &&
    blockedAt === existing.blocked_at &&
    source.sourceMessageId !== null &&
    hasEventFromSource(db, id, source.sourceMessageId, null)
  ) {
    return existing;
  }

  const timestamp = now();
  return db.transaction(() => {
    db.prepare<[
      ProjectStatus,
      string | null,
      number | null,
      string | null,
      number,
      string,
      string | null,
      number,
    ]>(
      `UPDATE project
       SET status = ?, progress_summary = ?, progress_percent = ?, blocked_at = ?,
           confidence = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    ).run(
      status,
      progressSummary,
      progressPercent,
      blockedAt,
      confidence,
      timestamp,
      isClosed(status) ? existing.closed_at ?? timestamp : null,
      id,
    );

    insertProjectEvent(
      db,
      id,
      status === existing.status ? "updated" : "status_changed",
      existing.status,
      status,
      {
        before: {
          progress_summary: existing.progress_summary,
          progress_percent: existing.progress_percent,
          blocked_at: existing.blocked_at,
          confidence: existing.confidence,
        },
        after: {
          progress_summary: progressSummary,
          progress_percent: progressPercent,
          blocked_at: blockedAt,
          confidence,
        },
      },
      source,
    );
    return getProject(db, id);
  })();
}

/** Record project progress without conflating the observation with a status change. */
export function recordProjectProgress(
  db: Db,
  id: number,
  input: ProjectProgressInput,
): ProjectView | null {
  const existing = getProject(db, id);
  if (!existing) return null;
  if (input.summary === undefined && input.percent === undefined) {
    throw new Error("Project progress requires a summary or percent");
  }
  const source = normalizeEventSource(db, input);
  const progressSummary =
    input.summary === undefined ? existing.progress_summary : normalizeText(input.summary);
  const progressPercent =
    input.percent === undefined ? existing.progress_percent : normalizeProgress(input.percent);

  if (
    progressSummary === existing.progress_summary &&
    progressPercent === existing.progress_percent &&
    source.sourceMessageId !== null &&
    hasEventFromSource(db, id, source.sourceMessageId, "progress")
  ) {
    return existing;
  }

  return db.transaction(() => {
    db.prepare<[string | null, number | null, string, number]>(
      `UPDATE project
       SET progress_summary = ?, progress_percent = ?, updated_at = ?
       WHERE id = ?`,
    ).run(progressSummary, progressPercent, now(), id);
    insertProjectEvent(
      db,
      id,
      "progress",
      existing.status,
      existing.status,
      {
        before: {
          summary: existing.progress_summary,
          percent: existing.progress_percent,
        },
        after: { summary: progressSummary, percent: progressPercent },
      },
      source,
    );
    return getProject(db, id);
  })();
}

export function markProjectBlocked(
  db: Db,
  id: number,
  input: ProjectBlockedInput,
): ProjectView | null {
  const existing = getProject(db, id);
  if (!existing) return null;
  const source = normalizeEventSource(db, input);
  if (
    existing.blocked_at !== null &&
    source.sourceMessageId !== null &&
    hasEventFromSource(db, id, source.sourceMessageId, "blocked")
  ) {
    return existing;
  }

  const timestamp = now();
  const blockedAt = existing.blocked_at ?? timestamp;
  return db.transaction(() => {
    db.prepare<[string, string, number]>(
      "UPDATE project SET blocked_at = ?, updated_at = ? WHERE id = ?",
    ).run(blockedAt, timestamp, id);
    insertProjectEvent(
      db,
      id,
      "blocked",
      existing.status,
      existing.status,
      {
        reason: normalizeText(input.reason ?? null),
        blocked_at: blockedAt,
        already_blocked: existing.blocked_at !== null,
      },
      source,
    );
    return getProject(db, id);
  })();
}

export function markProjectUnblocked(
  db: Db,
  id: number,
  input: ProjectUnblockedInput,
): ProjectView | null {
  const existing = getProject(db, id);
  if (!existing) return null;
  if (existing.blocked_at === null) return existing;
  const source = normalizeEventSource(db, input);

  return db.transaction(() => {
    db.prepare<[string, number]>(
      "UPDATE project SET blocked_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now(), id);
    insertProjectEvent(
      db,
      id,
      "unblocked",
      existing.status,
      existing.status,
      {
        blocked_at: existing.blocked_at,
        resolution: normalizeText(input.resolution ?? null),
      },
      source,
    );
    return getProject(db, id);
  })();
}

export function projectEvents(db: Db, projectId: number): ProjectEvent[] {
  return db
    .prepare<[number], ProjectEvent>(
      `SELECT id, project_id, event_type, from_status, to_status, detail_json,
              source_message_id, passage_id, source_kind, created_at
       FROM project_event WHERE project_id = ? ORDER BY id`,
    )
    .all(projectId);
}

function insertProjectEvent(
  db: Db,
  projectId: number,
  eventType: ProjectEvent["event_type"],
  fromStatus: ProjectStatus | null,
  toStatus: ProjectStatus | null,
  detail: unknown,
  source: Required<ProjectEventSource>,
): void {
  db.prepare<[
    number,
    ProjectEvent["event_type"],
    ProjectStatus | null,
    ProjectStatus | null,
    string | null,
    number | null,
    number | null,
    ProjectEvent["source_kind"],
    string,
  ]>(
    `INSERT INTO project_event
       (project_id, event_type, from_status, to_status, detail_json,
        source_message_id, passage_id, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    eventType,
    fromStatus,
    toStatus,
    detail === null ? null : JSON.stringify(detail),
    source.sourceMessageId,
    source.passageId,
    source.sourceKind,
    now(),
  );
}

function normalizeEventSource(
  db: Db,
  source: ProjectEventSource,
): Required<ProjectEventSource> {
  const sourceMessageId = source.sourceMessageId ?? null;
  if (source.sourceKind === undefined && sourceMessageId === null) {
    throw new Error(
      "Project events require a stored user message or an explicit user_action source",
    );
  }
  const sourceKind = source.sourceKind ?? "message";
  const passageId = source.passageId ?? null;

  if (sourceKind === "message" && sourceMessageId === null) {
    throw new Error("Message-backed project events require a source message");
  }
  if (sourceMessageId !== null) assertUserSource(db, sourceMessageId);
  assertPassageMatchesSource(db, sourceMessageId, passageId);
  return { sourceMessageId, sourceKind, passageId };
}

function assertUserSource(db: Db, sourceMessageId: number): void {
  const source = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(sourceMessageId);
  if (source?.role !== "user") {
    throw new Error("Project provenance requires a stored user message");
  }
}

function assertPassageMatchesSource(
  db: Db,
  sourceMessageId: number | null,
  passageId: number | null,
): void {
  if (passageId === null) return;
  const messageId = db
    .prepare<[number], { message_id: number }>(
      "SELECT message_id FROM evidence_passage WHERE id = ?",
    )
    .get(passageId)?.message_id;
  if (sourceMessageId === null || messageId !== sourceMessageId) {
    throw new Error(`Evidence passage ${passageId} does not match its project source`);
  }
}

function hasEventFromSource(
  db: Db,
  projectId: number,
  sourceMessageId: number,
  eventType: ProjectEvent["event_type"] | null,
): boolean {
  if (eventType === null) {
    return Boolean(
      db
        .prepare<[number, number], { found: number }>(
          `SELECT 1 AS found FROM project_event
           WHERE project_id = ? AND source_message_id = ? LIMIT 1`,
        )
        .get(projectId, sourceMessageId),
    );
  }
  return Boolean(
    db
      .prepare<[number, number, ProjectEvent["event_type"]], { found: number }>(
        `SELECT 1 AS found FROM project_event
         WHERE project_id = ? AND source_message_id = ? AND event_type = ? LIMIT 1`,
      )
      .get(projectId, sourceMessageId, eventType),
  );
}

function normalizeText(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function normalizeProgress(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Project progress percent must be between 0 and 1");
  }
  return value;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0.01, Number.isFinite(value) ? value : 0.8));
}

function isClosed(status: ProjectStatus): boolean {
  return status === "completed" || status === "abandoned";
}

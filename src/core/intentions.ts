import type { Db } from "./db";
import { now } from "./db";
import { foldAlias, selfEntity } from "./entities";
import type {
  CommitmentEvent,
  CommitmentStatus,
  CommitmentView,
  Goal,
  GoalEvent,
  GoalPriority,
  GoalStatus,
} from "./schema";

export type GoalInput = {
  title: string;
  status?: GoalStatus;
  priority?: GoalPriority;
  targetAt?: string | null;
  projectId?: number | null;
  confidence?: number;
  sourceMessageId: number;
  sourceKind?: "message" | "user_action";
  passageId?: number | null;
};

export type GoalUpdate = {
  title?: string;
  status?: GoalStatus;
  priority?: GoalPriority;
  targetAt?: string | null;
  projectId?: number | null;
  confidence?: number;
  sourceMessageId?: number | null;
  sourceKind?: "message" | "user_action";
  passageId?: number | null;
};

export function getGoal(db: Db, id: number): Goal | null {
  return (
    db
      .prepare<[number], Goal>(
        `SELECT id, title, status, priority, target_at, project_id, confidence, source_message_id,
                created_at, updated_at, closed_at
         FROM goal WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function listGoals(
  db: Db,
  options: { includeClosed?: boolean; limit?: number } = {},
): Goal[] {
  const closed = options.includeClosed ? "" : "WHERE status IN ('active','paused')";
  return db
    .prepare<[number], Goal>(
      `SELECT id, title, status, priority, target_at, project_id, confidence, source_message_id,
              created_at, updated_at, closed_at
       FROM goal ${closed}
       ORDER BY status = 'active' DESC,
                CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                target_at IS NULL, target_at, updated_at DESC
       LIMIT ?`,
    )
    .all(options.limit ?? 200);
}

export function createGoal(db: Db, input: GoalInput): Goal {
  const title = input.title.trim();
  if (!title) throw new Error("Refusing to create a goal with an empty title");

  const duplicate = listGoals(db, { limit: 500 }).find(
    (goal) => foldAlias(goal.title) === foldAlias(title),
  );
  if (duplicate) {
    const target = normalizeDate(input.targetAt);
    if (
      duplicate.source_message_id === input.sourceMessageId &&
      duplicate.status === (input.status ?? "active") &&
      duplicate.priority === (input.priority ?? "normal") &&
      duplicate.target_at === target
      && duplicate.project_id === (input.projectId ?? null)
    ) {
      return duplicate;
    }
    return updateGoal(db, duplicate.id, {
      status: input.status,
      priority: input.priority,
      targetAt: input.targetAt,
      projectId: input.projectId,
      confidence: input.confidence,
      sourceMessageId: input.sourceMessageId,
      sourceKind: input.sourceKind ?? "message",
    }) ?? duplicate;
  }

  const timestamp = now();
  const status = input.status ?? "active";
  const result = db.transaction(() => {
    const inserted = db
      .prepare<[
        string,
        GoalStatus,
        GoalPriority,
        string | null,
        number | null,
        number,
        number,
        string,
        string,
        string | null,
      ]>(
        `INSERT INTO goal
           (title, status, priority, target_at, project_id, confidence, source_message_id,
            created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        status,
        input.priority ?? "normal",
        normalizeDate(input.targetAt),
        input.projectId ?? null,
        clamp(input.confidence ?? 0.9),
        input.sourceMessageId,
        timestamp,
        timestamp,
        isGoalClosed(status) ? timestamp : null,
      );
    const id = Number(inserted.lastInsertRowid);
    insertGoalEvent(
      db,
      id,
      "created",
      null,
      status,
      {
        title,
        priority: input.priority ?? "normal",
        target_at: normalizeDate(input.targetAt),
        project_id: input.projectId ?? null,
        confidence: clamp(input.confidence ?? 0.9),
      },
      input.sourceMessageId,
      input.sourceKind ?? "message",
      input.passageId ?? null,
    );
    return getGoal(db, id);
  })();

  if (!result) throw new Error("Goal vanished immediately after insert");
  return result;
}

export function updateGoal(db: Db, id: number, update: GoalUpdate): Goal | null {
  const existing = getGoal(db, id);
  if (!existing) return null;
  const title = update.title?.trim() || existing.title;
  const status = update.status ?? existing.status;
  const priority = update.priority ?? existing.priority;
  const targetAt = update.targetAt === undefined ? existing.target_at : normalizeDate(update.targetAt);
  const projectId = update.projectId === undefined ? existing.project_id : update.projectId;
  const confidence = update.confidence === undefined ? existing.confidence : clamp(update.confidence);
  const timestamp = now();

  if (
    update.sourceMessageId &&
    title === existing.title &&
    status === existing.status &&
    priority === existing.priority &&
    targetAt === existing.target_at &&
    projectId === existing.project_id &&
    confidence === existing.confidence &&
    db
      .prepare<[number, number], { found: number }>(
        "SELECT 1 AS found FROM goal_event WHERE goal_id = ? AND source_message_id = ? LIMIT 1",
      )
      .get(id, update.sourceMessageId)
  ) {
    return existing;
  }

  return db.transaction(() => {
    db.prepare<[
      string,
      GoalStatus,
      GoalPriority,
      string | null,
      number | null,
      number,
      string,
      string | null,
      number,
    ]>(
      `UPDATE goal
       SET title = ?, status = ?, priority = ?, target_at = ?, project_id = ?, confidence = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    ).run(
      title,
      status,
      priority,
      targetAt,
      projectId,
      confidence,
      timestamp,
      isGoalClosed(status) ? existing.closed_at ?? timestamp : null,
      id,
    );

    const changedStatus = status !== existing.status;
    insertGoalEvent(
      db,
      id,
      changedStatus ? "status_changed" : "updated",
      existing.status,
      status,
      {
        before: {
          title: existing.title,
          priority: existing.priority,
          target_at: existing.target_at,
          project_id: existing.project_id,
          confidence: existing.confidence,
        },
        after: { title, priority, target_at: targetAt, project_id: projectId, confidence },
      },
      update.sourceMessageId ?? null,
      update.sourceKind ?? (update.sourceMessageId ? "message" : "user_action"),
      update.passageId ?? null,
    );
    return getGoal(db, id);
  })();
}

export function goalEvents(db: Db, goalId: number): GoalEvent[] {
  return db
    .prepare<[number], GoalEvent>(
      `SELECT id, goal_id, event_type, from_status, to_status, detail_json,
              source_message_id, passage_id, source_kind, created_at
       FROM goal_event WHERE goal_id = ? ORDER BY id`,
    )
    .all(goalId);
}

function insertGoalEvent(
  db: Db,
  goalId: number,
  eventType: GoalEvent["event_type"],
  fromStatus: GoalStatus | null,
  toStatus: GoalStatus | null,
  detail: unknown,
  sourceMessageId: number | null,
  sourceKind: GoalEvent["source_kind"],
  passageId: number | null = null,
): void {
  assertPassageMatchesSource(db, sourceMessageId, passageId);
  db.prepare<[
    number,
    GoalEvent["event_type"],
    GoalStatus | null,
    GoalStatus | null,
    string | null,
    number | null,
    number | null,
    GoalEvent["source_kind"],
    string,
  ]>(
    `INSERT INTO goal_event
       (goal_id, event_type, from_status, to_status, detail_json,
        source_message_id, passage_id, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    goalId,
    eventType,
    fromStatus,
    toStatus,
    detail === null ? null : JSON.stringify(detail),
    sourceMessageId,
    passageId,
    sourceKind,
    now(),
  );
}

export type CommitmentInput = {
  title: string;
  ownerEntityId?: number;
  linkedGoalId?: number | null;
  projectId?: number | null;
  status?: CommitmentStatus;
  dueAt?: string | null;
  confidence?: number;
  sourceMessageId: number;
  sourceKind?: "message" | "user_action";
  passageId?: number | null;
};

export type CommitmentUpdate = {
  title?: string;
  ownerEntityId?: number;
  linkedGoalId?: number | null;
  projectId?: number | null;
  status?: CommitmentStatus;
  dueAt?: string | null;
  snoozedUntil?: string | null;
  confidence?: number;
  sourceMessageId?: number | null;
  sourceKind?: "message" | "user_action";
  passageId?: number | null;
};

const SELECT_COMMITMENT = `
  SELECT c.id, c.title, c.owner_entity_id, c.linked_goal_id, c.project_id, c.status,
         c.due_at, c.snoozed_until, c.last_surfaced_at, c.confidence,
         c.source_message_id, c.created_at, c.updated_at, c.closed_at,
         e.name AS owner_name, e.slug AS owner_slug, g.title AS goal_title
  FROM commitment c
  JOIN entity e ON e.id = c.owner_entity_id
  LEFT JOIN goal g ON g.id = c.linked_goal_id
`;

export function getCommitment(db: Db, id: number): CommitmentView | null {
  return db.prepare<[number], CommitmentView>(`${SELECT_COMMITMENT} WHERE c.id = ?`).get(id) ?? null;
}

export function listCommitments(
  db: Db,
  options: { includeClosed?: boolean; limit?: number } = {},
): CommitmentView[] {
  const closed = options.includeClosed ? "" : "WHERE c.status IN ('open','waiting')";
  return db
    .prepare<[number], CommitmentView>(
      `${SELECT_COMMITMENT} ${closed}
       ORDER BY c.status = 'open' DESC, c.due_at IS NULL, c.due_at, c.updated_at DESC
       LIMIT ?`,
    )
    .all(options.limit ?? 300);
}

export function createCommitment(db: Db, input: CommitmentInput): CommitmentView {
  const title = input.title.trim();
  if (!title) throw new Error("Refusing to create a commitment with an empty title");
  const ownerId = input.ownerEntityId ?? selfEntity(db).id;

  const duplicate = listCommitments(db, { limit: 500 }).find(
    (commitment) => foldAlias(commitment.title) === foldAlias(title),
  );
  if (duplicate) {
    const due = normalizeDate(input.dueAt);
    if (
      duplicate.source_message_id === input.sourceMessageId &&
      duplicate.owner_entity_id === ownerId &&
      duplicate.status === (input.status ?? "open") &&
      duplicate.due_at === due &&
      duplicate.linked_goal_id === (input.linkedGoalId ?? null)
      && duplicate.project_id === (input.projectId ?? null)
    ) {
      return duplicate;
    }
    return updateCommitment(db, duplicate.id, {
      linkedGoalId: input.linkedGoalId,
      projectId: input.projectId,
      status: input.status,
      dueAt: input.dueAt,
      confidence: input.confidence,
      sourceMessageId: input.sourceMessageId,
      sourceKind: input.sourceKind ?? "message",
    }) ?? duplicate;
  }

  const timestamp = now();
  const status = input.status ?? "open";
  const result = db.transaction(() => {
    const inserted = db
      .prepare<[
        string,
        number,
        number | null,
        number | null,
        CommitmentStatus,
        string | null,
        number,
        number,
        string,
        string,
        string | null,
      ]>(
        `INSERT INTO commitment
           (title, owner_entity_id, linked_goal_id, project_id, status, due_at, confidence,
            source_message_id, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        ownerId,
        input.linkedGoalId ?? null,
        input.projectId ?? null,
        status,
        normalizeDate(input.dueAt),
        clamp(input.confidence ?? 0.9),
        input.sourceMessageId,
        timestamp,
        timestamp,
        isCommitmentClosed(status) ? timestamp : null,
      );
    const id = Number(inserted.lastInsertRowid);
    insertCommitmentEvent(
      db,
      id,
      "created",
      null,
      status,
      {
        title,
        owner_entity_id: ownerId,
        linked_goal_id: input.linkedGoalId ?? null,
        project_id: input.projectId ?? null,
        due_at: normalizeDate(input.dueAt),
        confidence: clamp(input.confidence ?? 0.9),
      },
      input.sourceMessageId,
      input.sourceKind ?? "message",
      input.passageId ?? null,
    );
    return getCommitment(db, id);
  })();

  if (!result) throw new Error("Commitment vanished immediately after insert");
  return result;
}

export function updateCommitment(
  db: Db,
  id: number,
  update: CommitmentUpdate,
): CommitmentView | null {
  const existing = getCommitment(db, id);
  if (!existing) return null;
  const title = update.title?.trim() || existing.title;
  const status = update.status ?? existing.status;
  const dueAt = update.dueAt === undefined ? existing.due_at : normalizeDate(update.dueAt);
  const snoozed =
    update.snoozedUntil === undefined ? existing.snoozed_until : normalizeDate(update.snoozedUntil);
  const timestamp = now();
  const owner = update.ownerEntityId ?? existing.owner_entity_id;
  const linkedGoal =
    update.linkedGoalId === undefined ? existing.linked_goal_id : update.linkedGoalId;
  const projectId = update.projectId === undefined ? existing.project_id : update.projectId;
  const confidence =
    update.confidence === undefined ? existing.confidence : clamp(update.confidence);

  if (
    update.sourceMessageId &&
    title === existing.title &&
    owner === existing.owner_entity_id &&
    linkedGoal === existing.linked_goal_id &&
    projectId === existing.project_id &&
    status === existing.status &&
    dueAt === existing.due_at &&
    snoozed === existing.snoozed_until &&
    confidence === existing.confidence &&
    db
      .prepare<[number, number], { found: number }>(
        `SELECT 1 AS found FROM commitment_event
         WHERE commitment_id = ? AND source_message_id = ? LIMIT 1`,
      )
      .get(id, update.sourceMessageId)
  ) {
    return existing;
  }

  return db.transaction(() => {
    db.prepare<[
      string,
      number,
      number | null,
      number | null,
      CommitmentStatus,
      string | null,
      string | null,
      number,
      string,
      string | null,
      number,
    ]>(
      `UPDATE commitment
       SET title = ?, owner_entity_id = ?, linked_goal_id = ?, project_id = ?, status = ?,
           due_at = ?, snoozed_until = ?, confidence = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    ).run(
      title,
      owner,
      linkedGoal,
      projectId,
      status,
      dueAt,
      snoozed,
      confidence,
      timestamp,
      isCommitmentClosed(status) ? existing.closed_at ?? timestamp : null,
      id,
    );

    const eventType =
      status !== existing.status
        ? "status_changed"
        : update.snoozedUntil !== undefined
          ? "snoozed"
          : "updated";
    insertCommitmentEvent(
      db,
      id,
      eventType,
      existing.status,
      status,
      {
        before: {
          title: existing.title,
          owner_entity_id: existing.owner_entity_id,
          linked_goal_id: existing.linked_goal_id,
          project_id: existing.project_id,
          due_at: existing.due_at,
          snoozed_until: existing.snoozed_until,
          confidence: existing.confidence,
        },
        after: {
          title,
          owner_entity_id: owner,
          linked_goal_id: linkedGoal,
          project_id: projectId,
          due_at: dueAt,
          snoozed_until: snoozed,
          confidence,
        },
      },
      update.sourceMessageId ?? null,
      update.sourceKind ?? (update.sourceMessageId ? "message" : "user_action"),
      update.passageId ?? null,
    );
    return getCommitment(db, id);
  })();
}

export function commitmentEvents(db: Db, commitmentId: number): CommitmentEvent[] {
  return db
    .prepare<[number], CommitmentEvent>(
      `SELECT id, commitment_id, event_type, from_status, to_status, detail_json,
              source_message_id, passage_id, source_kind, created_at
       FROM commitment_event WHERE commitment_id = ? ORDER BY id`,
    )
    .all(commitmentId);
}

export function markCommitmentSurfaced(db: Db, id: number): void {
  const item = getCommitment(db, id);
  if (!item) return;
  const timestamp = now();
  db.transaction(() => {
    db.prepare<[string, number]>(
      "UPDATE commitment SET last_surfaced_at = ? WHERE id = ?",
    ).run(timestamp, id);
    insertCommitmentEvent(db, id, "surfaced", item.status, item.status, null, null, "system");
  })();
}

function insertCommitmentEvent(
  db: Db,
  commitmentId: number,
  eventType: CommitmentEvent["event_type"],
  fromStatus: CommitmentStatus | null,
  toStatus: CommitmentStatus | null,
  detail: unknown,
  sourceMessageId: number | null,
  sourceKind: CommitmentEvent["source_kind"],
  passageId: number | null = null,
): void {
  assertPassageMatchesSource(db, sourceMessageId, passageId);
  db.prepare<[
    number,
    CommitmentEvent["event_type"],
    CommitmentStatus | null,
    CommitmentStatus | null,
    string | null,
    number | null,
    number | null,
    CommitmentEvent["source_kind"],
    string,
  ]>(
    `INSERT INTO commitment_event
       (commitment_id, event_type, from_status, to_status, detail_json,
        source_message_id, passage_id, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    commitmentId,
    eventType,
    fromStatus,
    toStatus,
    detail === null ? null : JSON.stringify(detail),
    sourceMessageId,
    passageId,
    sourceKind,
    now(),
  );
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
    throw new Error(`Evidence passage ${passageId} does not match its intention source`);
  }
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0.01, Number.isFinite(value) ? value : 0.8));
}

function isGoalClosed(status: GoalStatus): boolean {
  return status === "achieved" || status === "abandoned";
}

function isCommitmentClosed(status: CommitmentStatus): boolean {
  return status === "done" || status === "cancelled";
}

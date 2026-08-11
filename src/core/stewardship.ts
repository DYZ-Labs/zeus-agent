import type { Db } from "./db";
import { now } from "./db";
import { selfEntity } from "./entities";
import {
  getCommitment,
  getGoal,
  listCommitments,
  listGoals,
  markCommitmentSurfaced,
  updateCommitment,
} from "./intentions";
import type {
  CommitmentView,
  FollowThroughActionKind,
  FollowThroughEvent,
  FollowThroughEventType,
  FollowThroughEventView,
  FollowThroughReason,
  FollowThroughRecommendation,
  FacetMachineEffect,
  Goal,
  StewardshipMode,
  StewardshipSetting,
} from "./schema";
import { FollowThroughRecommendation as FollowThroughRecommendationSchema } from "./schema";

const DAY = 24 * 60 * 60 * 1000;

export type RecommendationOptions = {
  referenceTime?: Date;
  /** A deliberate visit to Today may ask for the best open step even when no interruption is due. */
  force?: boolean;
  mode?: StewardshipMode;
};

export type FollowThroughMetrics = {
  surfaced: number;
  accepted: number;
  controlsExercised: number;
  progress: number;
  regrets: number;
  progressWithoutRegret: number;
};

export type FollowThroughDecision = Exclude<FollowThroughEventType, "surfaced">;

export function getStewardshipSetting(db: Db): StewardshipSetting {
  const setting = db
    .prepare<[], StewardshipSetting>(
      "SELECT id, mode, source_message_id, updated_at FROM stewardship_setting WHERE id = 1",
    )
    .get();
  if (!setting) throw new Error("Stewardship setting is missing");
  return setting;
}

export function setStewardshipMode(
  db: Db,
  mode: StewardshipMode,
  sourceMessageId: number | null = null,
): StewardshipSetting {
  if (sourceMessageId !== null) assertMessageRole(db, sourceMessageId, "user");
  db.prepare<[StewardshipMode, number | null, string]>(
    `UPDATE stewardship_setting
     SET mode = ?, source_message_id = ?, updated_at = ?
     WHERE id = 1`,
  ).run(mode, sourceMessageId, now());
  return getStewardshipSetting(db);
}

/**
 * Pick at most one useful next action. The thresholds are policy, not model judgment:
 * relevance, urgency, explicit priority, cooldowns, pauses, and user feedback remain
 * deterministic and inspectable.
 */
export function recommendNextAction(
  db: Db,
  query: string,
  options: RecommendationOptions = {},
): FollowThroughRecommendation | null {
  const referenceTime = options.referenceTime ?? new Date();
  const mode = options.mode ?? getStewardshipSetting(db).mode;
  const force = options.force ?? false;
  const commitments = listCommitments(db, { limit: 500 });
  const goals = new Map(
    listGoals(db, { includeClosed: true, limit: 500 }).map((goal) => [goal.id, goal]),
  );
  const terms = tokens(query);
  const me = selfEntity(db);
  const machineEffects = activeMachineEffects(db);

  const ranked = commitments.flatMap((commitment): FollowThroughRecommendation[] => {
    const goal = commitment.linked_goal_id === null ? null : goals.get(commitment.linked_goal_id) ?? null;
    if (goal && goal.status !== "active") return [];
    if (isSnoozed(commitment, referenceTime) || isDismissedWithoutChange(db, commitment)) return [];
    if (!force && isCoolingDown(commitment, mode, referenceTime)) return [];
    const policy = machineEffectFor(machineEffects, commitment, goal, query);
    if (policy.blocked) return [];

    const recommendation = scoreRecommendation({
      commitment,
      goal,
      allCommitments: commitments,
      terms,
      query,
      mode,
      force,
      referenceTime,
      selfEntityId: me.id,
      machineEffectDelta: policy.scoreDelta,
    });
    return recommendation ? [recommendation] : [];
  });

  return ranked.sort(
    (a, b) => b.score - a.score || a.commitment_id - b.commitment_id,
  )[0] ?? null;
}

/** Rebuild a recommendation for an explicit user action on a known commitment. */
export function recommendationForCommitment(
  db: Db,
  commitmentId: number,
  query = "",
  referenceTime: Date = new Date(),
): FollowThroughRecommendation | null {
  const commitment = getCommitment(db, commitmentId);
  if (!commitment) return null;
  const goal = commitment.linked_goal_id === null ? null : getGoal(db, commitment.linked_goal_id);
  const policy = machineEffectFor(activeMachineEffects(db), commitment, goal, query);
  if (policy.blocked) return null;
  return scoreRecommendation({
    commitment,
    goal,
    allCommitments: listCommitments(db, { includeClosed: true, limit: 500 }),
    terms: tokens(query),
    query,
    mode: getStewardshipSetting(db).mode,
    force: true,
    referenceTime,
    selfEntityId: selfEntity(db).id,
    machineEffectDelta: policy.scoreDelta,
  });
}

export function markRecommendationSurfaced(
  db: Db,
  recommendation: FollowThroughRecommendation,
  responseMessageId: number | null,
): FollowThroughEvent {
  if (responseMessageId !== null) assertMessageRole(db, responseMessageId, "assistant");
  return db.transaction(() => {
    markCommitmentSurfaced(db, recommendation.commitment_id);
    return insertEvent(db, {
      recommendation,
      eventType: "surfaced",
      responseMessageId,
      sourceMessageId: null,
      sourceKind: "system",
    });
  })();
}

export function recordFollowThroughDecision(
  db: Db,
  input: {
    commitmentId: number;
    decision: FollowThroughDecision;
    responseMessageId?: number | null;
    sourceMessageId?: number | null;
    snoozedUntil?: string | null;
    /** Optional verbatim user-authored rationale. Silence and clicks never create one. */
    userReason?: string | null;
  },
): FollowThroughEvent | null {
  if (input.sourceMessageId) {
    assertMessageRole(db, input.sourceMessageId, "user");
  }
  const commitment = getCommitment(db, input.commitmentId);
  if (!commitment) return null;
  const recommendation =
    latestRecommendationSnapshot(db, input.commitmentId) ??
    recommendationForCommitment(db, input.commitmentId);
  if (!recommendation) return null;
  const responseMessageId = validatedRecommendationResponse(
    db,
    input.commitmentId,
    input.responseMessageId ?? null,
  );
  const decisionSourceKind = sourceKindForUserMessage(
    db,
    input.sourceMessageId ?? null,
  );

  return db.transaction(() => {
    let snoozedUntil: string | null = null;
    if (input.decision === "snoozed") {
      snoozedUntil = normalizeFutureDate(input.snoozedUntil) ??
        new Date(Date.now() + 7 * DAY).toISOString();
      updateCommitment(db, input.commitmentId, {
        snoozedUntil,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceKind: decisionSourceKind,
      });
    } else if (input.decision === "completed" && commitment.status !== "done") {
      updateCommitment(db, input.commitmentId, {
        status: "done",
        sourceMessageId: input.sourceMessageId ?? null,
        sourceKind: decisionSourceKind,
      });
    }

    const userReason = normalizeUserReason(input.userReason);
    return insertEvent(db, {
      recommendation,
      eventType: input.decision,
      responseMessageId,
      sourceMessageId: input.sourceMessageId ?? null,
      sourceKind: decisionSourceKind,
      extraDetail:
        snoozedUntil || userReason
          ? {
              ...(snoozedUntil ? { snoozed_until: snoozedUntil } : {}),
              ...(userReason ? { user_reason: userReason } : {}),
            }
          : null,
    });
  })();
}

function sourceKindForUserMessage(
  db: Db,
  sourceMessageId: number | null,
): "message" | "user_action" {
  if (sourceMessageId === null) return "user_action";
  const origin = db
    .prepare<[number], { origin: string }>("SELECT origin FROM message WHERE id = ?")
    .get(sourceMessageId)?.origin;
  return origin === "user_action" ? "user_action" : "message";
}

function validatedRecommendationResponse(
  db: Db,
  commitmentId: number,
  responseMessageId: number | null,
): number | null {
  if (responseMessageId === null) return null;
  const found = db
    .prepare<[number, number], { found: number }>(
      `SELECT 1 AS found FROM follow_through_event
       WHERE commitment_id = ? AND response_message_id = ? AND event_type = 'surfaced'
       LIMIT 1`,
    )
    .get(commitmentId, responseMessageId);
  return found ? responseMessageId : null;
}

export function listFollowThroughEvents(db: Db, limit = 100): FollowThroughEventView[] {
  return db
    .prepare<[number], FollowThroughEventView>(
      `SELECT e.id, e.commitment_id, e.goal_id, e.event_type, e.reason,
              e.action_kind, e.detail_json, e.response_message_id,
              e.source_message_id, e.source_kind, e.created_at,
              c.title AS commitment_title, g.title AS goal_title
       FROM follow_through_event e
       JOIN commitment c ON c.id = e.commitment_id
       LEFT JOIN goal g ON g.id = e.goal_id
       ORDER BY e.id DESC
       LIMIT ?`,
    )
    .all(limit);
}

export function recommendationsForResponse(
  db: Db,
  responseMessageId: number,
): FollowThroughRecommendation[] {
  const rows = db
    .prepare<[number], { detail_json: string | null }>(
      `SELECT detail_json FROM follow_through_event
       WHERE response_message_id = ? AND event_type = 'surfaced'
       ORDER BY id`,
    )
    .all(responseMessageId);
  return rows.flatMap((row) => parseRecommendation(row.detail_json));
}

export function followThroughMetrics(db: Db): FollowThroughMetrics {
  const counts = db
    .prepare<[], { event_type: FollowThroughEventType; count: number }>(
      `SELECT event_type, COUNT(*) AS count
       FROM follow_through_event
       GROUP BY event_type`,
    )
    .all();
  const byType = new Map(counts.map((row) => [row.event_type, row.count]));
  const progress = db
    .prepare<[], { count: number }>(
      `SELECT COUNT(DISTINCT commitment_id) AS count
       FROM follow_through_event WHERE event_type = 'completed'`,
    )
    .get()?.count ?? 0;
  const progressWithoutRegret = db
    .prepare<[], { count: number }>(
      `SELECT COUNT(DISTINCT completed.commitment_id) AS count
       FROM follow_through_event completed
       WHERE completed.event_type = 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM follow_through_event regretted
           WHERE regretted.commitment_id = completed.commitment_id
             AND regretted.event_type = 'regretted'
             AND regretted.id > completed.id
         )`,
    )
    .get()?.count ?? 0;

  return {
    surfaced: byType.get("surfaced") ?? 0,
    accepted: byType.get("accepted") ?? 0,
    controlsExercised: (byType.get("dismissed") ?? 0) + (byType.get("snoozed") ?? 0),
    progress,
    regrets: byType.get("regretted") ?? 0,
    progressWithoutRegret,
  };
}

type ActiveMachineEffect = {
  machine_effect: FacetMachineEffect;
  scope_kind: "global" | "domain" | "entity" | "goal" | "commitment";
  scope_label: string | null;
  scope_entity_id: number | null;
  scope_goal_id: number | null;
  scope_commitment_id: number | null;
};

function activeMachineEffects(db: Db): ActiveMachineEffect[] {
  return db
    .prepare<[], ActiveMachineEffect>(
      `SELECT machine_effect, scope_kind, scope_label, scope_entity_id,
              scope_goal_id, scope_commitment_id
       FROM understanding_facet
       WHERE valid_to IS NULL AND machine_effect IS NOT NULL
       ORDER BY id`,
    )
    .all();
}

function machineEffectFor(
  effects: readonly ActiveMachineEffect[],
  commitment: CommitmentView,
  goal: Goal | null,
  query: string,
): { blocked: boolean; scoreDelta: number } {
  const targetTerms = tokens(
    `${query} ${commitment.title} ${goal?.title ?? ""}`,
  );
  let scoreDelta = 0;
  for (const effect of effects) {
    const applies =
      effect.scope_kind === "global" ||
      (effect.scope_kind === "commitment" &&
        effect.scope_commitment_id === commitment.id) ||
      (effect.scope_kind === "goal" && effect.scope_goal_id === goal?.id) ||
      (effect.scope_kind === "entity" &&
        effect.scope_entity_id === commitment.owner_entity_id) ||
      (effect.scope_kind === "domain" &&
        [...tokens(effect.scope_label ?? "")].some((term) => targetTerms.has(term)));
    if (!applies) continue;
    if (effect.machine_effect === "block") return { blocked: true, scoreDelta: 0 };
    scoreDelta += effect.machine_effect === "boost" ? 40 : -40;
  }
  return { blocked: false, scoreDelta: Math.max(-80, Math.min(80, scoreDelta)) };
}

type ScoreInput = {
  commitment: CommitmentView;
  goal: Goal | null;
  allCommitments: readonly CommitmentView[];
  terms: Set<string>;
  query: string;
  mode: StewardshipMode;
  force: boolean;
  referenceTime: Date;
  selfEntityId: number;
  machineEffectDelta: number;
};

function scoreRecommendation(input: ScoreInput): FollowThroughRecommendation | null {
  const { commitment, goal, referenceTime } = input;
  if (commitment.status !== "open" && commitment.status !== "waiting") return null;

  const reference = referenceTime.getTime();
  const commitmentDue = parseDate(commitment.due_at);
  const goalDue = parseDate(goal?.target_at ?? null);
  const effectiveDue = commitmentDue ?? goalDue;
  const daysToDue = effectiveDue === null ? null : (effectiveDue - reference) / DAY;
  const overdue = daysToDue !== null && daysToDue < 0;
  const dueWindow = input.mode === "proactive" ? 14 : input.mode === "balanced" ? 7 : 2;
  const dueSoon = daysToDue !== null && daysToDue >= 0 && daysToDue <= dueWindow;
  const ageDays = Math.max(0, (reference - Date.parse(commitment.updated_at)) / DAY);
  const waiting = commitment.status === "waiting";
  const staleThreshold = input.mode === "proactive" ? 14 : input.mode === "balanced" ? 30 : 60;
  const stale = ageDays >= staleThreshold;
  const overlap = overlapCount(input.terms, `${commitment.title} ${goal?.title ?? ""}`);
  if (overlap > 0 && queryClosesOrDefers(input.query)) return null;
  const conflictCount = effectiveDue === null
    ? 0
    : input.allCommitments.filter((other) => {
        if (other.id === commitment.id || (other.status !== "open" && other.status !== "waiting")) {
          return false;
        }
        const otherDue = parseDate(other.due_at);
        return otherDue !== null && Math.abs(otherDue - effectiveDue) <= 36 * 60 * 60 * 1000;
      }).length;
  const conflict = conflictCount > 0;

  const severelyOverdue = daysToDue !== null && daysToDue <= -3;
  const eligible = input.force ||
    (input.mode === "quiet"
      ? overlap > 0 || severelyOverdue
      : overlap > 0 || overdue || dueSoon || conflict || stale || (waiting && ageDays >= 14));
  if (!eligible) return null;

  const priority = goal?.priority ?? null;
  let score = priority === "high" ? 25 : priority === "low" ? -10 : 10;
  // The user's current focus is usually a better moment than an unrelated backlog
  // alarm. One meaningful lexical match must be able to outrank even an old overdue
  // item; urgency wins again when both candidates are relevant.
  score += overlap * 150;
  if (overdue) score += 100 + Math.min(30, Math.abs(daysToDue ?? 0));
  else if (dueSoon) score += 55 - Math.max(0, daysToDue ?? 0);
  if (waiting && ageDays >= 7) score += 35;
  if (stale) score += 20 + Math.min(20, ageDays - staleThreshold);
  if (conflict) score += 20 + conflictCount * 5;
  if (commitment.owner_entity_id === input.selfEntityId) score += 5;
  score += input.machineEffectDelta;

  const reason: FollowThroughReason = overdue
    ? "overdue"
    : dueSoon
      ? "due_soon"
      : waiting && ageDays >= 7
        ? "waiting"
        : conflict
          ? "conflict"
          : overlap > 0
            ? "relevant"
            : stale
              ? "stale"
              : "priority";
  const actionKind = actionKindFor(commitment);
  const why = rationale({
    commitment,
    goal,
    reason,
    overlap,
    conflictCount,
    ageDays,
    daysToDue,
    usedGoalDate: commitmentDue === null && goalDue !== null,
  });
  const suggestedAction = actionFor(actionKind, commitment.title);
  const requiresConfirmation = ["draft", "schedule", "remind", "coordinate"].includes(
    actionKind,
  );
  const chatPrompt = [
    `Help me follow through on “${commitment.title}”.`,
    suggestedAction,
    goal ? `Keep my goal “${goal.title}” in view.` : null,
    "Use only my accepted memory as personal context. Draft, research, or plan now, but do not send, schedule, purchase, or change anything externally without asking me first.",
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return FollowThroughRecommendationSchema.parse({
    commitment_id: commitment.id,
    commitment_title: commitment.title,
    commitment_source_message_id: commitment.source_message_id,
    goal_id: goal?.id ?? null,
    goal_title: goal?.title ?? null,
    goal_priority: priority,
    due_at: commitment.due_at,
    reason,
    action_kind: actionKind,
    why,
    suggested_action: suggestedAction,
    chat_prompt: chatPrompt,
    requires_confirmation: requiresConfirmation,
    score,
  });
}

function rationale(input: {
  commitment: CommitmentView;
  goal: Goal | null;
  reason: FollowThroughReason;
  overlap: number;
  conflictCount: number;
  ageDays: number;
  daysToDue: number | null;
  usedGoalDate: boolean;
}): string {
  const parts: string[] = [];
  if (input.goal) {
    parts.push(
      input.goal.priority === "high"
        ? `It advances your high-priority goal “${input.goal.title}”.`
        : `It advances your goal “${input.goal.title}”.`,
    );
  }
  if (input.reason === "overdue") {
    const days = Math.max(1, Math.ceil(Math.abs(input.daysToDue ?? 0)));
    parts.push(
      input.usedGoalDate
        ? `That goal's target passed ${days} day${days === 1 ? "" : "s"} ago.`
        : `You said this was due ${days} day${days === 1 ? "" : "s"} ago.`,
    );
  } else if (input.reason === "due_soon") {
    const days = Math.max(0, Math.ceil(input.daysToDue ?? 0));
    parts.push(
      `${input.usedGoalDate ? "The goal's target" : "Its due date"} is ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}.`,
    );
  } else if (input.reason === "waiting") {
    parts.push(`It has been waiting for ${Math.max(1, Math.floor(input.ageDays))} days.`);
  } else if (input.reason === "stale") {
    parts.push(`It has stayed open for ${Math.max(1, Math.floor(input.ageDays))} days without an update.`);
  } else if (input.reason === "relevant" && input.overlap > 0) {
    parts.push("It directly matches what you are discussing now.");
  }
  if (input.conflictCount > 0) {
    parts.push(
      `It shares a deadline window with ${input.conflictCount} other open item${input.conflictCount === 1 ? "" : "s"}, so choosing deliberately may prevent a collision.`,
    );
  }
  if (parts.length === 0) parts.push("It is the strongest current next step among your open commitments.");
  return parts.join(" ");
}

function actionKindFor(commitment: CommitmentView): FollowThroughActionKind {
  const title = commitment.title.toLowerCase();
  if (commitment.status === "waiting" || commitment.owner_slug !== "self") return "coordinate";
  if (/\b(draft|email|message|reply|send|write)\b/u.test(title)) return "draft";
  if (/\b(book|calendar|call|meet|schedule|appointment)\b/u.test(title)) return "schedule";
  if (/\b(compare|find|investigate|research|shortlist)\b/u.test(title)) return "research";
  if (/\b(remind|reminder)\b/u.test(title)) return "remind";
  if (/\b(ask|check with|coordinate|follow up|follow-up)\b/u.test(title)) return "coordinate";
  return "plan";
}

function actionFor(kind: FollowThroughActionKind, title: string): string {
  if (kind === "draft") return `Prepare a draft for “${title}” and review it before anything is sent.`;
  if (kind === "schedule") return `Find a workable time for “${title}” and confirm before changing any calendar.`;
  if (kind === "research") return `Research “${title}” and return a short, decision-ready shortlist.`;
  if (kind === "remind") return `Choose when “${title}” should resurface and confirm before setting a reminder.`;
  if (kind === "coordinate") return `Prepare the follow-up for “${title}” and confirm the recipient and channel before sending.`;
  return `Turn “${title}” into the smallest concrete step you can finish now.`;
}

function insertEvent(
  db: Db,
  input: {
    recommendation: FollowThroughRecommendation;
    eventType: FollowThroughEventType;
    responseMessageId: number | null;
    sourceMessageId: number | null;
    sourceKind: FollowThroughEvent["source_kind"];
    extraDetail?: unknown;
  },
): FollowThroughEvent {
  const detail = {
    recommendation: input.recommendation,
    ...(input.extraDetail === null || input.extraDetail === undefined
      ? {}
      : { decision: input.extraDetail }),
  };
  const inserted = db
    .prepare<[
      number,
      number | null,
      FollowThroughEventType,
      FollowThroughReason,
      FollowThroughActionKind,
      string,
      number | null,
      number | null,
      FollowThroughEvent["source_kind"],
      string,
    ]>(
      `INSERT INTO follow_through_event
         (commitment_id, goal_id, event_type, reason, action_kind, detail_json,
          response_message_id, source_message_id, source_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.recommendation.commitment_id,
      input.recommendation.goal_id,
      input.eventType,
      input.recommendation.reason,
      input.recommendation.action_kind,
      JSON.stringify(detail),
      input.responseMessageId,
      input.sourceMessageId,
      input.sourceKind,
      now(),
    );
  const event = db
    .prepare<[number], FollowThroughEvent>(
      `SELECT id, commitment_id, goal_id, event_type, reason, action_kind,
              detail_json, response_message_id, source_message_id, source_kind, created_at
       FROM follow_through_event WHERE id = ?`,
    )
    .get(Number(inserted.lastInsertRowid));
  if (!event) throw new Error("Follow-through event vanished immediately after insert");
  return event;
}

function latestRecommendationSnapshot(
  db: Db,
  commitmentId: number,
): FollowThroughRecommendation | null {
  const row = db
    .prepare<[number], { detail_json: string | null }>(
      `SELECT detail_json FROM follow_through_event
       WHERE commitment_id = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(commitmentId);
  return parseRecommendation(row?.detail_json ?? null)[0] ?? null;
}

function parseRecommendation(detailJson: string | null): FollowThroughRecommendation[] {
  if (!detailJson) return [];
  try {
    const detail = JSON.parse(detailJson) as { recommendation?: unknown };
    const parsed = FollowThroughRecommendationSchema.safeParse(detail.recommendation);
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}

function isSnoozed(commitment: CommitmentView, referenceTime: Date): boolean {
  return Boolean(
    commitment.snoozed_until && Date.parse(commitment.snoozed_until) > referenceTime.getTime(),
  );
}

function isCoolingDown(
  commitment: CommitmentView,
  mode: StewardshipMode,
  referenceTime: Date,
): boolean {
  if (!commitment.last_surfaced_at) return false;
  const cooldownDays = mode === "quiet" ? 14 : mode === "proactive" ? 3 : 7;
  return Date.parse(commitment.last_surfaced_at) > referenceTime.getTime() - cooldownDays * DAY;
}

function isDismissedWithoutChange(db: Db, commitment: CommitmentView): boolean {
  const last = db
    .prepare<
      [number],
      { event_type: "accepted" | "dismissed" | "regretted"; created_at: string }
    >(
      `SELECT event_type, created_at FROM follow_through_event
       WHERE commitment_id = ? AND event_type IN ('accepted','dismissed','regretted')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(commitment.id);
  return Boolean(
    last &&
      (last.event_type === "dismissed" || last.event_type === "regretted") &&
      last.created_at >= commitment.updated_at,
  );
}

function overlapCount(queryTerms: Set<string>, value: string): number {
  let overlap = 0;
  for (const term of tokens(value)) if (queryTerms.has(term)) overlap += 1;
  return overlap;
}

function tokens(value: string): Set<string> {
  const stopwords = new Set([
    "about",
    "and",
    "for",
    "from",
    "have",
    "into",
    "need",
    "that",
    "the",
    "this",
    "what",
    "when",
    "where",
    "with",
    "your",
  ]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/u)
      .filter((term) => term.length > 2 && !stopwords.has(term)),
  );
}

function queryClosesOrDefers(query: string): boolean {
  return /\b(?:i|we)\s+(?:already\s+|just\s+)?(?:cancelled|canceled|completed|did|finished|paused)\b|\b(?:already done|is done|not now|stop (?:nudging|reminding)|snooze (?:it|that|this))\b/iu.test(
    query,
  );
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFutureDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now() ? new Date(parsed).toISOString() : null;
}

function normalizeUserReason(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim().slice(0, 500) ?? "";
  return normalized || null;
}

function assertMessageRole(db: Db, messageId: number, role: "user" | "assistant"): void {
  const source = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(messageId);
  if (source?.role !== role) {
    throw new Error(`Follow-through ${role} source must be a stored ${role} message`);
  }
}

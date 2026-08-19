import type { Db } from "./db";
import { now } from "./db";
import { getSignal, listOpenSignals } from "./detectors";
import { selfEntity } from "./entities";
import {
  getCommitment,
  getGoal,
  listCommitments,
  listGoals,
  markCommitmentSurfaced,
  updateCommitment,
} from "./intentions";
import { materializeBehavioralPolicySuggestions } from "./personalization";
import type {
  CommitmentView,
  DetectedSignal,
  DetectorKind,
  EffectKind,
  EvaluationContext,
  FollowThroughActionKind,
  FollowThroughEvent,
  FollowThroughEventType,
  FollowThroughEventView,
  FollowThroughReason,
  FollowThroughRecommendation,
  FacetMachineEffect,
  Goal,
  OpportunityDelivery,
  OpportunityDeliveryChannel,
  RecommendationCycle,
  StewardshipMode,
  StewardshipSetting,
  StructuredFacetCondition,
  TriggerKind,
  Weekday,
} from "./schema";
import {
  EvaluationContext as EvaluationContextSchema,
  FollowThroughRecommendation as FollowThroughRecommendationSchema,
  StructuredFacetCondition as StructuredFacetConditionSchema,
} from "./schema";

const DAY = 24 * 60 * 60 * 1000;
const LOCATION_FRESHNESS = 30 * 60 * 1000;
/** How soon a detected conflict has to be before it outranks a routine nudge. */
const IMMINENT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const STEWARDSHIP_POLICY_VERSION = "2";

/**
 * What a detector noticed, selected for delivery.
 *
 * Deliberately its own type rather than a variant of `FollowThroughRecommendation`: a
 * conflict Zeus observed in the world is a different kind of claim from a commitment the
 * user made, and only the latter should feed the behavioral-policy machinery.
 */
export type SignalAlert = {
  signal_id: number;
  detector: DetectorKind;
  commitment_id: number | null;
  why: string;
  suggested_action: string;
  effect_kind: EffectKind;
  requires_confirmation: boolean;
  chat_prompt: string;
  score: number;
};

type ActiveStewardshipMode = Exclude<StewardshipMode, "off">;

export type RecommendationOptions = {
  mode?: StewardshipMode;
  trigger?: TriggerKind;
  context?: EvaluationContext;
};

export type EvaluationContextInput = {
  trigger: TriggerKind;
  referenceTime?: Date;
  timezone?: string;
  locationZone?: string | null;
  locationObservedAt?: string | null;
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

/** Build a self-consistent temporal context. Local fields are derived from the instant
 * and IANA timezone so policy traces do not depend on the caller's locale settings. */
export function createEvaluationContext(input: EvaluationContextInput): EvaluationContext {
  const referenceTime = input.referenceTime ?? new Date();
  if (!Number.isFinite(referenceTime.getTime())) {
    throw new Error("Evaluation context requires a valid reference time");
  }
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const local = localParts(referenceTime, timezone);
  return EvaluationContextSchema.parse({
    trigger: input.trigger,
    evaluated_at: referenceTime.toISOString(),
    timezone,
    local_weekday: local.weekday,
    local_time: local.time,
    daypart: daypartFor(local.time),
    location_zone: normalizeZone(input.locationZone),
    location_observed_at: input.locationObservedAt ?? null,
  });
}

/** Validate an externally supplied context and recalculate its derived local fields. */
export function normalizeEvaluationContext(context: EvaluationContext): EvaluationContext {
  const parsed = EvaluationContextSchema.parse(context);
  return createEvaluationContext({
    trigger: parsed.trigger,
    referenceTime: new Date(parsed.evaluated_at),
    timezone: parsed.timezone,
    locationZone: parsed.location_zone,
    locationObservedAt: parsed.location_observed_at,
  });
}

function contextForOptions(options: RecommendationOptions): EvaluationContext {
  if (options.context) return normalizeEvaluationContext(options.context);
  return createEvaluationContext({
    trigger: options.trigger ?? "chat",
  });
}

/**
 * Did the user ask for follow-through, or is Zeus about to volunteer it?
 *
 * Exported because mode `off` is now the default, and a caller that wants to skip the
 * evaluation entirely has to answer the same question this module answers internally.
 * Two copies of the rule would drift, and the drift would be silent in the direction that
 * matters: an ordinary turn quietly regaining the interruption.
 */
export function isExplicitTrigger(
  trigger: TriggerKind,
  query: string,
): boolean {
  if (trigger === "today" || trigger === "mcp") return true;
  if (trigger === "worker") return false;
  return explicitFollowThroughRequest(query);
}

function explicitFollowThroughRequest(query: string): boolean {
  return /\b(?:what (?:should|can) i (?:do|work on|focus on)|what(?:'s| is) (?:my )?next (?:step|action)|what next|next action|help me (?:prioriti[sz]e|choose|decide|focus|follow through)|show me (?:my )?(?:priorities|commitments|to[ -]?dos?))\b/iu.test(
    query,
  );
}

function localParts(referenceTime: Date, timezone: string): { weekday: Weekday; time: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(referenceTime);
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
  const weekdayPart = parts.find((part) => part.type === "weekday")?.value.toLowerCase();
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const weekday = weekdayPart && isWeekday(weekdayPart) ? weekdayPart : null;
  if (!weekday || !hour || !minute) {
    throw new Error(`Could not derive local time for timezone: ${timezone}`);
  }
  return { weekday, time: `${hour}:${minute}` };
}

function isWeekday(value: string): value is Weekday {
  return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(value);
}

function daypartFor(localTime: string): EvaluationContext["daypart"] {
  const hour = Number(localTime.slice(0, 2));
  if (hour < 5) return "overnight";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function normalizeZone(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim().toLowerCase() ?? "";
  return normalized || null;
}

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
  return evaluateRecommendations(db, query, options).recommendation;
}

type CandidateScoreTrace = {
  commitment_id: number;
  score: number;
  applied_facet_ids: number[];
};

type CandidateExclusionTrace = {
  commitment_id: number;
  reason:
    | "off"
    | "paused_goal"
    | "snoozed"
    | "dismissed"
    | "cooldown"
    | "facet_blocked"
    | "closed"
    | "query_closes_or_defers"
    | "not_eligible";
  applied_facet_ids?: number[];
};

type FacetConditionExclusionTrace = {
  facet_id: number;
  reason: "legacy_condition" | "invalid_condition" | "condition_not_met";
};

type RecommendationExclusionTrace =
  | CandidateExclusionTrace
  | FacetConditionExclusionTrace;

type RecommendationEvaluation = {
  context: EvaluationContext;
  mode: StewardshipMode;
  recommendation: FollowThroughRecommendation | null;
  candidateScores: CandidateScoreTrace[];
  exclusions: RecommendationExclusionTrace[];
  appliedFacetIds: number[];
};

function evaluateRecommendations(
  db: Db,
  query: string,
  options: RecommendationOptions = {},
): RecommendationEvaluation {
  const context = contextForOptions(options);
  const referenceTime = new Date(context.evaluated_at);
  const mode = options.mode ?? getStewardshipSetting(db).mode;
  const explicitlyRequested = isExplicitTrigger(context.trigger, query);
  const commitments = listCommitments(db, { limit: 500 });
  const goals = new Map(
    listGoals(db, { includeClosed: true, limit: 500 }).map((goal) => [goal.id, goal]),
  );
  const terms = tokens(query);
  const me = selfEntity(db);
  const machineEffectSelection = activeMachineEffects(db, context);
  const machineEffects = machineEffectSelection.active;
  const candidateScores: CandidateScoreTrace[] = [];
  const exclusions: RecommendationExclusionTrace[] = [
    ...machineEffectSelection.exclusions,
  ];
  const ranked: Array<{
    recommendation: FollowThroughRecommendation;
    appliedFacetIds: number[];
  }> = [];

  if (mode === "off" && !explicitlyRequested) {
    for (const commitment of commitments) {
      exclusions.push({ commitment_id: commitment.id, reason: "off" });
    }
    return {
      context,
      mode,
      recommendation: null,
      candidateScores,
      exclusions,
      appliedFacetIds: [],
    };
  }

  const scoringMode: ActiveStewardshipMode = mode === "off" ? "balanced" : mode;
  for (const commitment of commitments) {
    const goal = commitment.linked_goal_id === null ? null : goals.get(commitment.linked_goal_id) ?? null;
    if (goal && goal.status !== "active") {
      exclusions.push({ commitment_id: commitment.id, reason: "paused_goal" });
      continue;
    }
    if (isSnoozed(commitment, referenceTime)) {
      exclusions.push({ commitment_id: commitment.id, reason: "snoozed" });
      continue;
    }
    if (isDismissedWithoutChange(db, commitment)) {
      exclusions.push({ commitment_id: commitment.id, reason: "dismissed" });
      continue;
    }
    if (!explicitlyRequested && isCoolingDown(commitment, scoringMode, referenceTime)) {
      exclusions.push({ commitment_id: commitment.id, reason: "cooldown" });
      continue;
    }
    const policy = machineEffectFor(machineEffects, commitment, goal, query);
    if (policy.blocked) {
      exclusions.push({
        commitment_id: commitment.id,
        reason: "facet_blocked",
        applied_facet_ids: policy.appliedFacetIds,
      });
      continue;
    }

    const recommendation = scoreRecommendation({
      commitment,
      goal,
      allCommitments: commitments,
      terms,
      query,
      mode: scoringMode,
      explicitlyRequested,
      referenceTime,
      selfEntityId: me.id,
      machineEffectDelta: policy.scoreDelta,
    });
    if (!recommendation) {
      exclusions.push({
        commitment_id: commitment.id,
        reason:
          overlapCount(terms, `${commitment.title} ${goal?.title ?? ""}`) > 0 &&
          queryClosesOrDefers(query)
            ? "query_closes_or_defers"
            : commitment.status !== "open" && commitment.status !== "waiting"
              ? "closed"
              : "not_eligible",
      });
      continue;
    }
    candidateScores.push({
      commitment_id: commitment.id,
      score: recommendation.score,
      applied_facet_ids: policy.appliedFacetIds,
    });
    ranked.push({ recommendation, appliedFacetIds: policy.appliedFacetIds });
  }

  ranked.sort(
    (a, b) =>
      b.recommendation.score - a.recommendation.score ||
      a.recommendation.commitment_id - b.recommendation.commitment_id,
  );
  candidateScores.sort((a, b) => b.score - a.score || a.commitment_id - b.commitment_id);
  const selected = ranked[0] ?? null;
  return {
    context,
    mode,
    recommendation: selected?.recommendation ?? null,
    candidateScores,
    exclusions,
    appliedFacetIds: selected?.appliedFacetIds ?? [],
  };
}

/** Evaluate and persist a complete deterministic trace. The returned cycle id is the
 * durable opportunity id shared by every eventual delivery channel. */
export function evaluateOpportunity(
  db: Db,
  context: EvaluationContext,
  query = "",
  options: { mode?: StewardshipMode; sourceMessageId?: number | null } = {},
): RecommendationCycle {
  const sourceMessageId = options.sourceMessageId ?? null;
  if (sourceMessageId !== null) assertMessageRole(db, sourceMessageId, "user");
  const evaluation = evaluateRecommendations(db, query, {
    context,
    mode: options.mode,
  });
  const signal = selectSignalAlert(db, evaluation, query);
  const createdAt = now();
  const inserted = db
    .prepare<[
      string,
      TriggerKind,
      string,
      string,
      string,
      string,
      string,
      number | null,
      number | null,
      string | null,
      number | null,
      string,
    ]>(
      `INSERT INTO recommendation_cycle
         (policy_version, trigger, context_json, query_text, candidate_scores_json,
          applied_facet_ids_json, exclusions_json, selected_commitment_id,
          selected_signal_id, recommendation_json, source_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      STEWARDSHIP_POLICY_VERSION,
      evaluation.context.trigger,
      JSON.stringify({
        ...evaluation.context,
        stewardship_mode: evaluation.mode,
        explicitly_requested: isExplicitTrigger(
          evaluation.context.trigger,
          query,
        ),
      }),
      query,
      JSON.stringify(evaluation.candidateScores),
      JSON.stringify(evaluation.appliedFacetIds),
      JSON.stringify(evaluation.exclusions),
      signal ? null : evaluation.recommendation?.commitment_id ?? null,
      signal?.signal_id ?? null,
      signal
        ? JSON.stringify(signal)
        : evaluation.recommendation
          ? JSON.stringify(evaluation.recommendation)
          : null,
      sourceMessageId,
      createdAt,
    );
  return getRecommendationCycle(db, Number(inserted.lastInsertRowid))!;
}

/**
 * Pick a detected signal over a commitment nudge, or neither.
 *
 * The rule is one sentence: an imminent conflict in the world outranks a routine nudge,
 * and otherwise the commitment wins. A signal never displaces an *explicitly requested*
 * recommendation — "what should I do?" is a question about the user's own intentions.
 *
 * Every existing gate applies here, unchanged: intervention mode, snooze, dismissal,
 * cooldown, and accepted facets that block. Detector output does not get its own way in.
 */
function selectSignalAlert(
  db: Db,
  evaluation: RecommendationEvaluation,
  query: string,
): SignalAlert | null {
  if (evaluation.mode === "off") return null;
  if (isExplicitTrigger(evaluation.context.trigger, query)) return null;

  const referenceTime = new Date(evaluation.context.evaluated_at);
  const scoringMode: ActiveStewardshipMode = evaluation.mode;
  const machineEffects = activeMachineEffects(db, evaluation.context).active;

  let best: SignalAlert | null = null;
  for (const signal of listOpenSignals(db, { at: referenceTime })) {
    if (signalIsDismissedWithoutChange(db, signal)) continue;
    if (signalIsCoolingDown(signal, scoringMode, referenceTime)) continue;
    if (signalIsBlockedByFacet(machineEffects, signal)) continue;

    const imminent =
      signal.occurs_at !== null &&
      Date.parse(signal.occurs_at) - referenceTime.getTime() < IMMINENT_WINDOW_MS;
    if (evaluation.recommendation && !imminent) continue;

    const score = signal.severity + (imminent ? 40 : 0);
    if (best && best.score >= score) continue;
    best = {
      signal_id: signal.id,
      detector: signal.detector,
      commitment_id: signal.commitment_id,
      why: signal.why,
      suggested_action: signal.suggested_action,
      effect_kind: signal.effect_kind,
      requires_confirmation: requiresEffectConfirmation(signal.effect_kind),
      chat_prompt: signalChatPrompt(signal),
      score,
    };
  }
  return best;
}

/**
 * What "help me fix this" should actually say once it lands in chat.
 *
 * A detector's `suggested_action` is written to be read on a card — "Decide which of X and
 * Y to move." It describes the problem to a person. Sent into chat as a prompt it describes
 * nothing to the router, which is looking for a request, so the turn that was supposed to
 * fix the clash became ordinary conversation about it.
 *
 * These phrase the same finding as the request the user is making by clicking. The `why`
 * rides along because it already names both events and their times, which is the context
 * the calendar path needs to resolve a target. The confirmation sentence stays on every
 * variant: the button is a request for help, never a standing permission to act.
 */
export function signalChatPrompt(
  signal: Pick<DetectedSignal, "detector" | "why" | "suggested_action">,
): string {
  const ask = calendarSignalAsk(signal.detector);
  const body = ask ? `${ask} ${signal.why}` : signal.suggested_action;
  return `${body} Nothing outside this conversation changes without my explicit confirmation.`;
}

function calendarSignalAsk(detector: DetectorKind): string | null {
  if (detector === "calendar_overlap") {
    return "Move one of these two events in my calendar to a time that is free.";
  }
  if (detector === "travel_gap") {
    return "Move one of these two events in my calendar so there is time to travel between them.";
  }
  if (detector === "commitment_unscheduled") {
    return "Add an event to my calendar to hold time for this before it is due.";
  }
  // A deadline collision is about a day that is already too full. There is no single event
  // to move, so the honest prompt is the detector's own wording rather than an invented
  // instruction that would send the calendar path hunting for a target that does not exist.
  return null;
}

/** A signal is raised at most once per cooldown window, on the same clock as a nudge. */
function signalIsCoolingDown(
  signal: DetectedSignal,
  mode: ActiveStewardshipMode,
  referenceTime: Date,
): boolean {
  if (!signal.last_surfaced_at) return false;
  const cooldownDays = mode === "quiet" ? 14 : mode === "proactive" ? 3 : 7;
  return Date.parse(signal.last_surfaced_at) > referenceTime.getTime() - cooldownDays * DAY;
}

/**
 * A dismissed signal stays dismissed until the world changes it.
 *
 * `detected_at` moves only when a detector rewrites the signal, so a conflict the user
 * waved away does not come back merely because the sweep ran again.
 */
function signalIsDismissedWithoutChange(db: Db, signal: DetectedSignal): boolean {
  const last = db
    .prepare<[number], { event_type: string; created_at: string }>(
      `SELECT event_type, created_at FROM signal_event
       WHERE detected_signal_id = ? AND event_type IN ('accepted','dismissed','regretted')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(signal.id);
  return Boolean(
    last &&
      (last.event_type === "dismissed" || last.event_type === "regretted") &&
      last.created_at >= signal.detected_at,
  );
}

/**
 * Accepted facets that block still block. An unlinked signal answers to global and
 * domain-scoped blocks; a linked one additionally answers to its commitment's and goal's.
 */
function signalIsBlockedByFacet(
  machineEffects: readonly ActiveMachineEffect[],
  signal: DetectedSignal,
): boolean {
  return machineEffects.some((effect) => {
    if (effect.machine_effect !== "block") return false;
    if (effect.scope_kind === "global") return true;
    if (effect.scope_kind === "domain") {
      return (
        effect.scope_label !== null &&
        overlapCount(tokens(effect.scope_label), `${signal.why} ${signal.suggested_action}`) > 0
      );
    }
    if (effect.scope_kind === "commitment") {
      return effect.scope_commitment_id === signal.commitment_id;
    }
    return false;
  });
}

export function getRecommendationCycle(db: Db, id: number): RecommendationCycle | null {
  return db
    .prepare<[number], RecommendationCycle>(
      `SELECT id, policy_version, trigger, context_json, query_text,
              candidate_scores_json, applied_facet_ids_json, exclusions_json,
              selected_commitment_id, selected_signal_id, recommendation_json,
              source_message_id, created_at
       FROM recommendation_cycle WHERE id = ?`,
    )
    .get(id) ?? null;
}

export function recommendationForOpportunity(
  db: Db,
  opportunityId: number,
): FollowThroughRecommendation | null {
  const cycle = getRecommendationCycle(db, opportunityId);
  if (!cycle?.recommendation_json) return null;
  // A signal cycle stores a different shape. Returning null rather than a coerced
  // recommendation keeps callers that only understand commitments honest.
  if (cycle.selected_signal_id !== null) return null;
  return parseRecommendationValue(safelyParseJson(cycle.recommendation_json));
}

/** The signal side of the same question: what, if anything, did this cycle select? */
export function signalAlertForOpportunity(
  db: Db,
  opportunityId: number,
): SignalAlert | null {
  const cycle = getRecommendationCycle(db, opportunityId);
  if (!cycle || cycle.selected_signal_id === null || !cycle.recommendation_json) return null;
  const parsed: unknown = safelyParseJson(cycle.recommendation_json);
  if (parsed === null || typeof parsed !== "object") return null;
  const value = parsed as Partial<SignalAlert>;
  if (typeof value.signal_id !== "number" || typeof value.why !== "string") return null;
  if (typeof value.suggested_action !== "string") return null;
  return {
    signal_id: value.signal_id,
    detector: value.detector as SignalAlert["detector"],
    commitment_id: typeof value.commitment_id === "number" ? value.commitment_id : null,
    why: value.why,
    suggested_action: value.suggested_action,
    effect_kind: value.effect_kind as SignalAlert["effect_kind"],
    requires_confirmation: value.requires_confirmation === true,
    chat_prompt: typeof value.chat_prompt === "string" ? value.chat_prompt : value.suggested_action,
    score: typeof value.score === "number" ? value.score : 0,
  };
}

export function listOpportunityDeliveries(
  db: Db,
  opportunityId: number,
): OpportunityDelivery[] {
  return db
    .prepare<[number], OpportunityDelivery>(
      `SELECT id, opportunity_id, channel, response_message_id, delivered_at
       FROM opportunity_delivery WHERE opportunity_id = ? ORDER BY id`,
    )
    .all(opportunityId);
}

/** Record only a successful channel delivery. Replays are idempotent per channel, and
 * the first successful channel alone emits the surfaced event/cooldown mutation. */
export function markOpportunityDelivered(
  db: Db,
  opportunityId: number,
  channel: OpportunityDeliveryChannel,
  responseMessageId: number | null = null,
): OpportunityDelivery | null {
  if (responseMessageId !== null) assertMessageRole(db, responseMessageId, "assistant");
  const cycle = getRecommendationCycle(db, opportunityId);
  if (cycle && cycle.selected_signal_id !== null) {
    return markSignalDelivered(db, cycle, channel, responseMessageId);
  }
  const recommendation = recommendationForOpportunity(db, opportunityId);
  if (!recommendation) return null;

  return db.transaction(() => {
    db.prepare<[number, OpportunityDeliveryChannel, number | null, string]>(
      `INSERT OR IGNORE INTO opportunity_delivery
         (opportunity_id, channel, response_message_id, delivered_at)
       VALUES (?, ?, ?, ?)`,
    ).run(opportunityId, channel, responseMessageId, now());
    const delivery = db
      .prepare<[number, OpportunityDeliveryChannel], OpportunityDelivery>(
        `SELECT id, opportunity_id, channel, response_message_id, delivered_at
         FROM opportunity_delivery WHERE opportunity_id = ? AND channel = ?`,
      )
      .get(opportunityId, channel);
    if (!delivery) throw new Error("Opportunity delivery vanished immediately after insert");

    const surfaced = db
      .prepare<[number], { found: number }>(
        `SELECT 1 AS found FROM follow_through_event
         WHERE opportunity_id = ? AND event_type = 'surfaced' LIMIT 1`,
      )
      .get(opportunityId);
    if (!surfaced) {
      markCommitmentSurfaced(db, recommendation.commitment_id);
      insertEvent(db, {
        recommendation,
        eventType: "surfaced",
        responseMessageId,
        opportunityId,
        sourceMessageId: null,
        sourceKind: "system",
      });
    }
    return delivery;
  })();
}

/**
 * Count a signal as surfaced on its first channel, exactly as a commitment nudge is.
 *
 * `last_surfaced_at` is what the cooldown reads, so it moves here and nowhere else: a
 * signal that was evaluated but never shown must not start its own cooldown.
 */
function markSignalDelivered(
  db: Db,
  cycle: RecommendationCycle,
  channel: OpportunityDeliveryChannel,
  responseMessageId: number | null,
): OpportunityDelivery | null {
  const signalId = cycle.selected_signal_id;
  if (signalId === null) return null;
  return db.transaction((): OpportunityDelivery | null => {
    db.prepare<[number, OpportunityDeliveryChannel, number | null, string]>(
      `INSERT OR IGNORE INTO opportunity_delivery
         (opportunity_id, channel, response_message_id, delivered_at)
       VALUES (?, ?, ?, ?)`,
    ).run(cycle.id, channel, responseMessageId, now());
    const delivery = db
      .prepare<[number, OpportunityDeliveryChannel], OpportunityDelivery>(
        `SELECT id, opportunity_id, channel, response_message_id, delivered_at
         FROM opportunity_delivery WHERE opportunity_id = ? AND channel = ?`,
      )
      .get(cycle.id, channel);
    if (!delivery) throw new Error("Opportunity delivery vanished immediately after insert");

    const alreadySurfaced = db
      .prepare<[number, number], { found: number }>(
        `SELECT 1 AS found FROM signal_event
         WHERE detected_signal_id = ? AND event_type = 'surfaced'
           AND created_at >= (SELECT detected_at FROM detected_signal WHERE id = ?)
         LIMIT 1`,
      )
      .get(signalId, signalId);
    if (!alreadySurfaced) {
      const timestamp = now();
      db.prepare<[string, number]>(
        "UPDATE detected_signal SET last_surfaced_at = ? WHERE id = ?",
      ).run(timestamp, signalId);
      db.prepare<[number, number | null, string]>(
        `INSERT INTO signal_event
           (detected_signal_id, event_type, response_message_id, source_kind,
            detail_json, created_at)
         VALUES (?, 'surfaced', ?, 'system', NULL, ?)`,
      ).run(signalId, responseMessageId, timestamp);
    }
    return delivery;
  })();
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
  const context = createEvaluationContext({ trigger: "today", referenceTime });
  const policy = machineEffectFor(
    activeMachineEffects(db, context).active,
    commitment,
    goal,
    query,
  );
  if (policy.blocked) return null;
  const configuredMode = getStewardshipSetting(db).mode;
  return scoreRecommendation({
    commitment,
    goal,
    allCommitments: listCommitments(db, { includeClosed: true, limit: 500 }),
    terms: tokens(query),
    query,
    mode: configuredMode === "off" ? "balanced" : configuredMode,
    explicitlyRequested: true,
    referenceTime,
    selfEntityId: selfEntity(db).id,
    machineEffectDelta: policy.scoreDelta,
  });
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

  const event = db.transaction(() => {
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
  // Only the explicit decision just persisted can contribute here. The aggregator
  // deliberately excludes surfaced events and silence, and materialization never
  // creates canonical memory or activates a policy.
  materializeBehavioralPolicySuggestions(db);
  return event;
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
    .prepare<[number, number, number], { found: number }>(
      `SELECT 1 AS found
       FROM follow_through_event e
       LEFT JOIN opportunity_delivery d ON d.opportunity_id = e.opportunity_id
       WHERE e.commitment_id = ? AND e.event_type = 'surfaced'
         AND (e.response_message_id = ? OR d.response_message_id = ?)
       LIMIT 1`,
    )
    .get(commitmentId, responseMessageId, responseMessageId);
  return found ? responseMessageId : null;
}

export function listFollowThroughEvents(db: Db, limit = 100): FollowThroughEventView[] {
  return db
    .prepare<[number], FollowThroughEventView>(
      `SELECT e.id, e.commitment_id, e.goal_id, e.event_type, e.reason,
              e.action_kind, e.effect_kind, e.detail_json, e.response_message_id,
              e.opportunity_id,
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
    .prepare<[number, number], { detail_json: string | null }>(
      `SELECT DISTINCT e.id, e.detail_json
       FROM follow_through_event e
       LEFT JOIN opportunity_delivery d ON d.opportunity_id = e.opportunity_id
       WHERE e.event_type = 'surfaced'
         AND (e.response_message_id = ? OR d.response_message_id = ?)
       ORDER BY e.id`,
    )
    .all(responseMessageId, responseMessageId);
  return rows.flatMap((row) => parseRecommendation(row.detail_json));
}

/**
 * Record what the user decided about a detected signal.
 *
 * Kept parallel to `recordFollowThroughDecision` rather than merged into it: a decision
 * about a conflict Zeus observed must not become evidence in the behavioral-policy
 * machinery, which reasons about the user's own commitments. Outcomes are never inferred
 * from silence or from the assistant's own text.
 */
export function recordSignalDecision(
  db: Db,
  input: {
    signalId: number;
    decision: FollowThroughDecision;
    responseMessageId?: number | null;
    sourceMessageId?: number | null;
    snoozedUntil?: string | null;
    userReason?: string | null;
  },
): DetectedSignal | null {
  const signal = getSignal(db, input.signalId);
  if (!signal) return null;
  const responseMessageId = input.responseMessageId ?? null;
  if (responseMessageId !== null) assertMessageRole(db, responseMessageId, "assistant");
  const sourceMessageId = input.sourceMessageId ?? null;
  if (sourceMessageId !== null) assertMessageRole(db, sourceMessageId, "user");

  return db.transaction((): DetectedSignal | null => {
    const timestamp = now();
    const reason = normalizeUserReason(input.userReason ?? null);
    if (input.decision === "snoozed") {
      const until =
        input.snoozedUntil ?? new Date(Date.parse(timestamp) + 7 * DAY).toISOString();
      db.prepare<[string, number]>(
        "UPDATE detected_signal SET snoozed_until = ? WHERE id = ?",
      ).run(until, input.signalId);
    }
    if (input.decision === "completed") {
      db.prepare<[string, number]>(
        "UPDATE detected_signal SET resolved_at = ? WHERE id = ?",
      ).run(timestamp, input.signalId);
    }
    db.prepare<[number, FollowThroughDecision, string | null, number | null, number | null, string, string]>(
      `INSERT INTO signal_event
         (detected_signal_id, event_type, detail_json, response_message_id,
          source_message_id, source_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.signalId,
      input.decision,
      reason === null ? null : JSON.stringify({ user_reason: reason }),
      responseMessageId,
      sourceMessageId,
      sourceMessageId === null ? "user_action" : sourceKindForUserMessage(db, sourceMessageId),
      timestamp,
    );
    return getSignal(db, input.signalId);
  })();
}

/**
 * Progress, control, and regret across both kinds of proposal.
 *
 * Signals are unioned in rather than counted separately because the question these
 * numbers answer — is Zeus helping, and at what cost to the user's control — is the same
 * question whichever kind of proposal was surfaced.
 */
export function followThroughMetrics(db: Db): FollowThroughMetrics {
  const counts = db
    .prepare<[], { event_type: FollowThroughEventType; count: number }>(
      `SELECT event_type, COUNT(*) AS count FROM (
         SELECT event_type FROM follow_through_event
         UNION ALL
         SELECT event_type FROM signal_event
       )
       GROUP BY event_type`,
    )
    .all();
  const byType = new Map(counts.map((row) => [row.event_type, row.count]));
  const progress = (db
    .prepare<[], { count: number }>(
      `SELECT COUNT(DISTINCT commitment_id) AS count
       FROM follow_through_event WHERE event_type = 'completed'`,
    )
    .get()?.count ?? 0) + (db
    .prepare<[], { count: number }>(
      `SELECT COUNT(DISTINCT detected_signal_id) AS count
       FROM signal_event WHERE event_type = 'completed'`,
    )
    .get()?.count ?? 0);
  const progressWithoutRegret = (db
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
    .get()?.count ?? 0) + (db
    .prepare<[], { count: number }>(
      `SELECT COUNT(DISTINCT completed.detected_signal_id) AS count
       FROM signal_event completed
       WHERE completed.event_type = 'completed'
         AND NOT EXISTS (
           SELECT 1 FROM signal_event regretted
           WHERE regretted.detected_signal_id = completed.detected_signal_id
             AND regretted.event_type = 'regretted'
             AND regretted.id > completed.id
         )`,
    )
    .get()?.count ?? 0);

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
  id: number;
  machine_effect: FacetMachineEffect;
  scope_kind: "global" | "domain" | "entity" | "goal" | "commitment";
  scope_label: string | null;
  scope_entity_id: number | null;
  scope_goal_id: number | null;
  scope_commitment_id: number | null;
  condition_text: string | null;
  condition_json: string | null;
};

function activeMachineEffects(
  db: Db,
  context: EvaluationContext,
): { active: ActiveMachineEffect[]; exclusions: FacetConditionExclusionTrace[] } {
  const rows = db
    .prepare<[], ActiveMachineEffect>(
      `SELECT id, machine_effect, scope_kind, scope_label, scope_entity_id,
              scope_goal_id, scope_commitment_id, condition_text, condition_json
       FROM understanding_facet
       WHERE valid_to IS NULL AND machine_effect IS NOT NULL
       ORDER BY id`,
    )
    .all();
  const active: ActiveMachineEffect[] = [];
  const exclusions: FacetConditionExclusionTrace[] = [];
  for (const row of rows) {
    const condition = parseMachineCondition(row);
    if (condition.kind === "unconditional") {
      active.push(row);
      continue;
    }
    if (condition.kind === "legacy") {
      exclusions.push({ facet_id: row.id, reason: "legacy_condition" });
      continue;
    }
    if (condition.kind === "invalid") {
      exclusions.push({ facet_id: row.id, reason: "invalid_condition" });
      continue;
    }
    if (structuredFacetConditionMatches(condition.value, context)) {
      active.push(row);
    } else {
      exclusions.push({ facet_id: row.id, reason: "condition_not_met" });
    }
  }
  return { active, exclusions };
}

function parseMachineCondition(
  effect: Pick<ActiveMachineEffect, "condition_text" | "condition_json">,
):
  | { kind: "unconditional" }
  | { kind: "legacy" }
  | { kind: "invalid" }
  | { kind: "structured"; value: StructuredFacetCondition } {
  if (effect.condition_json === null) {
    return effect.condition_text === null ? { kind: "unconditional" } : { kind: "legacy" };
  }
  try {
    const parsed = StructuredFacetConditionSchema.safeParse(JSON.parse(effect.condition_json));
    return parsed.success
      ? { kind: "structured", value: parsed.data }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/** Shared deterministic evaluator for typed facet conditions. Descriptive recall and
 * machine policy must agree about when a contextual preference is active. */
export function structuredFacetConditionMatches(
  condition: StructuredFacetCondition,
  context: EvaluationContext,
): boolean {
  const evaluatedAt = Date.parse(context.evaluated_at);
  if (
    condition.expires_at !== undefined &&
    evaluatedAt >= Date.parse(condition.expires_at)
  ) {
    return false;
  }

  if (condition.zones !== undefined) {
    const location = freshLocationZone(context);
    const allowed = new Set(condition.zones.map((zone) => normalizeZone(zone)));
    if (location === null || !allowed.has(location)) return false;
  }

  const minute = clockMinute(context.local_time);
  if (condition.local_time !== undefined) {
    const start = clockMinute(condition.local_time.start);
    const end = clockMinute(condition.local_time.end);
    const inWindow = start < end
      ? minute >= start && minute < end
      : minute >= start || minute < end;
    if (!inWindow) return false;
    if (condition.weekdays !== undefined) {
      const effectiveWeekday = start > end && minute < end
        ? previousWeekday(context.local_weekday)
        : context.local_weekday;
      if (!condition.weekdays.includes(effectiveWeekday)) return false;
    }
  } else if (
    condition.weekdays !== undefined &&
    !condition.weekdays.includes(context.local_weekday)
  ) {
    return false;
  }

  return true;
}

function freshLocationZone(context: EvaluationContext): string | null {
  if (context.location_zone === null || context.location_observed_at === null) return null;
  const evaluatedAt = Date.parse(context.evaluated_at);
  const observedAt = Date.parse(context.location_observed_at);
  const age = evaluatedAt - observedAt;
  if (!Number.isFinite(age) || age < 0 || age > LOCATION_FRESHNESS) return null;
  return normalizeZone(context.location_zone);
}

function clockMinute(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function previousWeekday(value: Weekday): Weekday {
  const days: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const index = days.indexOf(value);
  return days[(index + days.length - 1) % days.length]!;
}

function machineEffectFor(
  effects: readonly ActiveMachineEffect[],
  commitment: CommitmentView,
  goal: Goal | null,
  query: string,
): { blocked: boolean; scoreDelta: number; appliedFacetIds: number[] } {
  const targetTerms = tokens(
    `${query} ${commitment.title} ${goal?.title ?? ""}`,
  );
  let scoreDelta = 0;
  const appliedFacetIds: number[] = [];
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
    appliedFacetIds.push(effect.id);
    if (effect.machine_effect === "block") {
      return { blocked: true, scoreDelta: 0, appliedFacetIds };
    }
    scoreDelta += effect.machine_effect === "boost" ? 40 : -40;
  }
  return {
    blocked: false,
    scoreDelta: Math.max(-80, Math.min(80, scoreDelta)),
    appliedFacetIds,
  };
}

type ScoreInput = {
  commitment: CommitmentView;
  goal: Goal | null;
  allCommitments: readonly CommitmentView[];
  terms: Set<string>;
  query: string;
  mode: ActiveStewardshipMode;
  explicitlyRequested: boolean;
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
  const eligible = input.explicitlyRequested ||
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
  const effectKind = effectKindFor(commitment, actionKind);
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
  const suggestedAction = actionFor(actionKind, effectKind, commitment.title);
  const requiresConfirmation = requiresEffectConfirmation(effectKind);
  // What the user appears to have typed once they click through, so it stays the length of
  // something a person would type. It carries no standing disclaimer: external action is
  // gated by authorizeWorkPlan and confirmEffect whatever this text says, and a compliance
  // paragraph attributed to the user is a worse lie than a short request.
  const chatPrompt = [
    `Help me follow through on “${commitment.title}”.`,
    suggestedAction,
    goal ? `Keep my goal “${goal.title}” in view.` : null,
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
    effect_kind: effectKind,
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

function effectKindFor(
  commitment: CommitmentView,
  actionKind: FollowThroughActionKind,
): EffectKind {
  const title = commitment.title.toLowerCase();
  if (
    /\b(?:buy|purchase|order|pay|checkout|subscribe|renew|book (?:a |an |the )?(?:flight|hotel|table|ticket)|reserve (?:a |an |the )?(?:room|table|ticket))\b/u.test(
      title,
    )
  ) {
    return "purchase";
  }
  if (/\b(?:publish|post|upload|submit|deploy|delete|remove|cancel|unsubscribe|register|enroll|apply|sign[ -]?up|rsvp|vote|transfer|change (?:an? |the )?(?:account|setting|subscription))\b/u.test(title)) {
    return "modify_external";
  }
  if (actionKind === "schedule" || actionKind === "remind") return "schedule";
  if (
    commitment.status === "waiting" ||
    commitment.owner_slug !== "self" ||
    /\b(?:send|email|message|reply|text|call|ask|contact|coordinate|follow up|follow-up)\b/u.test(
      title,
    )
  ) {
    return "send";
  }
  if (actionKind === "research") return "web_read";
  if (/\b(?:remember|recall|review (?:my )?(?:memory|history|notes?))\b/u.test(title)) {
    return "memory_read";
  }
  return "prepare_local";
}

function requiresEffectConfirmation(effectKind: EffectKind): boolean {
  return !["memory_read", "web_read", "prepare_local"].includes(effectKind);
}

function actionFor(
  kind: FollowThroughActionKind,
  effectKind: EffectKind,
  title: string,
): string {
  if (effectKind === "purchase") {
    return `Compare options for “${title}” and stop before any booking, order, or payment.`;
  }
  if (effectKind === "modify_external") {
    return `Prepare and review the exact change for “${title}” without applying it externally.`;
  }
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
    opportunityId?: number | null;
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
      EffectKind,
      string,
      number | null,
      number | null,
      number | null,
      FollowThroughEvent["source_kind"],
      string,
    ]>(
      `INSERT INTO follow_through_event
         (commitment_id, goal_id, event_type, reason, action_kind, effect_kind,
          detail_json, response_message_id, opportunity_id, source_message_id,
          source_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.recommendation.commitment_id,
      input.recommendation.goal_id,
      input.eventType,
      input.recommendation.reason,
      input.recommendation.action_kind,
      input.recommendation.effect_kind,
      JSON.stringify(detail),
      input.responseMessageId,
      input.opportunityId ?? null,
      input.sourceMessageId,
      input.sourceKind,
      now(),
    );
  const event = db
    .prepare<[number], FollowThroughEvent>(
      `SELECT id, commitment_id, goal_id, event_type, reason, action_kind,
              effect_kind, detail_json, response_message_id, opportunity_id,
              source_message_id, source_kind, created_at
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
    const recommendation = parseRecommendationValue(detail.recommendation);
    return recommendation ? [recommendation] : [];
  } catch {
    return [];
  }
}

function parseRecommendationValue(value: unknown): FollowThroughRecommendation | null {
  const parsed = FollowThroughRecommendationSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object" || !("action_kind" in value)) return null;
  const legacy = value as Record<string, unknown>;
  const actionKind = legacy.action_kind;
  const effectKind: EffectKind | null = actionKind === "research"
    ? "web_read"
    : actionKind === "schedule"
      ? "schedule"
      : actionKind === "remind"
        ? "modify_external"
        : actionKind === "coordinate" || actionKind === "draft"
          ? "send"
          : actionKind === "plan"
            ? "prepare_local"
            : null;
  if (effectKind === null) return null;
  const upgraded = FollowThroughRecommendationSchema.safeParse({
    ...legacy,
    effect_kind: effectKind,
    requires_confirmation: requiresEffectConfirmation(effectKind),
  });
  return upgraded.success ? upgraded.data : null;
}

function isSnoozed(commitment: CommitmentView, referenceTime: Date): boolean {
  return Boolean(
    commitment.snoozed_until && Date.parse(commitment.snoozed_until) > referenceTime.getTime(),
  );
}

function isCoolingDown(
  commitment: CommitmentView,
  mode: ActiveStewardshipMode,
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

function safelyParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function assertMessageRole(db: Db, messageId: number, role: "user" | "assistant"): void {
  const source = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(messageId);
  if (source?.role !== role) {
    throw new Error(`Follow-through ${role} source must be a stored ${role} message`);
  }
}

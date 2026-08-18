import { z } from "zod";

/**
 * Zod is the source of truth for everything crossing a boundary — the SQLite rows,
 * the MCP tool arguments, and the extraction model's output. Types are inferred from
 * these schemas rather than declared alongside them, so the two can never drift.
 */

export const EntityKind = z.enum(["person", "project", "org", "place", "topic", "thing"]);
export type EntityKind = z.infer<typeof EntityKind>;

export const Cardinality = z.enum(["single", "multi"]);
export type Cardinality = z.infer<typeof Cardinality>;

export const MessageRole = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const MessageOrigin = z.enum(["conversation", "user_action", "reflection", "backfill"]);
export type MessageOrigin = z.infer<typeof MessageOrigin>;

export const MessageRecallState = z.enum(["unclassified", "classified", "blocked"]);
export type MessageRecallState = z.infer<typeof MessageRecallState>;

export const ConversationSource = z.enum(["web", "mcp", "seed"]);
export type ConversationSource = z.infer<typeof ConversationSource>;

export const McpMutationEventType = z.enum([
  "approval_requested",
  "approval_unsupported",
  "approval_declined",
  "approval_cancelled",
  "approval_expired",
  "approved",
  "applied",
  "failed",
]);
export type McpMutationEventType = z.infer<typeof McpMutationEventType>;

export const McpMutationEvent = z
  .object({
    id: z.number().int(),
    operation_id: z.string(),
    tool_name: z.string(),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    target_kind: z.string().nullable(),
    target_id: z.number().int().positive().nullable(),
    event_type: McpMutationEventType,
    source_message_id: z.number().int().positive().nullable(),
    approval_expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type McpMutationEvent = z.infer<typeof McpMutationEvent>;

export const SnapshotDestination = z
  .object({
    directory: z.string().min(1),
    file_prefix: z.string().regex(/^.+\.zeus-snapshot-[a-f0-9]{16}-$/u),
    device_id: z.string().regex(/^\d+$/u),
    registered_at: z.string(),
  })
  .strict();
export type SnapshotDestination = z.infer<typeof SnapshotDestination>;

export const OwnerKind = z.enum(["fact", "message", "entity"]);
export type OwnerKind = z.infer<typeof OwnerKind>;

export const EvidenceKind = z.enum(["assertion", "reassertion", "correction"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const CandidateKind = z.enum(["fact", "goal", "commitment", "interest", "facet"]);
export type CandidateKind = z.infer<typeof CandidateKind>;

export const CandidateReason = z.enum([
  "inference",
  "ambiguous",
  "sensitive",
  "conflict",
  "backfill_preview",
]);
export type CandidateReason = z.infer<typeof CandidateReason>;

export const CandidateStatus = z.enum(["pending", "accepted", "rejected"]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const GoalStatus = z.enum(["active", "paused", "achieved", "abandoned"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

export const GoalPriority = z.enum(["low", "normal", "high"]);
export type GoalPriority = z.infer<typeof GoalPriority>;

export const CommitmentStatus = z.enum(["open", "waiting", "done", "cancelled"]);
export type CommitmentStatus = z.infer<typeof CommitmentStatus>;

export const StewardshipMode = z.enum(["off", "quiet", "balanced", "proactive"]);
export type StewardshipMode = z.infer<typeof StewardshipMode>;

export const TriggerKind = z.enum(["chat", "today", "mcp", "worker"]);
export type TriggerKind = z.infer<typeof TriggerKind>;

/**
 * The unit of authorization for work. `external_read` is deliberately separate from
 * `web_read`: reading the user's calendar through a connected service is a different
 * grant from searching the public web, and a plan approved for one must not thereby
 * reach the other.
 */
export const EffectKind = z.enum([
  "memory_read",
  "web_read",
  "prepare_local",
  "external_read",
  "send",
  "schedule",
  "purchase",
  "modify_external",
]);
export type EffectKind = z.infer<typeof EffectKind>;

/** Effects that change state outside Zeus, and therefore need a confirmed payload. */
export const WriteEffectKind = z.enum(["send", "schedule", "modify_external"]);
export type WriteEffectKind = z.infer<typeof WriteEffectKind>;

export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;

const LocalClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Expected HH:mm");
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** Avoid Zod's legacy string.datetime helper, which currently creates a Turbopack
 * initialization cycle in production SSR bundles. This boundary still requires an
 * explicit UTC/offset ISO-8601 timestamp and a calendar-valid parsed value. */
export const IsoDateTime = z.string().refine(
  (value) => ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value)),
  "Expected an ISO-8601 timestamp with UTC or an explicit offset",
);

export const StructuredFacetCondition = z
  .object({
    weekdays: z.array(Weekday).min(1).max(7).optional(),
    local_time: z
      .object({ start: LocalClockTime, end: LocalClockTime })
      .strict()
      .refine((value) => value.start !== value.end, "A local-time window must have a duration")
      .optional(),
    zones: z.array(z.string().trim().min(1).max(120)).min(1).optional(),
    expires_at: IsoDateTime.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.weekdays !== undefined ||
      value.local_time !== undefined ||
      value.zones !== undefined ||
      value.expires_at !== undefined,
    "At least one structured condition is required",
  );
export type StructuredFacetCondition = z.infer<typeof StructuredFacetCondition>;

export const EvaluationContext = z
  .object({
    trigger: TriggerKind,
    evaluated_at: IsoDateTime,
    timezone: z.string().trim().min(1).max(100),
    local_weekday: Weekday,
    local_time: LocalClockTime,
    daypart: z.enum(["overnight", "morning", "afternoon", "evening"]),
    location_zone: z.string().trim().min(1).max(120).nullable(),
    location_observed_at: IsoDateTime.nullable(),
  })
  .strict();
export type EvaluationContext = z.infer<typeof EvaluationContext>;

export const ProjectStatus = z.enum(["planned", "active", "paused", "completed", "abandoned"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const ProjectEventType = z.enum([
  "created",
  "updated",
  "status_changed",
  "progress",
  "blocked",
  "unblocked",
]);
export type ProjectEventType = z.infer<typeof ProjectEventType>;

export const WorkPlanStatus = z.enum([
  "proposed",
  "authorized",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkPlanStatus = z.infer<typeof WorkPlanStatus>;

export const WorkStepStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);
export type WorkStepStatus = z.infer<typeof WorkStepStatus>;

export const WorkRunStatus = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkRunStatus = z.infer<typeof WorkRunStatus>;

export const WorkArtifactKind = z.enum(["draft", "comparison", "report", "research_notes"]);
export type WorkArtifactKind = z.infer<typeof WorkArtifactKind>;

export const ToolReceiptStatus = z.enum(["started", "completed", "failed"]);
export type ToolReceiptStatus = z.infer<typeof ToolReceiptStatus>;

export const FollowThroughReason = z.enum([
  "overdue",
  "due_soon",
  "relevant",
  "waiting",
  "stale",
  "conflict",
  "priority",
]);
export type FollowThroughReason = z.infer<typeof FollowThroughReason>;

export const FollowThroughActionKind = z.enum([
  "draft",
  "schedule",
  "research",
  "remind",
  "coordinate",
  "plan",
]);
export type FollowThroughActionKind = z.infer<typeof FollowThroughActionKind>;

export const FollowThroughEventType = z.enum([
  "surfaced",
  "accepted",
  "dismissed",
  "snoozed",
  "completed",
  "regretted",
]);
export type FollowThroughEventType = z.infer<typeof FollowThroughEventType>;

export const BehavioralPolicySuggestionKind = z.enum([
  "temporary_suppression",
  "confirm_routine",
]);
export type BehavioralPolicySuggestionKind = z.infer<
  typeof BehavioralPolicySuggestionKind
>;

export const BehavioralPolicyReviewStatus = z.enum([
  "pending",
  "accepted_for_review",
  "dismissed",
]);
export type BehavioralPolicyReviewStatus = z.infer<
  typeof BehavioralPolicyReviewStatus
>;

export const BehavioralInterruptionChange = z.enum(["none", "suppress_only"]);
export type BehavioralInterruptionChange = z.infer<
  typeof BehavioralInterruptionChange
>;

export const BehavioralPolicySuggestionEventType = z.enum([
  "materialized",
  "accepted_for_review",
  "dismissed",
]);
export type BehavioralPolicySuggestionEventType = z.infer<
  typeof BehavioralPolicySuggestionEventType
>;

export const FacetKind = z.enum([
  "value",
  "decision_criterion",
  "constraint",
  "preference",
  "motivation",
  "routine",
  "communication_style",
  "working_style",
  "boundary",
  "capacity_pattern",
  "skill",
  "relationship_dynamic",
]);
export type FacetKind = z.infer<typeof FacetKind>;

export const FacetScopeKind = z.enum(["global", "domain", "entity", "goal", "commitment"]);
export type FacetScopeKind = z.infer<typeof FacetScopeKind>;

export const FacetScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("domain"), label: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("entity"), entityId: z.number().int() }).strict(),
  z.object({ kind: z.literal("goal"), goalId: z.number().int() }).strict(),
  z.object({ kind: z.literal("commitment"), commitmentId: z.number().int() }).strict(),
]);
export type FacetScope = z.infer<typeof FacetScope>;

export const FacetImportance = z.enum(["low", "normal", "high"]);
export type FacetImportance = z.infer<typeof FacetImportance>;

export const FacetSensitivity = z.enum(["normal", "sensitive"]);
export type FacetSensitivity = z.infer<typeof FacetSensitivity>;

export const FacetMachineEffect = z.enum(["boost", "deprioritize", "block"]);
export type FacetMachineEffect = z.infer<typeof FacetMachineEffect>;

export const PassageSensitivity = z.enum(["normal", "sensitive", "uncertain"]);
export type PassageSensitivity = z.infer<typeof PassageSensitivity>;

export const PassageRecallStatus = z.enum(["allowed", "pending", "blocked"]);
export type PassageRecallStatus = z.infer<typeof PassageRecallStatus>;

// ---------------------------------------------------------------------------
// Stored rows
// ---------------------------------------------------------------------------

export const AppOwner = z
  .object({
    id: z.literal(1),
    supabase_user_id: z.string().uuid(),
    email: z.string().email(),
    bound_at: z.string(),
  })
  .strict();
export type AppOwner = z.infer<typeof AppOwner>;

export const Entity = z
  .object({
    id: z.number().int(),
    kind: EntityKind,
    name: z.string(),
    slug: z.string(),
    summary: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type Entity = z.infer<typeof Entity>;

export const Fact = z
  .object({
    id: z.number().int(),
    subject_id: z.number().int(),
    predicate: z.string(),
    object: z.string(),
    object_entity_id: z.number().int().nullable(),
    confidence: z.number().min(0).max(1),
    valid_from: z.string(),
    /** NULL means "still true". A timestamp means it was superseded then. */
    valid_to: z.string().nullable(),
    superseded_by: z.number().int().nullable(),
    /** The message that produced this fact. Provenance is a foreign key, not a note. */
    source_message_id: z.number().int().nullable(),
    /** How many times this has been independently asserted. Repetition is evidence. */
    assertion_count: z.number().int(),
    last_seen_at: z.string(),
    created_at: z.string(),
  })
  .strict();
export type Fact = z.infer<typeof Fact>;

export const Message = z
  .object({
    id: z.number().int(),
    conversation_id: z.number().int(),
    role: MessageRole,
    content: z.string(),
    created_at: z.string(),
    origin: MessageOrigin,
    recall_state: MessageRecallState,
  })
  .strict();
export type Message = z.infer<typeof Message>;

export const Conversation = z
  .object({
    id: z.number().int(),
    title: z.string().nullable(),
    source: ConversationSource,
    started_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type Conversation = z.infer<typeof Conversation>;

export const FactEvidence = z
  .object({
    id: z.number().int(),
    fact_id: z.number().int(),
    source_message_id: z.number().int(),
    passage_id: z.number().int().nullable(),
    kind: EvidenceKind,
    confidence: z.number().min(0).max(1),
    created_at: z.string(),
  })
  .strict();
export type FactEvidence = z.infer<typeof FactEvidence>;

export const MemoryCandidate = z
  .object({
    id: z.number().int(),
    kind: CandidateKind,
    payload_json: z.string(),
    reason: CandidateReason,
    reasons_json: z.string(),
    confidence: z.number().min(0).max(1),
    source_message_id: z.number().int(),
    status: CandidateStatus,
    dedupe_key: z.string().nullable(),
    origin: z.enum(["live", "backfill"]),
    backfill_job_id: z.number().int().nullable(),
    resolved_at: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type MemoryCandidate = z.infer<typeof MemoryCandidate>;

export const EvidencePassage = z
  .object({
    id: z.number().int(),
    message_id: z.number().int(),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().positive(),
    text: z.string(),
    sensitivity: PassageSensitivity,
    recall_status: PassageRecallStatus,
    extraction_run_id: z.number().int().nullable(),
    created_at: z.string(),
  })
  .strict();
export type EvidencePassage = z.infer<typeof EvidencePassage>;

export const UnderstandingFacet = z
  .object({
    id: z.number().int(),
    kind: FacetKind,
    statement: z.string(),
    scope_kind: FacetScopeKind,
    scope_label: z.string().nullable(),
    scope_entity_id: z.number().int().nullable(),
    scope_goal_id: z.number().int().nullable(),
    scope_commitment_id: z.number().int().nullable(),
    condition_text: z.string().nullable(),
    condition_json: z.string().nullable(),
    importance: FacetImportance,
    sensitivity: FacetSensitivity,
    confidence: z.number().min(0).max(1),
    machine_effect: FacetMachineEffect.nullable(),
    valid_from: z.string(),
    valid_to: z.string().nullable(),
    superseded_by: z.number().int().nullable(),
    source_message_id: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type UnderstandingFacet = z.infer<typeof UnderstandingFacet>;

export const UnderstandingFacetView = UnderstandingFacet.extend({
  scope_entity_name: z.string().nullable(),
  scope_entity_slug: z.string().nullable(),
  scope_goal_title: z.string().nullable(),
  scope_commitment_title: z.string().nullable(),
}).strict();
export type UnderstandingFacetView = z.infer<typeof UnderstandingFacetView>;

export const FacetEvidence = z
  .object({
    id: z.number().int(),
    facet_id: z.number().int(),
    passage_id: z.number().int(),
    kind: z.enum(["assertion", "pattern_support", "correction"]),
    confidence: z.number().min(0).max(1),
    created_at: z.string(),
    source_message_id: z.number().int(),
    quote: z.string(),
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().positive(),
  })
  .strict();
export type FacetEvidence = z.infer<typeof FacetEvidence>;

export const Goal = z
  .object({
    id: z.number().int(),
    title: z.string(),
    status: GoalStatus,
    priority: GoalPriority,
    target_at: z.string().nullable(),
    project_id: z.number().int().nullable(),
    confidence: z.number().min(0).max(1),
    source_message_id: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullable(),
  })
  .strict();
export type Goal = z.infer<typeof Goal>;

export const GoalEvent = z
  .object({
    id: z.number().int(),
    goal_id: z.number().int(),
    event_type: z.enum(["created", "updated", "status_changed"]),
    from_status: GoalStatus.nullable(),
    to_status: GoalStatus.nullable(),
    detail_json: z.string().nullable(),
    source_message_id: z.number().int().nullable(),
    passage_id: z.number().int().nullable(),
    source_kind: z.enum(["message", "user_action"]),
    created_at: z.string(),
  })
  .strict();
export type GoalEvent = z.infer<typeof GoalEvent>;

export const Commitment = z
  .object({
    id: z.number().int(),
    title: z.string(),
    owner_entity_id: z.number().int(),
    linked_goal_id: z.number().int().nullable(),
    project_id: z.number().int().nullable(),
    status: CommitmentStatus,
    due_at: z.string().nullable(),
    snoozed_until: z.string().nullable(),
    last_surfaced_at: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    source_message_id: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullable(),
  })
  .strict();
export type Commitment = z.infer<typeof Commitment>;

export const CommitmentView = Commitment.extend({
  owner_name: z.string(),
  owner_slug: z.string(),
  goal_title: z.string().nullable(),
}).strict();
export type CommitmentView = z.infer<typeof CommitmentView>;

export const CommitmentEvent = z
  .object({
    id: z.number().int(),
    commitment_id: z.number().int(),
    event_type: z.enum(["created", "updated", "status_changed", "surfaced", "snoozed"]),
    from_status: CommitmentStatus.nullable(),
    to_status: CommitmentStatus.nullable(),
    detail_json: z.string().nullable(),
    source_message_id: z.number().int().nullable(),
    passage_id: z.number().int().nullable(),
    source_kind: z.enum(["message", "user_action", "system"]),
    created_at: z.string(),
  })
  .strict();
export type CommitmentEvent = z.infer<typeof CommitmentEvent>;

export const StewardshipSetting = z
  .object({
    id: z.literal(1),
    mode: StewardshipMode,
    source_message_id: z.number().int().nullable(),
    updated_at: z.string(),
  })
  .strict();
export type StewardshipSetting = z.infer<typeof StewardshipSetting>;

export const RecommendationCycle = z
  .object({
    id: z.number().int(),
    policy_version: z.string(),
    trigger: TriggerKind,
    context_json: z.string(),
    query_text: z.string(),
    candidate_scores_json: z.string(),
    applied_facet_ids_json: z.string(),
    exclusions_json: z.string(),
    selected_commitment_id: z.number().int().nullable(),
    /** One opportunity pipeline, two possible subjects: a commitment or a detected signal. */
    selected_signal_id: z.number().int().nullable(),
    recommendation_json: z.string().nullable(),
    source_message_id: z.number().int().nullable(),
    created_at: z.string(),
  })
  .strict();
export type RecommendationCycle = z.infer<typeof RecommendationCycle>;

export const OpportunityDeliveryChannel = z.enum(["chat", "today", "mcp", "macos"]);
export type OpportunityDeliveryChannel = z.infer<typeof OpportunityDeliveryChannel>;

export const OpportunityDelivery = z
  .object({
    id: z.number().int(),
    opportunity_id: z.number().int(),
    channel: OpportunityDeliveryChannel,
    response_message_id: z.number().int().nullable(),
    delivered_at: z.string(),
  })
  .strict();
export type OpportunityDelivery = z.infer<typeof OpportunityDelivery>;

export const FollowThroughRecommendation = z
  .object({
    commitment_id: z.number().int(),
    commitment_title: z.string(),
    commitment_source_message_id: z.number().int(),
    goal_id: z.number().int().nullable(),
    goal_title: z.string().nullable(),
    goal_priority: GoalPriority.nullable(),
    due_at: z.string().nullable(),
    reason: FollowThroughReason,
    action_kind: FollowThroughActionKind,
    effect_kind: EffectKind,
    why: z.string(),
    suggested_action: z.string(),
    chat_prompt: z.string(),
    requires_confirmation: z.boolean(),
    score: z.number(),
  })
  .strict();
export type FollowThroughRecommendation = z.infer<typeof FollowThroughRecommendation>;

export const FollowThroughEvent = z
  .object({
    id: z.number().int(),
    commitment_id: z.number().int(),
    goal_id: z.number().int().nullable(),
    event_type: FollowThroughEventType,
    reason: FollowThroughReason,
    action_kind: FollowThroughActionKind,
    effect_kind: EffectKind,
    opportunity_id: z.number().int().nullable(),
    detail_json: z.string().nullable(),
    response_message_id: z.number().int().nullable(),
    source_message_id: z.number().int().nullable(),
    source_kind: z.enum(["system", "message", "user_action"]),
    created_at: z.string(),
  })
  .strict();
export type FollowThroughEvent = z.infer<typeof FollowThroughEvent>;

export const FollowThroughEventView = FollowThroughEvent.extend({
  commitment_title: z.string(),
  goal_title: z.string().nullable(),
}).strict();
export type FollowThroughEventView = z.infer<typeof FollowThroughEventView>;

/**
 * A non-canonical proposal to review a possible behavioral policy. The proposal is
 * evidence-linked audit data, never a fact, facet, routine, or active machine effect.
 */
export const BehavioralPolicySuggestion = z
  .object({
    id: z.number().int(),
    pattern_key: z.string(),
    event_type: z.enum(["dismissed", "snoozed", "completed", "regretted"]),
    action_kind: FollowThroughActionKind,
    kind: BehavioralPolicySuggestionKind,
    summary: z.string(),
    allowed_interruption_change: BehavioralInterruptionChange,
    minimum_evidence_count: z.number().int().min(2),
    created_at: z.string(),
  })
  .strict();
export type BehavioralPolicySuggestion = z.infer<typeof BehavioralPolicySuggestion>;

export const BehavioralPolicySuggestionEvent = z
  .object({
    id: z.number().int(),
    suggestion_id: z.number().int(),
    event_type: BehavioralPolicySuggestionEventType,
    detail_json: z.string().nullable(),
    source_message_id: z.number().int().nullable(),
    source_kind: z.enum(["system", "message", "user_action"]),
    created_at: z.string(),
  })
  .strict();
export type BehavioralPolicySuggestionEvent = z.infer<
  typeof BehavioralPolicySuggestionEvent
>;

export const BehavioralPolicySuggestionView = BehavioralPolicySuggestion.extend({
  status: BehavioralPolicyReviewStatus,
  evidence_event_ids: z.array(z.number().int()),
  events: z.array(BehavioralPolicySuggestionEvent),
}).strict();
export type BehavioralPolicySuggestionView = z.infer<
  typeof BehavioralPolicySuggestionView
>;

export const Project = z
  .object({
    id: z.number().int(),
    entity_id: z.number().int(),
    status: ProjectStatus,
    progress_summary: z.string().nullable(),
    progress_percent: z.number().min(0).max(1).nullable(),
    blocked_at: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    source_message_id: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullable(),
  })
  .strict();
export type Project = z.infer<typeof Project>;

export const ProjectView = Project.extend({
  entity_name: z.string(),
  entity_slug: z.string(),
}).strict();
export type ProjectView = z.infer<typeof ProjectView>;

export const ProjectEvent = z
  .object({
    id: z.number().int(),
    project_id: z.number().int(),
    event_type: ProjectEventType,
    from_status: ProjectStatus.nullable(),
    to_status: ProjectStatus.nullable(),
    detail_json: z.string().nullable(),
    source_message_id: z.number().int().nullable(),
    passage_id: z.number().int().nullable(),
    source_kind: z.enum(["message", "user_action"]),
    created_at: z.string(),
  })
  .strict();
export type ProjectEvent = z.infer<typeof ProjectEvent>;

export const WorkPlan = z
  .object({
    id: z.number().int(),
    objective: z.string(),
    status: WorkPlanStatus,
    plan_hash: z.string(),
    hash_version: z.number().int().min(2).max(3),
    allowed_effects_json: z.string(),
    completion_criteria_json: z.string(),
    max_steps: z.number().int().min(1).max(12),
    max_model_tool_calls: z.number().int().min(1).max(20),
    max_retries_per_step: z.number().int().min(0).max(2),
    max_duration_seconds: z.number().int().min(1).max(900),
    source_message_id: z.number().int(),
    source_goal_id: z.number().int().nullable(),
    source_commitment_id: z.number().int().nullable(),
    source_project_id: z.number().int().nullable(),
    origin: z.enum(["explicit_request", "surfaced_proposal"]),
    created_at: z.string(),
    updated_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .strict();
export type WorkPlan = z.infer<typeof WorkPlan>;

export const WorkPlanMemorySourceKind = z.enum(["fact", "facet"]);
export type WorkPlanMemorySourceKind = z.infer<typeof WorkPlanMemorySourceKind>;

/** Immutable generation-time snapshot of one canonical personalization item. */
export const WorkPlanMemorySource = z
  .object({
    work_plan_id: z.number().int(),
    source_kind: WorkPlanMemorySourceKind,
    source_id: z.number().int(),
    included_in_prompt: z.number().int().min(0).max(1),
    exclusion_reason: z.string().nullable(),
    snapshot_json: z.string(),
  })
  .strict();
export type WorkPlanMemorySource = z.infer<typeof WorkPlanMemorySource>;

/** Exact local/ambient context and accepted-conflict trace used during planning. */
export const WorkPlanGenerationContext = z
  .object({
    work_plan_id: z.number().int(),
    evaluation_context_json: z.string(),
    conflict_snapshot_json: z.string(),
    created_at: z.string(),
  })
  .strict();
export type WorkPlanGenerationContext = z.infer<typeof WorkPlanGenerationContext>;

export const WorkStep = z
  .object({
    id: z.number().int(),
    work_plan_id: z.number().int(),
    position: z.number().int().positive(),
    title: z.string(),
    instruction: z.string(),
    effect_kind: EffectKind,
    status: WorkStepStatus,
    attempt_count: z.number().int().nonnegative(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
  })
  .strict();
export type WorkStep = z.infer<typeof WorkStep>;

export const WorkAuthorization = z
  .object({
    id: z.number().int(),
    work_plan_id: z.number().int(),
    plan_hash: z.string(),
    authorization_kind: z.enum(["explicit_request", "user_approval"]),
    allowed_effects_json: z.string(),
    max_model_tool_calls: z.number().int().min(1).max(20),
    max_retries_per_step: z.number().int().min(0).max(2),
    max_duration_seconds: z.number().int().min(1).max(900),
    expires_at: z.string(),
    source_message_id: z.number().int(),
    created_at: z.string(),
    revoked_at: z.string().nullable(),
  })
  .strict();
export type WorkAuthorization = z.infer<typeof WorkAuthorization>;

export const WorkRun = z
  .object({
    id: z.number().int(),
    work_plan_id: z.number().int(),
    authorization_id: z.number().int(),
    plan_hash: z.string(),
    status: WorkRunStatus,
    model_call_count: z.number().int().nonnegative(),
    tool_call_count: z.number().int().nonnegative(),
    checkpoint_step_id: z.number().int().nullable(),
    started_at: z.string(),
    updated_at: z.string(),
    deadline_at: z.string(),
    runner_token: z.string().nullable(),
    runner_lease_until: z.string().nullable(),
    /** When this run parked for a person, so the wait can be credited back on resume. */
    paused_at: z.string().nullable(),
    paused_ms_total: z.number().int().nonnegative(),
    completed_at: z.string().nullable(),
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
  })
  .strict();
export type WorkRun = z.infer<typeof WorkRun>;

export const WorkArtifact = z
  .object({
    id: z.number().int(),
    work_plan_id: z.number().int(),
    work_run_id: z.number().int(),
    work_step_id: z.number().int().nullable(),
    kind: WorkArtifactKind,
    title: z.string(),
    content: z.string(),
    citations_json: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type WorkArtifact = z.infer<typeof WorkArtifact>;

export const WorkArtifactSource = z
  .object({
    work_artifact_id: z.number().int(),
    source_message_id: z.number().int(),
  })
  .strict();
export type WorkArtifactSource = z.infer<typeof WorkArtifactSource>;

export const WorkArtifactMemorySource = z
  .object({
    work_artifact_id: z.number().int(),
    source_kind: WorkPlanMemorySourceKind,
    source_id: z.number().int(),
    snapshot_json: z.string(),
  })
  .strict();
export type WorkArtifactMemorySource = z.infer<typeof WorkArtifactMemorySource>;

/**
 * `effect_proposal` prepared an external request and stopped; only `connector_call` means
 * bytes left the machine. The distinction is what makes the receipt log answerable.
 */
export const ToolName = z.enum([
  "memory_recall",
  "web_search",
  "local_artifact",
  "effect_proposal",
  "connector_call",
]);
export type ToolName = z.infer<typeof ToolName>;

export const ToolReceipt = z
  .object({
    id: z.number().int(),
    work_run_id: z.number().int(),
    work_step_id: z.number().int().nullable(),
    tool_name: ToolName,
    effect_kind: z.enum([
      "memory_read",
      "web_read",
      "prepare_local",
      "external_read",
      "send",
      "schedule",
      "modify_external",
    ]),
    connector_capability_id: z.number().int().nullable(),
    proposed_effect_id: z.number().int().nullable(),
    call_index: z.number().int().positive(),
    input_json: z.string(),
    output_json: z.string().nullable(),
    citations_json: z.string(),
    status: ToolReceiptStatus,
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    idempotency_key: z.string(),
    started_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .strict();
export type ToolReceipt = z.infer<typeof ToolReceipt>;

// ---------------------------------------------------------------------------
// Connectors and external effects
// ---------------------------------------------------------------------------

export const ConnectorTransport = z.enum(["stdio", "http"]);
export type ConnectorTransport = z.infer<typeof ConnectorTransport>;

export const ConnectorProvider = z.enum(["generic", "google_calendar"]);
export type ConnectorProvider = z.infer<typeof ConnectorProvider>;

export const ConnectorStatus = z.enum(["unverified", "ready", "unreachable", "disabled"]);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/**
 * The capability slots Zeus knows how to fill. A slot fixes its effect kind, so reviewing
 * the bound slots is enough to understand everything a connector is allowed to do.
 */
export const CapabilitySlot = z.enum([
  "calendar.list_events",
  "calendar.create_event",
  "calendar.update_event",
]);
export type CapabilitySlot = z.infer<typeof CapabilitySlot>;

export const CAPABILITY_SLOT_EFFECTS = {
  "calendar.list_events": "external_read",
  "calendar.create_event": "schedule",
  "calendar.update_event": "modify_external",
} as const satisfies Record<CapabilitySlot, EffectKind>;

export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Expected a lowercase 64-character SHA-256 digest");

/**
 * A configured MCP server. It records either a code-owned preset id or how to reach a
 * manual server, plus environment-variable names—never credential values. Deleting a
 * connector therefore cannot leave a credential behind in Zeus.
 */
export const Connector = z
  .object({
    id: z.number().int(),
    preset_id: z.string().nullable(),
    label: z.string(),
    provider: ConnectorProvider,
    provider_connection_id: z.string().nullable(),
    transport: ConnectorTransport,
    command: z.string().nullable(),
    args_json: z.string(),
    cwd: z.string().nullable(),
    url: z.string().nullable(),
    env_var_names_json: z.string(),
    discovered_tools_json: z.string(),
    status: ConnectorStatus,
    enabled: z.number().int().min(0).max(1),
    source_message_id: z.number().int(),
    last_verified_at: z.string().nullable(),
    last_error_code: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type Connector = z.infer<typeof Connector>;

export const ConnectorCapability = z
  .object({
    id: z.number().int(),
    connector_id: z.number().int(),
    slot: CapabilitySlot,
    remote_tool_name: z.string(),
    effect_kind: z.enum(["external_read", "schedule", "modify_external"]),
    input_schema_json: z.string(),
    schema_hash: Sha256Hex,
    enabled: z.number().int().min(0).max(1),
    source_message_id: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type ConnectorCapability = z.infer<typeof ConnectorCapability>;

export const ProposedEffectStatus = z.enum([
  "pending_confirmation",
  "confirmed",
  "declined",
  "expired",
  "executed",
  "failed",
  "reverted",
]);
export type ProposedEffectStatus = z.infer<typeof ProposedEffectStatus>;

/**
 * Which of the two authorization paths approved one exact payload.
 *
 * `user_message` is the default and the only path for `send`, for generated plans, and for
 * anything the conflict gate could not clear. `standing_policy` covers a calendar action the
 * user enabled direct execution for, and which Zeus verified against a freshly read window.
 * The distinction is stored rather than inferred, so "did a human confirm this?" stays a
 * query rather than an interpretation.
 */
export const EffectConfirmationKind = z.enum(["user_message", "standing_policy"]);
export type EffectConfirmationKind = z.infer<typeof EffectConfirmationKind>;

/**
 * The payload gate. Authorizing a plan approves a scope; this row is the exact request
 * that scope produced. Only the bytes hashed here can ever be sent.
 */
export const ProposedEffect = z
  .object({
    id: z.number().int(),
    work_run_id: z.number().int(),
    work_step_id: z.number().int(),
    connector_capability_id: z.number().int(),
    effect_kind: WriteEffectKind,
    payload_json: z.string(),
    payload_hash: Sha256Hex,
    preview_text: z.string(),
    reversal_json: z.string().nullable(),
    /** The cached target immediately before the call, when there was one to capture. */
    prior_state_json: z.string().nullable(),
    /** The deterministic conflict check Zeus ran instead of asking. */
    conflict_check_json: z.string().nullable(),
    confirmation_kind: EffectConfirmationKind,
    /** The user's own request. Never a confirmation — it does not name the hash. */
    request_message_id: z.number().int().nullable(),
    status: ProposedEffectStatus,
    idempotency_key: z.string(),
    provider_request_key: z.string(),
    expires_at: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict();
export type ProposedEffect = z.infer<typeof ProposedEffect>;

export const EffectEventType = z.enum([
  "proposed",
  "confirmed",
  /**
   * Authorized by the user's standing direct-execution setting rather than by a message
   * naming the payload hash. Deliberately not `confirmed`: it cites the request, not a
   * confirmation, and the ledger must never claim otherwise.
   */
  "authorized_by_policy",
  "declined",
  "expired",
  "executed",
  "failed",
  "reverted",
]);
export type EffectEventType = z.infer<typeof EffectEventType>;

export const EffectEvent = z
  .object({
    id: z.number().int(),
    proposed_effect_id: z.number().int(),
    event_type: EffectEventType,
    source_message_id: z.number().int().nullable(),
    detail_json: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type EffectEvent = z.infer<typeof EffectEvent>;

export const ExternalSignalKind = z.enum(["calendar_event"]);
export type ExternalSignalKind = z.infer<typeof ExternalSignalKind>;

/**
 * Proof that a window was read, kept separately from what the read returned.
 *
 * An empty calendar and a failed read produce the same empty event set, and a write gate
 * that cannot tell them apart will happily report "nothing conflicts" about a calendar it
 * never saw. This row is what makes that distinction available.
 */
export const ExternalReadWindow = z
  .object({
    id: z.number().int(),
    connector_id: z.number().int(),
    kind: ExternalSignalKind,
    window_from: z.string(),
    window_to: z.string(),
    event_count: z.number().int().nonnegative(),
    fetched_at: z.string(),
  })
  .strict();
export type ExternalReadWindow = z.infer<typeof ExternalReadWindow>;

/**
 * The standing permission to carry out a calendar change without asking each time.
 *
 * It removes the interruption, never the record and never the check: every action still
 * writes a receipt, and the conflict gate still has to clear before this setting applies.
 */
export const CalendarActionSetting = z
  .object({
    id: z.literal(1),
    direct_execution: z.union([z.literal(0), z.literal(1)]),
    daily_limit: z.number().int().min(1).max(50),
    day_start: z.string(),
    day_end: z.string(),
    source_message_id: z.number().int().nullable(),
    updated_at: z.string(),
  })
  .strict();
export type CalendarActionSetting = z.infer<typeof CalendarActionSetting>;

/**
 * How one calendar request ended, decided deterministically rather than read out of prose.
 *
 * The card, the model's sentences, and the stored record all descend from this, so they
 * cannot disagree. Assistant-authored outcome data: never a fact, never evidence, and never
 * supplied as memory — the event titles it carries are somebody else's writing.
 *
 * Note `nearMisses`, which is not a list of what is on the calendar. It is the entries that
 * *failed* the match, kept so a refusal can ask which was meant instead of asserting that
 * the event does not exist. A lookup that missed is not evidence of absence.
 */
export const CalendarOutcomeEvent = z
  .object({
    externalId: z.string(),
    title: z.string().nullable(),
    startsAt: z.string(),
  })
  .strict();

export const CalendarOutcome = z
  .object({
    kind: z.enum(["create", "reschedule", "cancel", "read"]),
    status: z.enum([
      "done",
      "awaiting_confirmation",
      "blocked_by_conflict",
      "ambiguous_target",
      "target_not_found",
      "unverifiable",
      "no_connector",
      "read_only",
      "needs_clarification",
      "failed",
    ]),
    reason: z.string().nullable(),
    note: z.string().nullable(),
    conflicts: z.array(
      z
        .object({
          title: z.string().nullable(),
          startsAt: z.string(),
          endsAt: z.string().nullable(),
        })
        .strict(),
    ),
    alternatives: z.array(z.object({ startsAt: z.string(), endsAt: z.string() }).strict()),
    candidates: z.array(CalendarOutcomeEvent),
    nearMisses: z.array(CalendarOutcomeEvent),
    consideredEvents: z.number().nullable(),
    coverage: z
      .object({
        from: z.string(),
        to: z.string(),
        fetchedAt: z.string(),
        eventCount: z.number().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CalendarOutcome = z.infer<typeof CalendarOutcome>;

export const ScheduleSnapshotEvent = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    location: z.string().nullable(),
    allDay: z.boolean(),
    inProgress: z.boolean(),
  })
  .strict();
export type ScheduleSnapshotEvent = z.infer<typeof ScheduleSnapshotEvent>;

/**
 * The standing schedule context a chat turn rendered for the model, kept with the turn.
 *
 * External, untrusted, disposable data — never memory and never evidence. Stored beside the
 * calendar outcome for the same reason that is: the cache it was rendered from expires and
 * reconciles, so without this snapshot "Why did Zeus say that?" stops being answerable the
 * hour after Zeus said it. Titles and locations are stored post-guard, so a withheld line
 * stays withheld in the record too.
 */
export const ScheduleSnapshot = z
  .object({
    state: z.enum(["current", "stale", "unread"]),
    asOf: z.string().nullable(),
    window: z.object({ from: z.string(), to: z.string() }).strict().nullable(),
    /** The events actually shown, post-guard; capped, so this is not the whole window. */
    events: z.array(ScheduleSnapshotEvent),
    eventsShown: z.number().int().min(0),
    eventsTotal: z.number().int().min(0),
    withheld: z.boolean(),
  })
  .strict();
export type ScheduleSnapshot = z.infer<typeof ScheduleSnapshot>;

/**
 * A disposable copy of what a connector reported. Never evidence: an invite someone else
 * wrote is not the user speaking, so it may shape a plan but can never become memory.
 */
export const ExternalSignal = z
  .object({
    id: z.number().int(),
    connector_id: z.number().int(),
    kind: ExternalSignalKind,
    external_id: z.string(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    location: z.string().nullable(),
    payload_json: z.string(),
    fetched_at: z.string(),
    expires_at: z.string(),
  })
  .strict();
export type ExternalSignal = z.infer<typeof ExternalSignal>;

export const DetectorKind = z.enum([
  "calendar_overlap",
  "travel_gap",
  "deadline_collision",
  "commitment_unscheduled",
]);
export type DetectorKind = z.infer<typeof DetectorKind>;

export const DetectedSignal = z
  .object({
    id: z.number().int(),
    detector: DetectorKind,
    dedupe_key: z.string(),
    subject_json: z.string(),
    commitment_id: z.number().int().nullable(),
    severity: z.number().int().min(0).max(100),
    why: z.string(),
    suggested_action: z.string(),
    effect_kind: EffectKind,
    occurs_at: z.string().nullable(),
    detected_at: z.string(),
    snoozed_until: z.string().nullable(),
    last_surfaced_at: z.string().nullable(),
    resolved_at: z.string().nullable(),
  })
  .strict();
export type DetectedSignal = z.infer<typeof DetectedSignal>;

export const SignalEvent = z
  .object({
    id: z.number().int(),
    detected_signal_id: z.number().int(),
    event_type: FollowThroughEventType,
    detail_json: z.string().nullable(),
    response_message_id: z.number().int().nullable(),
    source_message_id: z.number().int().nullable(),
    source_kind: z.enum(["system", "message", "user_action"]),
    created_at: z.string(),
  })
  .strict();
export type SignalEvent = z.infer<typeof SignalEvent>;

export const WorkStepDefinition = z
  .object({
    title: z.string().trim().min(1).max(200),
    instruction: z.string().trim().min(1).max(4000),
    effect_kind: EffectKind,
    depends_on: z.array(z.number().int().positive()).default([]),
  })
  .strict();
export type WorkStepDefinition = z.infer<typeof WorkStepDefinition>;

export const WorkPlanProposal = z
  .object({
    objective: z.string().trim().min(1).max(2000),
    steps: z.array(WorkStepDefinition).min(1).max(12),
    allowed_effects: z.array(EffectKind).min(1),
    completion_criteria: z.array(z.string().trim().min(1).max(1000)).min(1),
    limits: z
      .object({
        max_model_tool_calls: z.number().int().min(1).max(20).default(20),
        max_retries_per_step: z.number().int().min(0).max(2).default(2),
        max_duration_seconds: z.number().int().min(1).max(900).default(900),
      })
      .strict(),
  })
  .strict();
export type WorkPlanProposal = z.infer<typeof WorkPlanProposal>;

export const AmbientSetting = z
  .object({
    id: z.literal(1),
    enabled: z.number().int().min(0).max(1),
    timezone: z.string(),
    quiet_start: LocalClockTime,
    quiet_end: LocalClockTime,
    daily_limit: z.literal(1),
    channels_json: z.string(),
    location_consent: z.number().int().min(0).max(1),
    source_message_id: z.number().int().nullable(),
    updated_at: z.string(),
  })
  .strict();
export type AmbientSetting = z.infer<typeof AmbientSetting>;

export const CoarseLocation = z
  .object({
    id: z.literal(1),
    zone_id: z.string(),
    observed_at: z.string(),
    expires_at: z.string(),
    created_at: z.string(),
  })
  .strict();
export type CoarseLocation = z.infer<typeof CoarseLocation>;

export const AmbientDeliveryAttempt = z
  .object({
    id: z.number().int(),
    opportunity_id: z.number().int(),
    channel: z.literal("macos"),
    local_day: z.string(),
    claim_slot: z.string().nullable(),
    lease_token: z.string(),
    status: z.enum(["claimed", "succeeded", "failed", "unknown"]),
    leased_until: z.string(),
    notifier_started_at: z.string(),
    completed_at: z.string().nullable(),
    error_code: z.string().nullable(),
    delivery_id: z.number().int().nullable(),
    created_at: z.string(),
  })
  .strict();
export type AmbientDeliveryAttempt = z.infer<typeof AmbientDeliveryAttempt>;

/** A fact joined to the names it references — what the UI and prompt builder consume. */
export const FactView = Fact.extend({
  subject_name: z.string(),
  subject_slug: z.string(),
  object_entity_name: z.string().nullable(),
  object_entity_slug: z.string().nullable(),
}).strict();
export type FactView = z.infer<typeof FactView>;

// ---------------------------------------------------------------------------
// Extraction — the shape the model must return
// ---------------------------------------------------------------------------

/**
 * Sentinel subject meaning "the user". The model is told to use this rather than
 * guessing the user's name, which it usually does not know.
 */
export const SELF_REF = "self";

export const ExtractedEntity = z
  .object({
    name: z
      .string()
      .describe("Canonical display name, e.g. 'Sarah Chen', 'Project Apollo', 'rock climbing'"),
    kind: EntityKind.describe(
      "person for humans; org for companies; project for named efforts; place for locations; topic for subjects the user tracks; thing for anything else",
    ),
    aliases: z
      .array(z.string())
      .describe(
        "Other names used for this entity in the conversation, e.g. ['Sarah', 'sarah chen']. Empty array if none.",
      ),
  })
  .strict();
export type ExtractedEntity = z.infer<typeof ExtractedEntity>;

export const ExtractionExplicitness = z.enum(["explicit", "inferred"]);
export type ExtractionExplicitness = z.infer<typeof ExtractionExplicitness>;

export const ExtractionSensitivity = z.enum(["normal", "sensitive"]);
export type ExtractionSensitivity = z.infer<typeof ExtractionSensitivity>;

export const ExtractionAmbiguity = z.enum(["clear", "ambiguous"]);
export type ExtractionAmbiguity = z.infer<typeof ExtractionAmbiguity>;

const TrustFields = {
  grounding: z
    .enum(["user_statement", "assistant_only"])
    .default("user_statement")
    .describe(
      "user_statement only when the user stated or endorsed it; assistant_only when it appears solely in assistant text",
    ),
  explicitness: ExtractionExplicitness.default("explicit").describe(
    "explicit when the user directly stated it; inferred when it requires interpretation",
  ),
  sensitivity: ExtractionSensitivity.default("normal").describe(
    "sensitive for health, finances, legal matters, intimate identity, credentials, or private secrets",
  ),
  ambiguity: ExtractionAmbiguity.default("clear").describe(
    "ambiguous when the subject, meaning, date, owner, or intended permanence is unclear",
  ),
};

export const ExtractionEvidence = z
  .object({
    source_message_id: z
      .number()
      .int()
      .describe("ID printed beside the USER EVIDENCE message containing this exact claim."),
    quote: z
      .string()
      .describe("Exact contiguous quote copied from that user message; never paraphrased."),
  })
  .strict();
export type ExtractionEvidence = z.infer<typeof ExtractionEvidence>;

/**
 * An extracted update must say whether a field is unchanged, assigned, or
 * explicitly cleared. In particular, `null` is not allowed to carry both the
 * meanings "the user said no value" and "the model did not hear an update".
 */
export type FieldPatch<T> =
  | { op: "keep" }
  | { op: "set"; value: T }
  | { op: "clear" };

export function FieldPatchSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("op", [
    z.object({ op: z.literal("keep") }).strict(),
    z.object({ op: z.literal("set"), value }).strict(),
    z.object({ op: z.literal("clear") }).strict(),
  ]);
}

export const ExtractedFact = z
  .object({
    subject: z
      .string()
      .describe(
        `Name of the entity this fact is about. Use "${SELF_REF}" for facts about the user themselves.`,
      ),
    predicate: z
      .string()
      .describe(
        "snake_case relation. Prefer an existing predicate from the provided list; invent one only when none fits.",
      ),
    object: z
      .string()
      .describe("The value, as a short natural-language phrase. Never a full sentence."),
    object_entity: z
      .string()
      .nullable()
      .describe(
        "If the object is itself an entity in the entities array, its name. Otherwise null. This is what makes the memory a graph.",
      ),
    operation: z
      .enum(["assert", "retract"])
      .default("assert")
      .describe(
        "Use retract only when the user explicitly says this exact multi-valued fact is no longer true; otherwise assert.",
      ),
    confidence: z
      .number()
      .describe(
        "0.0-1.0. Use 0.9+ only for facts the user stated plainly about themselves; lower for inference or hearsay.",
      ),
    supersedes_previous: z
      .boolean()
      .describe(
        "True only when the user is explicitly correcting or replacing something previously true (e.g. 'I left Acme, I'm at Beta now').",
      ),
    effective_from: z
      .string()
      .nullable()
      .default(null)
      .describe("ISO date/time when the fact became true if the user stated it, otherwise null."),
    evidence: z
      .array(ExtractionEvidence)
      .default([])
      .describe("Exact user-message evidence for this claim. Direct facts need one source."),
    ...TrustFields,
  })
  .strict();
export type ExtractedFact = z.input<typeof ExtractedFact>;

export const ExtractedProjectLink = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("id"), id: z.number().int() })
    .strict()
    .describe("An existing project from the supplied active-project list."),
  z
    .object({ kind: z.literal("name"), name: z.string().min(1) })
    .strict()
    .describe("A named project entity declared in this extraction."),
]);
export type ExtractedProjectLink = z.infer<typeof ExtractedProjectLink>;

export const ExtractedGoal = z
  .object({
    existing_id: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe("ID from the supplied active-goal list when updating one; null for a new goal."),
    title: z.string().describe("Short goal title in the user's own terms."),
    status: GoalStatus.describe("The goal state established by this user message."),
    priority: FieldPatchSchema(GoalPriority)
      .describe(
        "For an update, keep unless the user explicitly changes priority; set to low, normal, or high when stated; clear resets it to normal. For a new goal, set when stated and otherwise clear.",
      ),
    target_at: FieldPatchSchema(z.string()).describe(
      "For an update, keep unless the user changes the target; set to a user-supplied ISO date/time; clear only when the user removes it. For a new goal, set when supplied and otherwise clear.",
    ),
    project: FieldPatchSchema(ExtractedProjectLink).describe(
      "For an update, keep unless the project link changes; set by existing project ID or a declared project entity name; clear only when the user removes the link. For a new goal, set when linked and otherwise clear.",
    ),
    evidence: z.array(ExtractionEvidence).default([]),
    confidence: z.number().describe("Confidence that the user expressed this goal or update."),
    ...TrustFields,
  })
  .strict();
type ModelExtractedGoal = z.input<typeof ExtractedGoal>;
/** Also accepts the former nullable fields at the deterministic apply boundary. */
export type ExtractedGoal = Omit<ModelExtractedGoal, "priority" | "target_at" | "project"> & {
  priority?: ModelExtractedGoal["priority"] | GoalPriority | null;
  target_at?: ModelExtractedGoal["target_at"] | string | null;
  project?: ModelExtractedGoal["project"];
  project_id?: number | null;
  project_name?: string | null;
};

export const ExtractedGoalLink = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("id"), id: z.number().int() })
    .strict()
    .describe("An existing goal from the supplied active-goal list."),
  z
    .object({ kind: z.literal("title"), title: z.string() })
    .strict()
    .describe("A goal first created in this same extraction, identified by its exact title."),
]);
export type ExtractedGoalLink = z.infer<typeof ExtractedGoalLink>;

export const ExtractedCommitment = z
  .object({
    existing_id: z
      .number()
      .int()
      .nullable()
      .default(null)
      .describe("ID from the supplied open-commitment list when updating one; null for a new commitment."),
    title: z.string().describe("Concrete commitment or next action in the user's own terms."),
    owner: FieldPatchSchema(z.string()).describe(
      `For an update, keep unless ownership changes; set to the owner's entity name (or "${SELF_REF}" for the user); clear resets ownership to "${SELF_REF}". For a new commitment, set a stated owner and otherwise clear.`,
    ),
    linked_goal: FieldPatchSchema(ExtractedGoalLink).describe(
      "For an update, keep unless the link changes; set by an existing goal ID or the exact title of a goal created in this extraction; clear only when the user removes the link. For a new commitment, set when linked and otherwise clear.",
    ),
    status: CommitmentStatus.describe("The commitment state established by this user message."),
    due_at: FieldPatchSchema(z.string()).describe(
      "For an update, keep unless the due date changes; set to a user-supplied ISO date/time; clear only when the user removes it. For a new commitment, set when supplied and otherwise clear.",
    ),
    project: FieldPatchSchema(ExtractedProjectLink).describe(
      "For an update, keep unless the project link changes; set by existing project ID or a declared project entity name; clear only when the user removes the link. For a new commitment, set when linked and otherwise clear.",
    ),
    evidence: z.array(ExtractionEvidence).default([]),
    confidence: z.number().describe("Confidence that the user expressed this commitment or update."),
    ...TrustFields,
  })
  .strict();
type ModelExtractedCommitment = z.input<typeof ExtractedCommitment>;
/** Also accepts the former owner/link/date fields at the deterministic apply boundary. */
export type ExtractedCommitment = Omit<
  ModelExtractedCommitment,
  "owner" | "linked_goal" | "due_at" | "project"
> & {
  owner?: ModelExtractedCommitment["owner"] | string;
  linked_goal?: ModelExtractedCommitment["linked_goal"];
  linked_goal_id?: number | null;
  linked_goal_title?: string | null;
  due_at?: ModelExtractedCommitment["due_at"] | string | null;
  project?: ModelExtractedCommitment["project"];
  project_id?: number | null;
  project_name?: string | null;
};

export const ExtractedFacetScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("domain"), label: z.string() }).strict(),
  z.object({ kind: z.literal("entity"), name: z.string() }).strict(),
  z.object({ kind: z.literal("goal"), id: z.number().int() }).strict(),
  z.object({ kind: z.literal("commitment"), id: z.number().int() }).strict(),
]);
export type ExtractedFacetScope = z.infer<typeof ExtractedFacetScope>;

export const ExtractedFacet = z
  .object({
    kind: FacetKind,
    statement: z
      .string()
      .describe("A concise, corrigible statement in the user's terms; never a diagnosis or personality label."),
    scope: ExtractedFacetScope,
    condition: z.string().nullable().default(null),
    structured_condition: StructuredFacetCondition.nullable()
      .default(null)
      .describe(
        "Typed weekday, local-time, named-zone, or expiry conditions. Use only details the user explicitly supplied.",
      ),
    importance: FacetImportance.default("normal"),
    machine_effect: FacetMachineEffect.nullable()
      .default(null)
      .describe("Only when the user explicitly asks Zeus to boost, deprioritize, or block this scope."),
    confidence: z.number(),
    effective_from: z.string().nullable().default(null),
    evidence: z
      .array(ExtractionEvidence)
      .describe("Exact user evidence. A recurring inferred pattern requires at least two distinct messages."),
    ...TrustFields,
  })
  .strict();
export type ExtractedFacet = z.input<typeof ExtractedFacet>;

export const FacetCandidatePayload = z
  .object({
    item: ExtractedFacet,
    entities: z.array(ExtractedEntity).default([]),
    conflict_preview: z.array(z.string()).default([]),
    supersedes_facet_ids: z.array(z.number().int()).default([]),
  })
  .strict();
export type FacetCandidatePayload = z.input<typeof FacetCandidatePayload>;

export const SourceAssessment = z
  .object({
    source_message_id: z.number().int(),
    sensitivity: z.enum(["normal", "sensitive", "uncertain"]),
    sensitive_quotes: z
      .array(z.string())
      .describe("Exact sensitive excerpts. Empty only when sensitivity is normal."),
  })
  .strict();
export type SourceAssessment = z.infer<typeof SourceAssessment>;

export const Extraction = z
  .object({
    entities: z
      .array(ExtractedEntity)
      .describe(
        "Every entity referenced by a fact or commitment below. Omit entities that no extracted item uses.",
      ),
    facts: z
      .array(ExtractedFact)
      .describe(
        "Durable facts worth remembering months from now. Extract nothing rather than something trivial or transient.",
      ),
    goals: z
      .array(ExtractedGoal)
      .default([])
      .describe("Longer-lived outcomes the user is trying to achieve, including explicit status changes."),
    commitments: z
      .array(ExtractedCommitment)
      .default([])
      .describe("Concrete promises, next actions, waiting items, and explicit status changes."),
    facets: z
      .array(ExtractedFacet)
      .default([])
      .describe("Whole-person understanding: values, contextual preferences, constraints, styles, motivations, routines, boundaries, skills, and relationship dynamics."),
    source_assessments: z
      .array(SourceAssessment)
      .default([])
      .describe("Privacy classification for every user-evidence message supplied."),
  })
  .strict();
/** Input form keeps defaults optional so fixture extractions remain concise. */
type ModelExtraction = z.input<typeof Extraction>;
export type Extraction = Omit<ModelExtraction, "goals" | "commitments"> & {
  goals?: ExtractedGoal[];
  commitments?: ExtractedCommitment[];
};
export type ParsedExtraction = z.output<typeof Extraction>;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const SearchHit = z
  .object({
    fact: FactView,
    score: z.number(),
    /** Which retrieval paths surfaced this — useful when debugging bad recall. */
    via: z.array(z.enum(["lexical", "semantic", "graph"])),
  })
  .strict();
export type SearchHit = z.infer<typeof SearchHit>;

export const EpisodeHit = z
  .object({
    passage_id: z.number().int().nullable().default(null),
    start_offset: z.number().int().nonnegative().nullable().default(null),
    end_offset: z.number().int().positive().nullable().default(null),
    message: Message,
    conversation_title: z.string().nullable(),
    excerpt: z.string(),
    score: z.number(),
    via: z.array(z.enum(["lexical", "semantic"])),
  })
  .strict();
export type EpisodeHit = z.infer<typeof EpisodeHit>;

export const RecallItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fact"), fact: FactView, evidence: z.array(FactEvidence) }).strict(),
  z.object({ kind: z.literal("episode"), episode: EpisodeHit }).strict(),
  z.object({ kind: z.literal("goal"), goal: Goal }).strict(),
  z.object({ kind: z.literal("commitment"), commitment: CommitmentView }).strict(),
  z.object({ kind: z.literal("project"), project: ProjectView }).strict(),
  z
    .object({
      kind: z.literal("facet"),
      facet: UnderstandingFacetView,
      evidence: z.array(FacetEvidence),
    })
    .strict(),
]);
export type RecallItem = z.infer<typeof RecallItem>;

export const ContextIntent = z.enum([
  "factual",
  "historical",
  "relational",
  "advisory",
  "decision",
  "follow_through",
]);
export type ContextIntent = z.infer<typeof ContextIntent>;

export const ContextSelection = z
  .object({
    item: RecallItem,
    reason: z.enum(["interaction_contract", "query_relevant", "historical", "open_loop", "follow_through"]),
    score: z.number(),
    via: z.array(z.enum(["lexical", "semantic", "graph", "core", "policy"])),
    estimated_tokens: z.number().int().nonnegative(),
  })
  .strict();
export type ContextSelection = z.infer<typeof ContextSelection>;

export const ContextPlan = z
  .object({
    intent: ContextIntent,
    budget_tokens: z.number().int().positive(),
    estimated_tokens: z.number().int().nonnegative(),
    selections: z.array(ContextSelection),
  })
  .strict();
export type ContextPlan = z.infer<typeof ContextPlan>;

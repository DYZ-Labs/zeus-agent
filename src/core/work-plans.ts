import { createHash, randomUUID } from "node:crypto";

import { availableCapabilityForEffect, isConnectorEffect } from "./connectors";
import { parseWorkPlanApproval } from "./confirmation-text";
import type { Db } from "./db";
import { now } from "./db";
import { logEvent } from "./observability";
import { accountEvent } from "./owner";
import type {
  EffectKind,
  EvaluationContext,
  ToolName,
  ToolReceipt,
  WorkArtifact,
  WorkArtifactKind,
  WorkAuthorization,
  WorkPlanGenerationContext,
  WorkPlanMemorySource,
  WorkPlanMemorySourceKind,
  WorkPlan,
  WorkPlanProposal,
  WorkRun,
  WorkRunStatus,
  WorkStep,
} from "./schema";
import {
  EffectKind as EffectKindSchema,
  EvaluationContext as EvaluationContextSchema,
  WorkPlanProposal as WorkPlanProposalSchema,
} from "./schema";

const MAX_STEPS = 12;
export const MAX_MODEL_TOOL_CALLS = 20;
const MAX_RETRIES_PER_STEP = 2;
const MAX_DURATION_SECONDS = 15 * 60;
const MAX_ARTIFACT_CONTENT = 250_000;
const MAX_RECEIPT_STRING = 20_000;
const MAX_ERROR_MESSAGE = 800;
const RUNNER_LEASE_MS = 60_000;
const RUNNER_HEARTBEAT_MS = 20_000;

export const SAFE_EFFECT_KINDS = [
  "memory_read",
  "web_read",
  "prepare_local",
] as const satisfies readonly EffectKind[];

export type SafeEffectKind = (typeof SAFE_EFFECT_KINDS)[number];
export type WorkPlanOrigin = "explicit_request" | "surfaced_proposal";
export type WorkAuthorizationKind = "explicit_request" | "user_approval";
export type SafeToolName = "memory_recall" | "web_search" | "local_artifact";
export type WorkPlanSourceLinkKind = "goal" | "commitment" | "project";

export type WorkPlanApprovalOffer = {
  planId: number;
  hash: string;
  objective: string;
  steps: Array<{
    position: number;
    title: string;
    instruction: string;
    effect: EffectKind;
    dependsOn: number[];
  }>;
  allowedEffects: EffectKind[];
  completionCriteria: string[];
  limits: {
    modelToolCalls: number;
    retriesPerStep: number;
    durationSeconds: number;
  };
};

export type CreateWorkPlanInput = {
  proposal: WorkPlanProposal;
  sourceMessageId: number;
  sourceGoalId?: number | null;
  sourceCommitmentId?: number | null;
  sourceProjectId?: number | null;
  origin: WorkPlanOrigin;
  generationProvenance?: WorkPlanGenerationProvenanceInput | null;
};

export type WorkPlanMemorySourceInput = {
  sourceKind: WorkPlanMemorySourceKind;
  sourceId: number;
  includedInPrompt: boolean;
  exclusionReason: string | null;
  snapshot: unknown;
  sourceMessageIds: readonly number[];
};

export type WorkPlanConflictSnapshot = {
  item_ids: string[];
  reasons: string[];
};

export type WorkPlanGenerationProvenanceInput = {
  evaluationContext: EvaluationContext;
  conflicts: readonly WorkPlanConflictSnapshot[];
  memorySources: readonly WorkPlanMemorySourceInput[];
};

export type WorkPlanGenerationProvenance = {
  evaluationContext: EvaluationContext;
  conflicts: WorkPlanConflictSnapshot[];
  memorySources: Array<WorkPlanMemorySourceInput & { snapshotJson: string }>;
};

export type AuthorizeWorkPlanInput = {
  planHash: string;
  authorizationKind: WorkAuthorizationKind;
  allowedEffects: readonly EffectKind[];
  maxModelToolCalls: number;
  maxRetriesPerStep: number;
  maxDurationSeconds: number;
  expiresAt: string;
  sourceMessageId: number;
};

export type WorkStepWithDependencies = WorkStep & {
  /** One-based step positions, matching the proposal boundary. */
  depends_on: number[];
};

export type WorkPlanDetail = {
  plan: WorkPlan;
  steps: WorkStepWithDependencies[];
  authorization: WorkAuthorization | null;
  latestRun: WorkRun | null;
};

export type WorkArtifactInput = {
  kind: WorkArtifactKind;
  title: string;
  content: string;
  citations?: readonly unknown[];
  /** Exact accepted user-message sources whose content was used to derive this artifact. */
  sourceMessageIds?: readonly number[];
  /** Exact canonical fact/facet snapshots used directly or through prior artifacts. */
  sourceMemoryItems?: readonly {
    sourceKind: WorkPlanMemorySourceKind;
    sourceId: number;
    snapshot: unknown;
  }[];
};

export type SafeStepExecutionInput = {
  plan: WorkPlan;
  step: WorkStepWithDependencies;
  run: WorkRun;
  attempt: number;
  remainingCallBudget: number;
  idempotencyKey: string;
  /** Stable across retries/recovery so a provider can deduplicate one logical step. */
  providerRequestKey: string;
  /** Aborts when the run deadline, authorization, cancellation, or runner lease changes. */
  signal: AbortSignal;
};

export type SafeStepExecutionResult = {
  output?: unknown;
  citations?: readonly unknown[];
  artifacts?: readonly WorkArtifactInput[];
  modelCalls?: number;
  toolCalls?: number;
  /**
   * A safe executor uses this when it discovers new sensitive context or a scope
   * change. Reauthorization defaults to true: ambiguity must narrow autonomy.
   */
  pause?: {
    code: string;
    message?: string;
    requiresReauthorization?: boolean;
  };
};

export type SafeWorkExecutor = (
  input: SafeStepExecutionInput,
) => Promise<SafeStepExecutionResult>;

export type WorkRunOptions = {
  executor?: SafeWorkExecutor;
};

export class WorkStepExecutionError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly modelCalls: number;
  readonly toolCalls: number;

  constructor(
    message: string,
    options: {
      code?: string;
      transient?: boolean;
      modelCalls?: number;
      toolCalls?: number;
    } = {},
  ) {
    super(message);
    this.name = "WorkStepExecutionError";
    this.code = normalizeCode(options.code ?? "executor_failed");
    this.transient = options.transient ?? false;
    this.modelCalls = boundedCount(options.modelCalls ?? 0, "modelCalls");
    this.toolCalls = boundedCount(options.toolCalls ?? 1, "toolCalls");
  }
}

const SELECT_PLAN = `
  SELECT id, objective, status, plan_hash, hash_version, allowed_effects_json,
         completion_criteria_json, max_steps, max_model_tool_calls,
         max_retries_per_step, max_duration_seconds, source_message_id,
         source_goal_id, source_commitment_id, source_project_id, origin,
         created_at, updated_at, completed_at
  FROM work_plan
`;

const SELECT_STEP = `
  SELECT id, work_plan_id, position, title, instruction, effect_kind, status,
         attempt_count, started_at, completed_at, error_code, error_message
  FROM work_step
`;

const SELECT_AUTHORIZATION = `
  SELECT id, work_plan_id, plan_hash, authorization_kind, allowed_effects_json,
         max_model_tool_calls, max_retries_per_step, max_duration_seconds,
         expires_at, source_message_id, created_at, revoked_at
  FROM work_authorization
`;

const SELECT_RUN = `
  SELECT id, work_plan_id, authorization_id, plan_hash, status,
         model_call_count, tool_call_count, checkpoint_step_id, started_at,
         updated_at, deadline_at, runner_token, runner_lease_until, paused_at,
         paused_ms_total, completed_at, error_code, error_message
  FROM work_run
`;

const SELECT_ARTIFACT = `
  SELECT id, work_plan_id, work_run_id, work_step_id, kind, title, content,
         citations_json, created_at, updated_at
  FROM work_artifact
`;

const SELECT_RECEIPT = `
  SELECT id, work_run_id, work_step_id, tool_name, effect_kind,
         connector_capability_id, proposed_effect_id, call_index,
         input_json, output_json, citations_json, status, error_code,
         error_message, idempotency_key, started_at, completed_at
  FROM tool_receipt
`;

/** Create an immutable, source-backed work proposal. It does not authorize execution. */
export function createWorkPlan(db: Db, input: CreateWorkPlanInput): WorkPlanDetail {
  assertUserMessage(db, input.sourceMessageId);
  const proposal = normalizeProposal(input.proposal);
  assertAuthorizableEffects(db, proposal.allowed_effects);
  assertRunnableLimits(proposal);
  const generationProvenance = input.generationProvenance
    ? normalizeGenerationProvenance(db, input.generationProvenance)
    : null;
  const links = {
    sourceMessageId: input.sourceMessageId,
    sourceInstructionDigest: sourceInstructionDigest(db, input.sourceMessageId),
    sourceGoalId: input.sourceGoalId ?? null,
    sourceCommitmentId: input.sourceCommitmentId ?? null,
    sourceProjectId: input.sourceProjectId ?? null,
    origin: input.origin,
    generationProvenance,
  };
  const planHash = hashNormalizedProposal(proposal, links);
  const existing = db
    .prepare<[string], WorkPlan>(`${SELECT_PLAN} WHERE plan_hash = ?`)
    .get(planHash);
  if (existing) return requireWorkPlanDetail(db, existing.id);

  return db.transaction(() => {
    const timestamp = now();
    const inserted = db
      .prepare<
        [
          string,
          string,
          number,
          string,
          string,
          number,
          number,
          number,
          number,
          number,
          number | null,
          number | null,
          number | null,
          WorkPlanOrigin,
          string,
          string,
        ]
      >(
        `INSERT INTO work_plan
           (objective, status, plan_hash, hash_version, allowed_effects_json,
            completion_criteria_json, max_steps, max_model_tool_calls,
            max_retries_per_step, max_duration_seconds, source_message_id,
            source_goal_id, source_commitment_id, source_project_id, origin,
            created_at, updated_at)
         VALUES (?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.objective,
        planHash,
        generationProvenance === null ? 2 : 3,
        JSON.stringify(proposal.allowed_effects),
        JSON.stringify(proposal.completion_criteria),
        MAX_STEPS,
        proposal.limits.max_model_tool_calls,
        proposal.limits.max_retries_per_step,
        proposal.limits.max_duration_seconds,
        input.sourceMessageId,
        links.sourceGoalId,
        links.sourceCommitmentId,
        links.sourceProjectId,
        input.origin,
        timestamp,
        timestamp,
      );
    const planId = Number(inserted.lastInsertRowid);
    const stepIds: number[] = [];
    const insertStep = db.prepare<
      [number, number, string, string, EffectKind]
    >(
      `INSERT INTO work_step
         (work_plan_id, position, title, instruction, effect_kind, status,
          attempt_count)
       VALUES (?, ?, ?, ?, ?, 'pending', 0)`,
    );
    for (const [index, step] of proposal.steps.entries()) {
      const result = insertStep.run(
        planId,
        index + 1,
        step.title,
        step.instruction,
        step.effect_kind,
      );
      stepIds.push(Number(result.lastInsertRowid));
    }

    const insertDependency = db.prepare<[number, number]>(
      `INSERT INTO work_step_dependency (work_step_id, depends_on_step_id)
       VALUES (?, ?)`,
    );
    for (const [index, step] of proposal.steps.entries()) {
      const stepId = stepIds[index];
      if (stepId === undefined) throw new Error("Work step insertion lost its identifier");
      for (const dependencyPosition of step.depends_on) {
        const dependencyId = stepIds[dependencyPosition - 1];
        if (dependencyId === undefined) {
          throw new Error("Work step dependency points outside the plan");
        }
        insertDependency.run(stepId, dependencyId);
      }
    }

    if (generationProvenance) {
      insertGenerationProvenance(db, planId, generationProvenance, timestamp);
    }

    return requireWorkPlanDetail(db, planId);
  })();
}

/** Stable SHA-256 over the complete executable proposal and its provenance links. */
export function hashWorkPlanProposal(db: Db, input: CreateWorkPlanInput): string {
  const proposal = normalizeProposal(input.proposal);
  const generationProvenance = input.generationProvenance
    ? normalizeGenerationProvenance(db, input.generationProvenance)
    : null;
  return hashNormalizedProposal(proposal, {
    sourceMessageId: input.sourceMessageId,
    sourceInstructionDigest: sourceInstructionDigest(db, input.sourceMessageId),
    sourceGoalId: input.sourceGoalId ?? null,
    sourceCommitmentId: input.sourceCommitmentId ?? null,
    sourceProjectId: input.sourceProjectId ?? null,
    origin: input.origin,
    generationProvenance,
  });
}

export function getWorkPlanGenerationContext(
  db: Db,
  planId: number,
): WorkPlanGenerationContext | null {
  return db.prepare<[number], WorkPlanGenerationContext>(
    `SELECT work_plan_id, evaluation_context_json, conflict_snapshot_json, created_at
     FROM work_plan_generation_context WHERE work_plan_id = ?`,
  ).get(planId) ?? null;
}

export function listWorkPlanMemorySources(db: Db, planId: number): WorkPlanMemorySource[] {
  return db.prepare<[number], WorkPlanMemorySource>(
    `SELECT work_plan_id, source_kind, source_id, included_in_prompt,
            exclusion_reason, snapshot_json
     FROM work_plan_memory_source
     WHERE work_plan_id = ? ORDER BY source_kind, source_id`,
  ).all(planId);
}

/** Read the immutable generation envelope used by hash-version 3 plans. */
export function getWorkPlanGenerationProvenance(
  db: Db,
  planId: number,
): WorkPlanGenerationProvenance | null {
  const context = getWorkPlanGenerationContext(db, planId);
  if (!context) return null;
  const evaluationContext = EvaluationContextSchema.parse(
    JSON.parse(context.evaluation_context_json) as unknown,
  );
  const conflicts = parseConflictSnapshot(context.conflict_snapshot_json);
  const memorySources = listWorkPlanMemorySources(db, planId).map((source) => ({
    sourceKind: source.source_kind,
    sourceId: source.source_id,
    includedInPrompt: source.included_in_prompt === 1,
    exclusionReason: source.exclusion_reason,
    snapshot: JSON.parse(source.snapshot_json) as unknown,
    snapshotJson: source.snapshot_json,
    sourceMessageIds: db.prepare<
      [number, WorkPlanMemorySourceKind, number],
      { source_message_id: number }
    >(
      `SELECT source_message_id FROM work_plan_memory_source_message
       WHERE work_plan_id = ? AND source_kind = ? AND source_id = ?
       ORDER BY source_message_id`,
    ).all(planId, source.source_kind, source.source_id).map((row) => row.source_message_id),
  }));
  return { evaluationContext, conflicts, memorySources };
}

/** Explicit forget paths use this before deleting a fact/facet dependency. */
export function deleteWorkPlansForMemorySource(
  db: Db,
  sourceKind: WorkPlanMemorySourceKind,
  sourceId: number,
): number {
  const result = db.prepare<
    [WorkPlanMemorySourceKind, number, WorkPlanMemorySourceKind, number]
  >(
    `DELETE FROM work_plan
     WHERE id IN (
       SELECT work_plan_id FROM work_plan_memory_source
       WHERE source_kind = ? AND source_id = ?
       UNION
       SELECT artifact.work_plan_id
       FROM work_artifact_memory_source source
       JOIN work_artifact artifact ON artifact.id = source.work_artifact_id
       WHERE source.source_kind = ? AND source.source_id = ?
     )`,
  ).run(sourceKind, sourceId, sourceKind, sourceId);
  return result.changes;
}

export function getWorkPlan(db: Db, id: number): WorkPlanDetail | null {
  const plan = db.prepare<[number], WorkPlan>(`${SELECT_PLAN} WHERE id = ?`).get(id);
  if (!plan) return null;
  return workPlanDetail(db, plan);
}

export function listWorkPlans(
  db: Db,
  options: { includeClosed?: boolean; limit?: number } = {},
): WorkPlan[] {
  const where = options.includeClosed
    ? ""
    : "WHERE status NOT IN ('completed','cancelled')";
  return db
    .prepare<[number], WorkPlan>(
      `${SELECT_PLAN} ${where}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(options.limit ?? 100);
}

/** The newest unapproved plan proposed from a message in this conversation. */
export function pendingWorkPlanApproval(
  db: Db,
  conversationId: number,
): WorkPlanDetail | null {
  const row = db.prepare<
    [number],
    { id: number }
  >(
    `SELECT plan.id
     FROM work_plan plan
     JOIN message source ON source.id = plan.source_message_id
     WHERE source.conversation_id = ? AND plan.status = 'proposed'
     ORDER BY plan.updated_at DESC, plan.id DESC
     LIMIT 1`,
  ).get(conversationId);
  return row ? getWorkPlan(db, row.id) : null;
}

/** The exact immutable scope the chat must show before it offers approval. */
export function pendingWorkPlanApprovalOffer(
  db: Db,
  conversationId: number,
): WorkPlanApprovalOffer | null {
  const detail = pendingWorkPlanApproval(db, conversationId);
  if (!detail) return null;
  return {
    planId: detail.plan.id,
    hash: detail.plan.plan_hash,
    objective: detail.plan.objective,
    steps: detail.steps.map((step) => ({
      position: step.position,
      title: step.title,
      instruction: step.instruction,
      effect: step.effect_kind,
      dependsOn: step.depends_on,
    })),
    allowedEffects: parseEffects(detail.plan.allowed_effects_json),
    completionCriteria: parseStringArray(detail.plan.completion_criteria_json),
    limits: {
      modelToolCalls: detail.plan.max_model_tool_calls,
      retriesPerStep: detail.plan.max_retries_per_step,
      durationSeconds: detail.plan.max_duration_seconds,
    },
  };
}

/** The exact proposed plan named by an approval message in this conversation, if any. */
export function workPlanForApprovalMessage(
  db: Db,
  conversationId: number,
  content: string,
  options: { mustRun?: boolean } = {},
): WorkPlanDetail | null {
  const approval = parseWorkPlanApproval(content);
  if (!approval || (options.mustRun && !approval.run)) return null;
  const rows = db.prepare<
    [number],
    { id: number; plan_hash: string }
  >(
    `SELECT plan.id, plan.plan_hash
     FROM work_plan plan
     JOIN message source ON source.id = plan.source_message_id
     WHERE source.conversation_id = ? AND plan.status = 'proposed'
     ORDER BY plan.updated_at DESC, plan.id DESC
     LIMIT 100`,
  ).all(conversationId);
  const matches = rows.filter((row) => approval.hash === row.plan_hash.toLowerCase());
  return matches.length === 1 ? getWorkPlan(db, matches[0]!.id) : null;
}

export function workSteps(db: Db, planId: number): WorkStepWithDependencies[] {
  const steps = db
    .prepare<[number], WorkStep>(
      `${SELECT_STEP} WHERE work_plan_id = ? ORDER BY position, id`,
    )
    .all(planId);
  if (steps.length === 0) return [];
  const positionById = new Map(steps.map((step) => [step.id, step.position]));
  const rows = db
    .prepare<
      [number],
      { work_step_id: number; depends_on_step_id: number }
    >(
      `SELECT d.work_step_id, d.depends_on_step_id
       FROM work_step_dependency d
       JOIN work_step s ON s.id = d.work_step_id
       WHERE s.work_plan_id = ?
       ORDER BY d.work_step_id, d.depends_on_step_id`,
    )
    .all(planId);
  const byStep = new Map<number, number[]>();
  for (const row of rows) {
    const position = positionById.get(row.depends_on_step_id);
    if (position === undefined) continue;
    const dependencies = byStep.get(row.work_step_id) ?? [];
    dependencies.push(position);
    byStep.set(row.work_step_id, dependencies);
  }
  return steps.map((step) => ({
    ...step,
    depends_on: (byStep.get(step.id) ?? []).sort((a, b) => a - b),
  }));
}

export function getWorkAuthorization(db: Db, id: number): WorkAuthorization | null {
  return (
    db
      .prepare<[number], WorkAuthorization>(
        `${SELECT_AUTHORIZATION} WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function activeWorkAuthorization(
  db: Db,
  planId: number,
): WorkAuthorization | null {
  return (
    db
      .prepare<[number], WorkAuthorization>(
        `${SELECT_AUTHORIZATION}
         WHERE work_plan_id = ? AND revoked_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(planId) ?? null
  );
}

/**
 * Authorize exactly the immutable plan hash, safe effects, and non-escalating limits.
 * A new authorization revokes but never overwrites the prior audit record.
 */
export function authorizeWorkPlan(
  db: Db,
  planId: number,
  input: AuthorizeWorkPlanInput,
): WorkAuthorization {
  assertUserMessage(db, input.sourceMessageId);
  const detail = requireWorkPlanDetail(db, planId);
  if (detail.plan.status === "completed" || detail.plan.status === "cancelled") {
    throw new Error(`A ${detail.plan.status} work plan cannot be authorized`);
  }
  assertStoredPlanHash(db, detail);
  if (input.planHash !== detail.plan.plan_hash) {
    throw new Error("Authorization does not match the exact work plan hash");
  }
  if (
    input.authorizationKind === "explicit_request" &&
    input.sourceMessageId !== detail.plan.source_message_id
  ) {
    throw new Error("Explicit-request authorization must use the plan's source message");
  }
  if (input.authorizationKind === "user_approval") {
    assertExactApprovalMessage(db, input.sourceMessageId, detail.plan.plan_hash);
  }

  const expiresAt = normalizeFutureDate(input.expiresAt, "authorization expiry");
  const planEffects = parseEffects(detail.plan.allowed_effects_json);
  const allowedEffects = uniqueEffects(input.allowedEffects);
  assertAuthorizableEffects(db, allowedEffects);
  if (!sameStringSet(planEffects, allowedEffects)) {
    throw new Error("Authorization effects must exactly match the work plan effects");
  }
  const limits = validateAuthorizationLimits(detail.plan, input);

  const existing = activeWorkAuthorization(db, planId);
  if (
    existing &&
    existing.plan_hash === input.planHash &&
    existing.authorization_kind === input.authorizationKind &&
    existing.allowed_effects_json === JSON.stringify(allowedEffects) &&
    existing.max_model_tool_calls === limits.maxModelToolCalls &&
    existing.max_retries_per_step === limits.maxRetriesPerStep &&
    existing.max_duration_seconds === limits.maxDurationSeconds &&
    existing.expires_at === expiresAt &&
    existing.source_message_id === input.sourceMessageId
  ) {
    return existing;
  }

  return db.transaction(() => {
    const timestamp = now();
    if (existing) {
      db.prepare<[string, number]>(
        "UPDATE work_authorization SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      ).run(timestamp, existing.id);
    }
    const inserted = db
      .prepare<
        [
          number,
          string,
          WorkAuthorizationKind,
          string,
          number,
          number,
          number,
          string,
          number,
          string,
        ]
      >(
        `INSERT INTO work_authorization
           (work_plan_id, plan_hash, authorization_kind, allowed_effects_json,
            max_model_tool_calls, max_retries_per_step, max_duration_seconds,
            expires_at, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        planId,
        input.planHash,
        input.authorizationKind,
        JSON.stringify(allowedEffects),
        limits.maxModelToolCalls,
        limits.maxRetriesPerStep,
        limits.maxDurationSeconds,
        expiresAt,
        input.sourceMessageId,
        timestamp,
      );
    db.prepare<[string, number]>(
      `UPDATE work_plan SET status = 'authorized', updated_at = ?, completed_at = NULL
       WHERE id = ?`,
    ).run(timestamp, planId);
    db.prepare<[number]>(
      `UPDATE work_step
       SET status = 'pending', attempt_count = 0, started_at = NULL,
           completed_at = NULL, error_code = NULL, error_message = NULL
       WHERE work_plan_id = ? AND status = 'failed'`,
    ).run(planId);
    const authorization = getWorkAuthorization(db, Number(inserted.lastInsertRowid));
    if (!authorization) throw new Error("Work authorization vanished after insertion");
    return authorization;
  })();
}

export function revokeWorkAuthorization(db: Db, planId: number): boolean {
  const result = db.prepare<[string, number]>(
    `UPDATE work_authorization SET revoked_at = ?
     WHERE work_plan_id = ? AND revoked_at IS NULL`,
  ).run(now(), planId);
  return result.changes > 0;
}

/**
 * Invalidate plans whose exact hash covers a lifecycle link that is about to change.
 * The old hash is retained as audit data: rewriting it would make a prior authorization
 * appear to cover a different scope. Active runs pause at their durable checkpoint and
 * every authorization is revoked before the foreign-key link is changed.
 */
export function invalidateWorkPlansForSourceLink(
  db: Db,
  kind: WorkPlanSourceLinkKind,
  sourceId: number,
): number {
  const column = kind === "goal"
    ? "source_goal_id"
    : kind === "commitment"
      ? "source_commitment_id"
      : "source_project_id";
  const planIds = db
    .prepare<[number], { id: number }>(
      `SELECT id FROM work_plan WHERE ${column} = ? ORDER BY id`,
    )
    .all(sourceId)
    .map((row) => row.id);
  if (planIds.length === 0) return 0;

  return db.transaction(() => {
    const timestamp = now();
    const code = "scope_invalidated";
    const message = `The plan's source ${kind} changed or was deleted`;
    for (const planId of planIds) {
      db.prepare<[string, number]>(
        `UPDATE work_authorization SET revoked_at = ?
         WHERE work_plan_id = ? AND revoked_at IS NULL`,
      ).run(timestamp, planId);
      db.prepare<[string, string, string, number]>(
        `UPDATE work_run
         SET status = 'paused', error_code = ?, error_message = ?, updated_at = ?,
             runner_token = NULL, runner_lease_until = NULL
         WHERE work_plan_id = ? AND status IN ('queued','running','paused')`,
      ).run(code, message, timestamp, planId);
      db.prepare<[string, string, string, number]>(
        `UPDATE tool_receipt
         SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?
         WHERE work_run_id IN (
           SELECT id FROM work_run WHERE work_plan_id = ?
         ) AND status = 'started'`,
      ).run(code, message, timestamp, planId);
      db.prepare<[string, string, number]>(
        `UPDATE work_step
         SET status = 'pending', error_code = ?, error_message = ?, started_at = NULL
         WHERE work_plan_id = ? AND status = 'running'`,
      ).run(code, message, planId);
      db.prepare<[string, number]>(
        `UPDATE work_plan SET status = 'paused', updated_at = ?, completed_at = NULL
         WHERE id = ? AND status NOT IN ('completed','cancelled')`,
      ).run(timestamp, planId);
    }
    return planIds.length;
  })();
}

export function getWorkRun(db: Db, id: number): WorkRun | null {
  return db.prepare<[number], WorkRun>(`${SELECT_RUN} WHERE id = ?`).get(id) ?? null;
}

export function listWorkRuns(db: Db, planId: number): WorkRun[] {
  return db
    .prepare<[number], WorkRun>(
      `${SELECT_RUN} WHERE work_plan_id = ? ORDER BY id DESC`,
    )
    .all(planId);
}

export function listWorkArtifacts(
  db: Db,
  options: { planId?: number; runId?: number } = {},
): WorkArtifact[] {
  if (options.runId !== undefined) {
    return db
      .prepare<[number], WorkArtifact>(
        `${SELECT_ARTIFACT} WHERE work_run_id = ? ORDER BY id`,
      )
      .all(options.runId);
  }
  if (options.planId !== undefined) {
    return db
      .prepare<[number], WorkArtifact>(
        `${SELECT_ARTIFACT} WHERE work_plan_id = ? ORDER BY id`,
      )
      .all(options.planId);
  }
  return db
    .prepare<[], WorkArtifact>(`${SELECT_ARTIFACT} ORDER BY id DESC LIMIT 200`)
    .all();
}

export function getWorkArtifact(db: Db, id: number): WorkArtifact | null {
  return db.prepare<[number], WorkArtifact>(`${SELECT_ARTIFACT} WHERE id = ?`).get(id) ?? null;
}

export function listToolReceipts(db: Db, runId: number): ToolReceipt[] {
  return db
    .prepare<[number], ToolReceipt>(
      `${SELECT_RECEIPT} WHERE work_run_id = ? ORDER BY call_index, id`,
    )
    .all(runId);
}

/**
 * Begin an authorized run and carry it as far as the granted capabilities allow. Without a
 * capability, or when a write step needs the user's word on its payload, Zeus durably
 * pauses; it never substitutes an arbitrary capability and never proceeds unconfirmed.
 */
export async function runWorkPlan(
  db: Db,
  planId: number,
  options: WorkRunOptions = {},
): Promise<WorkRun> {
  const selected = db.transaction((): { run: WorkRun; created: boolean } => {
    const existing = latestResumableRun(db, planId);
    if (existing) {
      const activeAuthorization = activeWorkAuthorization(db, planId);
      if (activeAuthorization?.id === existing.authorization_id) {
        return { run: existing, created: false };
      }
      closeSupersededRun(db, existing);
    }
    const detail = requireWorkPlanDetail(db, planId);
    assertStoredPlanHash(db, detail);
    if (detail.plan.status !== "authorized") {
      throw new Error("Work plan must have an active exact authorization before it can run");
    }
    const authorization = requireValidAuthorization(db, detail.plan);
    const timestamp = now();
    const deadlineAt = new Date(
      Math.min(
        Date.parse(authorization.expires_at),
        Date.now() + authorization.max_duration_seconds * 1000,
      ),
    ).toISOString();
    const inserted = db
      .prepare<[number, number, string, string, string, string]>(
        `INSERT INTO work_run
           (work_plan_id, authorization_id, plan_hash, status,
            model_call_count, tool_call_count, started_at, updated_at, deadline_at)
         VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?)`,
      )
      .run(
        detail.plan.id,
        authorization.id,
        detail.plan.plan_hash,
        timestamp,
        timestamp,
        deadlineAt,
      );
    db.prepare<[string, number]>(
      "UPDATE work_plan SET status = 'running', updated_at = ? WHERE id = ?",
    ).run(timestamp, planId);
    const created = getWorkRun(db, Number(inserted.lastInsertRowid));
    if (!created) throw new Error("Work run vanished after insertion");
    return { run: created, created: true };
  }).immediate();
  if (selected.created) logRunStarted(db, planId, selected.run.id);
  return selected.created
    ? executeRun(db, selected.run, options.executor, false)
    : resumeWorkRun(db, selected.run.id, options);
}

/** Resume a queued, paused, or process-interrupted safe run from its durable checkpoint. */
export async function resumeWorkRun(
  db: Db,
  runId: number,
  options: WorkRunOptions = {},
): Promise<WorkRun> {
  const run = requireWorkRun(db, runId);
  if (run.status === "completed" || run.status === "cancelled") return run;
  if (run.status === "failed") {
    throw new Error("A failed run requires a new exact authorization and a new run");
  }
  const detail = requireWorkPlanDetail(db, run.work_plan_id);
  if (!storedPlanHashMatches(db, detail)) {
    pauseRun(db, run.id, "plan_hash_changed", "Stored plan no longer matches the run");
    revokeWorkAuthorization(db, detail.plan.id);
    return requireWorkRun(db, run.id);
  }
  if (run.plan_hash !== detail.plan.plan_hash) {
    pauseRun(db, run.id, "plan_hash_changed", "Stored plan no longer matches the run");
    revokeWorkAuthorization(db, detail.plan.id);
    return requireWorkRun(db, run.id);
  }
  const authorization = getWorkAuthorization(db, run.authorization_id);
  if (!authorization || !authorizationIsValid(authorization, detail.plan)) {
    pauseRun(db, run.id, "authorization_invalid", "Exact authorization expired or was revoked");
    return requireWorkRun(db, run.id);
  }
  // Credit the time this run spent parked before judging it against its deadline. The
  // authorization above is what actually bounds how long the user has to decide.
  const deadline = resumeDeadline(db, run, authorization.expires_at);
  if (Date.parse(deadline) <= Date.now()) {
    pauseRun(db, run.id, "run_deadline_exceeded", "The bounded run deadline elapsed");
    revokeWorkAuthorization(db, detail.plan.id);
    return requireWorkRun(db, run.id);
  }

  return executeRun(db, requireWorkRun(db, run.id), options.executor, true);
}

export function cancelWorkRun(db: Db, runId: number): WorkRun | null {
  const run = getWorkRun(db, runId);
  if (!run) return null;
  if (run.status === "completed" || run.status === "cancelled") return run;
  db.transaction(() => {
    const timestamp = now();
    db.prepare<[string, string, number]>(
      `UPDATE work_run
       SET status = 'cancelled', updated_at = ?, completed_at = ?,
           error_code = 'cancelled_by_user', error_message = NULL,
           runner_token = NULL, runner_lease_until = NULL
       WHERE id = ?`,
    ).run(timestamp, timestamp, runId);
    db.prepare<[string, number]>(
      `UPDATE work_step
       SET status = 'cancelled', completed_at = ?, error_code = NULL,
           error_message = NULL
       WHERE work_plan_id = ? AND status IN ('pending','running','failed')`,
    ).run(timestamp, run.work_plan_id);
    db.prepare<[string, number]>(
      `UPDATE tool_receipt
       SET status = 'failed', error_code = 'cancelled_by_user',
           error_message = NULL, completed_at = ?
       WHERE work_run_id = ? AND status = 'started'`,
    ).run(timestamp, runId);
    db.prepare<[string, number]>(
      `UPDATE work_plan
       SET status = 'cancelled', updated_at = ?, completed_at = NULL WHERE id = ?`,
    ).run(timestamp, run.work_plan_id);
    revokeWorkAuthorization(db, run.work_plan_id);
  })();
  logRunStopped(db, runId, run.status);
  return requireWorkRun(db, runId);
}

export function cancelWorkPlan(db: Db, planId: number): WorkPlanDetail | null {
  const detail = getWorkPlan(db, planId);
  if (!detail) return null;
  const active = latestResumableRun(db, planId);
  if (active) cancelWorkRun(db, active.id);
  else {
    db.prepare<[string, number]>(
      `UPDATE work_plan
       SET status = 'cancelled', updated_at = ?, completed_at = NULL
       WHERE id = ? AND status != 'completed'`,
    ).run(now(), planId);
    revokeWorkAuthorization(db, planId);
    db.prepare<[string, number]>(
      `UPDATE work_step SET status = 'cancelled', completed_at = ?
       WHERE work_plan_id = ? AND status IN ('pending','failed')`,
    ).run(now(), planId);
  }
  return requireWorkPlanDetail(db, planId);
}

/** Database-backed output only; this primitive never writes to the filesystem. */
export function createWorkArtifact(
  db: Db,
  input: {
    planId: number;
    runId: number;
    stepId?: number | null;
    artifact: WorkArtifactInput;
  },
): WorkArtifact {
  const artifact = normalizeArtifact(input.artifact);
  return db.transaction(() => {
    const run = requireWorkRun(db, input.runId);
    if (run.work_plan_id !== input.planId) {
      throw new Error("Artifact run does not belong to the supplied work plan");
    }
    if (run.status !== "running") {
      throw new Error("Artifacts can only be created by an active bounded work run");
    }
    if (input.stepId !== undefined && input.stepId !== null) {
      const step = db.prepare<[number, number], { found: number }>(
        "SELECT 1 AS found FROM work_step WHERE id = ? AND work_plan_id = ?",
      ).get(input.stepId, input.planId);
      if (!step) throw new Error("Artifact step does not belong to the supplied work plan");
    }
    const planSource = db.prepare<[number], { source_message_id: number }>(
      "SELECT source_message_id FROM work_plan WHERE id = ?",
    ).get(input.planId)?.source_message_id;
    const sourceIds = [...new Set([
      ...(planSource === undefined ? [] : [planSource]),
      ...artifact.sourceMessageIds,
    ])].sort((left, right) => left - right);
    assertUserMessages(db, sourceIds);
    const memoryItems = normalizeArtifactMemorySources(db, artifact.sourceMemoryItems);

    const timestamp = now();
    const inserted = db.prepare<
      [number, number, number | null, WorkArtifactKind, string, string, string, string, string]
    >(
      `INSERT INTO work_artifact
         (work_plan_id, work_run_id, work_step_id, kind, title, content,
          citations_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.planId,
      input.runId,
      input.stepId ?? null,
      artifact.kind,
      artifact.title,
      artifact.content,
      JSON.stringify(artifact.citations),
      timestamp,
      timestamp,
    );
    const artifactId = Number(inserted.lastInsertRowid);
    const insertSource = db.prepare<[number, number]>(
      `INSERT INTO work_artifact_source (work_artifact_id, source_message_id)
       VALUES (?, ?)`,
    );
    for (const sourceId of sourceIds) insertSource.run(artifactId, sourceId);
    const insertMemory = db.prepare<
      [number, WorkPlanMemorySourceKind, number, string]
    >(
      `INSERT INTO work_artifact_memory_source
         (work_artifact_id, source_kind, source_id, snapshot_json)
       VALUES (?, ?, ?, ?)`,
    );
    for (const source of memoryItems) {
      insertMemory.run(artifactId, source.sourceKind, source.sourceId, source.snapshotJson);
    }
    const stored = db.prepare<[number], WorkArtifact>(`${SELECT_ARTIFACT} WHERE id = ?`)
      .get(artifactId);
    if (!stored) throw new Error("Work artifact vanished after insertion");
    return stored;
  })();
}

async function executeRun(
  db: Db,
  initialRun: WorkRun,
  executor: SafeWorkExecutor | undefined,
  recoverInterrupted: boolean,
): Promise<WorkRun> {
  let run = initialRun;
  const detail = requireWorkPlanDetail(db, run.work_plan_id);
  const authorization = getWorkAuthorization(db, run.authorization_id);
  if (!authorization || !authorizationIsValid(authorization, detail.plan)) {
    pauseRun(db, run.id, "authorization_invalid", "Exact authorization expired or was revoked");
    return requireWorkRun(db, run.id);
  }
  const lease = claimWorkRun(db, run.id);
  if (!lease) {
    const contested = requireWorkRun(db, run.id);
    // Yielding to a live lease is correct, and silent: without this line a run being
    // worked by another process looks exactly like a run nobody picked up.
    if (contested.runner_token !== null) {
      logLeaseLost(db, contested, "already_leased");
    }
    return contested;
  }
  // An expired lease means there was a holder and its time ran out — the visible half of
  // a runner that died without saying so. `recovered` is deliberately wider than that: it
  // also covers a row left saying `running` with no token at all, which no live runner
  // produces and which would charge a lease loss to a lease nobody held.
  if (lease.recovered && run.runner_token !== null) logLeaseLost(db, run, "expired");
  if (recoverInterrupted && lease.recovered) {
    recoverInterruptedAttempt(db, requireWorkRun(db, run.id), authorization);
    run = requireWorkRun(db, run.id);
    if (run.status === "failed") return run;
  }
  if (!executor) {
    pauseRun(db, run.id, "executor_unavailable", "No safe work executor is available");
    return requireWorkRun(db, run.id);
  }

  const parked = run.status === "paused";
  if (!markRunRunning(db, run.id, detail.plan.id, lease.token)) {
    return requireWorkRun(db, run.id);
  }
  // A run leaving its checkpoint is the second and last way a run starts. A recovered
  // runner re-marking a row that already said `running` is not one: that run never left
  // the live set, and the start line the process that died wrote is still the open half
  // of the pair.
  if (parked) logRunStarted(db, detail.plan.id, run.id);
  while (true) {
    run = requireWorkRun(db, run.id);
    if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
      return run;
    }
    if (Date.parse(run.deadline_at) <= Date.now()) {
      pauseRun(db, run.id, "run_deadline_exceeded", "The bounded run deadline elapsed");
      revokeAuthorization(db, run.authorization_id);
      return requireWorkRun(db, run.id);
    }
    const currentAuthorization = getWorkAuthorization(db, run.authorization_id);
    if (!currentAuthorization || !authorizationIsValid(currentAuthorization, detail.plan)) {
      pauseRun(db, run.id, "authorization_invalid", "Exact authorization expired or was revoked");
      return requireWorkRun(db, run.id);
    }

    const steps = workSteps(db, detail.plan.id);
    if (steps.every((step) => step.status === "completed" || step.status === "skipped")) {
      if (!completionEvidenceSatisfied(db, detail.plan.id, steps)) {
        failRun(
          db,
          run.id,
          detail.plan.id,
          "completion_criteria_not_met",
          "Every completed work step must produce a reviewable local artifact",
        );
        return requireWorkRun(db, run.id);
      }
      completeRun(db, run.id, detail.plan.id);
      return requireWorkRun(db, run.id);
    }
    const step = nextReadyStep(steps);
    if (!step) {
      failRun(db, run.id, detail.plan.id, "dependency_blocked", "No remaining step can run");
      return requireWorkRun(db, run.id);
    }

    const usedCalls = run.model_call_count + run.tool_call_count;
    const remainingCallBudget = currentAuthorization.max_model_tool_calls - usedCalls;
    const minimumCallCost = minimumCallCostForEffect(step.effect_kind);
    if (remainingCallBudget < minimumCallCost) {
      failRun(
        db,
        run.id,
        detail.plan.id,
        "call_budget_exhausted",
        `The bounded call budget cannot cover this step's minimum cost of ${minimumCallCost}`,
      );
      return requireWorkRun(db, run.id);
    }

    const attempt = step.attempt_count + 1;
    const idempotencyKey = createHash("sha256")
      .update(`${run.plan_hash}:${run.id}:${step.id}:${attempt}`)
      .digest("hex");
    const providerRequestKey = createHash("sha256")
      .update(`${run.plan_hash}:${run.id}:${step.id}:logical-step`)
      .digest("hex");
    // A connector-backed step resolves its grant before it can even open a receipt. A
    // capability withdrawn since authorization pauses the run at its checkpoint rather
    // than failing it: reconnecting the service is a repair the user can make.
    let connectorCapabilityId: number | null = null;
    if (isConnectorEffect(step.effect_kind)) {
      const available = availableCapabilityForEffect(db, step.effect_kind);
      if (!available) {
        pauseStepAndRun(
          db,
          run.id,
          detail.plan.id,
          step.id,
          "capability_unavailable",
          `No connected service currently provides ${step.effect_kind}`,
        );
        return requireWorkRun(db, run.id);
      }
      connectorCapabilityId = available.capability.id;
    }

    const toolName = toolNameFor(step.effect_kind);
    const receipt = beginAttempt(
      db,
      run,
      step,
      toolName,
      connectorCapabilityId,
      attempt,
      idempotencyKey,
      lease.token,
    );
    if (!receipt) return requireWorkRun(db, run.id);

    try {
      const stopHeartbeat = startWorkRunHeartbeat(db, run.id, lease.token);
      if (!stopHeartbeat) return requireWorkRun(db, run.id);
      const abortBoundary = startExecutionAbortBoundary(
        db,
        run.id,
        run.authorization_id,
        lease.token,
      );
      let executorOutput: SafeStepExecutionResult;
      try {
        executorOutput = await executor({
          plan: detail.plan,
          step,
          run: requireWorkRun(db, run.id),
          attempt,
          remainingCallBudget,
          idempotencyKey,
          providerRequestKey,
          signal: abortBoundary.signal,
        });
      } finally {
        abortBoundary.stop();
        stopHeartbeat();
      }
      const result = normalizeExecutionResult(
        executorOutput,
      );
      const boundaryIssue = postExecutionBoundaryIssue(
        db,
        detail,
        run.id,
        step.id,
        receipt.id,
        lease.token,
      );
      if (boundaryIssue) {
        db.transaction(() => {
          if (!executionClaimIsCurrent(db, run.id, step.id, receipt.id, lease.token)) return;
          finishReceiptFailed(db, receipt.id, boundaryIssue.code, boundaryIssue.message);
          addRunCounts(db, run.id, result.modelCalls, result.toolCalls);
          pauseStepAndRun(
            db,
            run.id,
            detail.plan.id,
            step.id,
            boundaryIssue.code,
            boundaryIssue.message,
          );
          revokeAuthorization(db, run.authorization_id);
        })();
        return requireWorkRun(db, run.id);
      }

      const calls = result.modelCalls + result.toolCalls;
      if (calls > remainingCallBudget) {
        db.transaction(() => {
          if (!executionClaimIsCurrent(db, run.id, step.id, receipt.id, lease.token)) return;
          finishReceiptFailed(
            db,
            receipt.id,
            "call_budget_exceeded",
            "Safe executor exceeded the supplied call budget",
          );
          addRunCounts(db, run.id, result.modelCalls, result.toolCalls);
          failStepAndRun(
            db,
            run.id,
            detail.plan.id,
            step.id,
            "call_budget_exceeded",
            "Safe executor exceeded the supplied call budget",
          );
        })();
        return requireWorkRun(db, run.id);
      }
      if (!result.pause && result.artifacts.length === 0) {
        db.transaction(() => {
          if (!executionClaimIsCurrent(db, run.id, step.id, receipt.id, lease.token)) return;
          finishReceiptFailed(
            db,
            receipt.id,
            "completion_criteria_not_met",
            "The safe executor produced no reviewable local artifact",
          );
          addRunCounts(db, run.id, result.modelCalls, result.toolCalls);
          failStepAndRun(
            db,
            run.id,
            detail.plan.id,
            step.id,
            "completion_criteria_not_met",
            "The safe executor produced no reviewable local artifact",
          );
        })();
        return requireWorkRun(db, run.id);
      }

      const committed = db.transaction(() => {
        if (!executionClaimIsCurrent(db, run.id, step.id, receipt.id, lease.token)) {
          return false;
        }
        finishReceiptCompleted(db, receipt.id, result.output, result.citations);
        addRunCounts(db, run.id, result.modelCalls, result.toolCalls);
        // Artifacts are written before the pause branch, not after it. A step that stops is
        // exactly the step whose reasons the user needs: the conflict it found, the payload
        // it is holding. Returning first threw all of that away.
        for (const artifact of result.artifacts) {
          createWorkArtifact(db, {
            planId: detail.plan.id,
            runId: run.id,
            stepId: step.id,
            artifact,
          });
        }
        if (result.pause) {
          pauseStepAndRun(
            db,
            run.id,
            detail.plan.id,
            step.id,
            result.pause.code,
            result.pause.message ?? null,
          );
          if (result.pause.requiresReauthorization ?? true) {
            revokeAuthorization(db, run.authorization_id);
          }
          return true;
        }
        completeStep(db, run.id, step.id);
        return true;
      })();
      if (!committed) return requireWorkRun(db, run.id);
      if (result.pause) return requireWorkRun(db, run.id);
    } catch (error) {
      const failure = normalizeExecutionError(error);
      const boundaryIssue = postExecutionBoundaryIssue(
        db,
        detail,
        run.id,
        step.id,
        receipt.id,
        lease.token,
      );
      const retryAllowed = failure.transient &&
        attempt <= currentAuthorization.max_retries_per_step;
      const outcome = db.transaction(() => {
        if (!executionClaimIsCurrent(db, run.id, step.id, receipt.id, lease.token)) {
          return "ownership_lost" as const;
        }
        if (boundaryIssue) {
          finishReceiptFailed(db, receipt.id, boundaryIssue.code, boundaryIssue.message);
          addRunCounts(db, run.id, failure.modelCalls, failure.toolCalls);
          pauseStepAndRun(
            db,
            run.id,
            detail.plan.id,
            step.id,
            boundaryIssue.code,
            boundaryIssue.message,
          );
          revokeAuthorization(db, run.authorization_id);
          return "paused" as const;
        }
        finishReceiptFailed(db, receipt.id, failure.code, failure.message);
        addRunCounts(db, run.id, failure.modelCalls, failure.toolCalls);
        if (retryAllowed) {
          db.prepare<[string, string, number]>(
            `UPDATE work_step
             SET status = 'pending', error_code = ?, error_message = ? WHERE id = ?`,
          ).run(failure.code, failure.message, step.id);
          return "retry" as const;
        }
        failStepAndRun(
          db,
          run.id,
          detail.plan.id,
          step.id,
          failure.code,
          failure.message,
        );
        return "failed" as const;
      })();
      if (outcome === "retry" || outcome === "failed") {
        // The effect kind is Zeus's own fixed vocabulary, and it is the difference
        // between "the model is struggling" and "every run dies at the calendar". The
        // step's stored error code is not logged: an executor supplies that string.
        logEvent({
          event: "work_step_failed",
          // A step still inside its retry budget is a degradation; the attempt that
          // exhausts it is the failure that stopped the run.
          outcome: outcome === "retry" ? "degraded" : "error",
          effect: step.effect_kind,
          plan_id: detail.plan.id,
          run_id: run.id,
          count: attempt,
          ...accountEvent(db),
        });
      }
      if (outcome === "retry") continue;
      return requireWorkRun(db, run.id);
    }
  }
}

/**
 * Shape only. Whether these effects may run is asked separately, at creation and at
 * authorization, so that recomputing a stored plan's hash never depends on today's
 * configuration.
 */
function normalizeProposal(input: WorkPlanProposal): WorkPlanProposal {
  const parsed = WorkPlanProposalSchema.parse(input);
  const allowedEffects = uniqueEffects(parsed.allowed_effects);
  const steps = parsed.steps.map((step) => ({
    ...step,
    title: step.title.trim(),
    instruction: step.instruction.trim(),
    depends_on: [...new Set(step.depends_on)].sort((a, b) => a - b),
  }));
  if (steps.length > MAX_STEPS) throw new Error(`Work plans may contain at most ${MAX_STEPS} steps`);
  for (const [index, step] of steps.entries()) {
    if (!allowedEffects.includes(step.effect_kind)) {
      throw new Error(`Step ${index + 1} uses an effect outside allowed_effects`);
    }
    for (const dependency of step.depends_on) {
      if (dependency < 1 || dependency > steps.length || dependency === index + 1) {
        throw new Error(`Step ${index + 1} has an invalid dependency`);
      }
    }
  }
  assertAcyclic(steps.map((step) => step.depends_on));
  if (parsed.limits.max_model_tool_calls > MAX_MODEL_TOOL_CALLS) {
    throw new Error(`Work plans may use at most ${MAX_MODEL_TOOL_CALLS} model/tool calls`);
  }
  if (parsed.limits.max_retries_per_step > MAX_RETRIES_PER_STEP) {
    throw new Error(`Work plans may retry a step at most ${MAX_RETRIES_PER_STEP} times`);
  }
  if (parsed.limits.max_duration_seconds > MAX_DURATION_SECONDS) {
    throw new Error(`Work plans may run for at most ${MAX_DURATION_SECONDS} seconds`);
  }
  return {
    ...parsed,
    objective: parsed.objective.trim(),
    steps,
    allowed_effects: allowedEffects,
    completion_criteria: parsed.completion_criteria.map((criterion) => criterion.trim()),
  };
}

function hashNormalizedProposal(
  proposal: WorkPlanProposal,
  links: {
    sourceMessageId: number;
    sourceInstructionDigest: string;
    sourceGoalId: number | null;
    sourceCommitmentId: number | null;
    sourceProjectId: number | null;
    origin: WorkPlanOrigin;
    generationProvenance: WorkPlanGenerationProvenance | null;
  },
): string {
  const payload = {
    version: links.generationProvenance === null ? 2 : 3,
    objective: proposal.objective,
    steps: proposal.steps.map((step, index) => ({
      position: index + 1,
      title: step.title,
      instruction: step.instruction,
      effect_kind: step.effect_kind,
      depends_on: step.depends_on,
    })),
    allowed_effects: proposal.allowed_effects,
    completion_criteria: proposal.completion_criteria,
    limits: {
      max_steps: MAX_STEPS,
      max_model_tool_calls: proposal.limits.max_model_tool_calls,
      max_retries_per_step: proposal.limits.max_retries_per_step,
      max_duration_seconds: proposal.limits.max_duration_seconds,
    },
    provenance: {
      source_message_id: links.sourceMessageId,
      source_instruction_sha256: links.sourceInstructionDigest,
      source_goal_id: links.sourceGoalId,
      source_commitment_id: links.sourceCommitmentId,
      source_project_id: links.sourceProjectId,
      origin: links.origin,
      ...(links.generationProvenance === null
        ? {}
        : {
            generation: generationHashPayload(links.generationProvenance),
          }),
    },
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function storedPlanHash(db: Db, detail: WorkPlanDetail): string {
  const proposal = normalizeProposal({
    objective: detail.plan.objective,
    steps: detail.steps.map((step) => ({
      title: step.title,
      instruction: step.instruction,
      effect_kind: step.effect_kind,
      depends_on: step.depends_on,
    })),
    allowed_effects: parseEffects(detail.plan.allowed_effects_json),
    completion_criteria: parseStringArray(detail.plan.completion_criteria_json),
    limits: {
      max_model_tool_calls: detail.plan.max_model_tool_calls,
      max_retries_per_step: detail.plan.max_retries_per_step,
      max_duration_seconds: detail.plan.max_duration_seconds,
    },
  });
  if (detail.plan.max_steps !== MAX_STEPS) {
    throw new Error("Stored work plan uses an unsupported step limit");
  }
  const generationProvenance = detail.plan.hash_version === 3
    ? getWorkPlanGenerationProvenance(db, detail.plan.id)
    : null;
  if (detail.plan.hash_version === 3 && generationProvenance === null) {
    throw new Error("Stored personalized work plan is missing generation provenance");
  }
  return hashNormalizedProposal(proposal, {
    sourceMessageId: detail.plan.source_message_id,
    sourceInstructionDigest: sourceInstructionDigest(db, detail.plan.source_message_id),
    sourceGoalId: detail.plan.source_goal_id,
    sourceCommitmentId: detail.plan.source_commitment_id,
    sourceProjectId: detail.plan.source_project_id,
    origin: detail.plan.origin,
    generationProvenance,
  });
}

function normalizeGenerationProvenance(
  db: Db,
  input: WorkPlanGenerationProvenanceInput,
): WorkPlanGenerationProvenance {
  const evaluationContext = EvaluationContextSchema.parse(input.evaluationContext);
  const seen = new Set<string>();
  const memorySources = input.memorySources.map((source) => {
    if (!Number.isInteger(source.sourceId) || source.sourceId <= 0) {
      throw new Error("Work-plan memory provenance requires a positive source id");
    }
    const key = `${source.sourceKind}:${source.sourceId}`;
    if (seen.has(key)) throw new Error(`Duplicate work-plan memory source ${key}`);
    seen.add(key);
    const exists = db.prepare<[number], { found: number }>(
      source.sourceKind === "fact"
        ? "SELECT 1 AS found FROM fact WHERE id = ?"
        : "SELECT 1 AS found FROM understanding_facet WHERE id = ?",
    ).get(source.sourceId);
    if (!exists) throw new Error(`Work-plan memory source ${key} no longer exists`);
    const exclusionReason = source.exclusionReason?.replace(/\s+/gu, " ").trim() || null;
    if (source.includedInPrompt === (exclusionReason !== null)) {
      throw new Error("Included memory sources cannot carry an exclusion reason");
    }
    const sourceMessageIds = [...new Set(source.sourceMessageIds)]
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((left, right) => left - right);
    if (sourceMessageIds.length === 0) {
      throw new Error(`Work-plan memory source ${key} requires user-message evidence`);
    }
    assertUserMessages(db, sourceMessageIds);
    const snapshotJson = canonicalJson(parseJsonValue(source.snapshot, "memory source snapshot"));
    return {
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      includedInPrompt: source.includedInPrompt,
      exclusionReason,
      snapshot: JSON.parse(snapshotJson) as unknown,
      snapshotJson,
      sourceMessageIds,
    };
  }).sort(compareMemorySources);

  const included = new Set(
    memorySources
      .filter((source) => source.includedInPrompt)
      .map((source) => `${source.sourceKind}:${source.sourceId}`),
  );
  const conflicts = input.conflicts.map((conflict) => {
    const itemIds = [...new Set(conflict.item_ids.map((id) => id.trim()))].sort();
    const reasons = [...new Set(conflict.reasons.map((reason) => reason.trim()))].sort();
    if (itemIds.length < 2 || reasons.length === 0) {
      throw new Error("Work-plan conflict snapshots require two items and a reason");
    }
    if (itemIds.some((id) => !included.has(id))) {
      throw new Error("Work-plan conflict snapshots may reference only included memory");
    }
    return { item_ids: itemIds, reasons };
  }).sort((left, right) => left.item_ids.join(":").localeCompare(right.item_ids.join(":")));

  return { evaluationContext, conflicts, memorySources };
}

function compareMemorySources(
  left: Pick<WorkPlanMemorySourceInput, "sourceKind" | "sourceId">,
  right: Pick<WorkPlanMemorySourceInput, "sourceKind" | "sourceId">,
): number {
  const kind = left.sourceKind.localeCompare(right.sourceKind);
  return kind !== 0 ? kind : left.sourceId - right.sourceId;
}

function generationHashPayload(provenance: WorkPlanGenerationProvenance): unknown {
  return {
    evaluation_context: provenance.evaluationContext,
    conflicts: provenance.conflicts,
    memory_sources: provenance.memorySources.map((source) => ({
      source_kind: source.sourceKind,
      source_id: source.sourceId,
      included_in_prompt: source.includedInPrompt,
      exclusion_reason: source.exclusionReason,
      snapshot: source.snapshot,
      source_message_ids: source.sourceMessageIds,
    })),
  };
}

function insertGenerationProvenance(
  db: Db,
  planId: number,
  provenance: WorkPlanGenerationProvenance,
  timestamp: string,
): void {
  db.prepare<[number, string, string, string]>(
    `INSERT INTO work_plan_generation_context
       (work_plan_id, evaluation_context_json, conflict_snapshot_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    planId,
    canonicalJson(provenance.evaluationContext),
    canonicalJson(provenance.conflicts),
    timestamp,
  );
  const insertSource = db.prepare<
    [number, WorkPlanMemorySourceKind, number, number, string | null, string]
  >(
    `INSERT INTO work_plan_memory_source
       (work_plan_id, source_kind, source_id, included_in_prompt,
        exclusion_reason, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare<
    [number, WorkPlanMemorySourceKind, number, number]
  >(
    `INSERT INTO work_plan_memory_source_message
       (work_plan_id, source_kind, source_id, source_message_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const source of provenance.memorySources) {
    insertSource.run(
      planId,
      source.sourceKind,
      source.sourceId,
      source.includedInPrompt ? 1 : 0,
      source.exclusionReason,
      source.snapshotJson,
    );
    for (const messageId of source.sourceMessageIds) {
      insertMessage.run(planId, source.sourceKind, source.sourceId, messageId);
    }
  }
}

function parseConflictSnapshot(value: string): WorkPlanConflictSnapshot[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Invalid work-plan conflict snapshot");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid work-plan conflict snapshot");
    }
    const record = entry as Record<string, unknown>;
    if (
      !Array.isArray(record.item_ids) ||
      record.item_ids.some((item) => typeof item !== "string") ||
      !Array.isArray(record.reasons) ||
      record.reasons.some((item) => typeof item !== "string")
    ) {
      throw new Error("Invalid work-plan conflict snapshot");
    }
    return {
      item_ids: record.item_ids as string[],
      reasons: record.reasons as string[],
    };
  });
}

function parseJsonValue(value: unknown, label: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error();
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
}

function storedPlanHashMatches(db: Db, detail: WorkPlanDetail): boolean {
  try {
    return storedPlanHash(db, detail) === detail.plan.plan_hash;
  } catch {
    return false;
  }
}

function assertStoredPlanHash(db: Db, detail: WorkPlanDetail): void {
  if (!storedPlanHashMatches(db, detail)) {
    throw new Error("Stored work plan no longer matches its immutable hash");
  }
}

function workPlanDetail(db: Db, plan: WorkPlan): WorkPlanDetail {
  return {
    plan,
    steps: workSteps(db, plan.id),
    authorization: activeWorkAuthorization(db, plan.id),
    latestRun:
      db
        .prepare<[number], WorkRun>(
          `${SELECT_RUN} WHERE work_plan_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(plan.id) ?? null,
  };
}

function requireWorkPlanDetail(db: Db, id: number): WorkPlanDetail {
  const detail = getWorkPlan(db, id);
  if (!detail) throw new Error(`Unknown work plan ${id}`);
  return detail;
}

function requireWorkRun(db: Db, id: number): WorkRun {
  const run = getWorkRun(db, id);
  if (!run) throw new Error(`Unknown work run ${id}`);
  return run;
}

function latestResumableRun(db: Db, planId: number): WorkRun | null {
  return (
    db
      .prepare<[number], WorkRun>(
        `${SELECT_RUN}
         WHERE work_plan_id = ? AND status IN ('queued','running','paused')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(planId) ?? null
  );
}

function closeSupersededRun(db: Db, run: WorkRun): void {
  const timestamp = now();
  db.transaction(() => {
    db.prepare<[string, string, number]>(
      `UPDATE work_run
       SET status = 'failed', error_code = 'authorization_replaced',
           error_message = 'A newer exact authorization replaced this run',
           updated_at = ?, completed_at = ?, runner_token = NULL,
           runner_lease_until = NULL
       WHERE id = ? AND status IN ('queued','running','paused')`,
    ).run(timestamp, timestamp, run.id);
    db.prepare<[string, number]>(
      `UPDATE tool_receipt
       SET status = 'failed', error_code = 'authorization_replaced',
           error_message = 'A newer exact authorization replaced this run',
           completed_at = ?
       WHERE work_run_id = ? AND status = 'started'`,
    ).run(timestamp, run.id);
    db.prepare<[number]>(
      `UPDATE work_step
       SET status = 'pending', error_code = NULL, error_message = NULL
       WHERE work_plan_id = ? AND status = 'running'`,
    ).run(run.work_plan_id);
  })();
  logRunStopped(db, run.id, run.status);
}

function requireValidAuthorization(db: Db, plan: WorkPlan): WorkAuthorization {
  const authorization = activeWorkAuthorization(db, plan.id);
  if (!authorization || !authorizationIsValid(authorization, plan)) {
    throw new Error("Work plan authorization is absent, expired, revoked, or inexact");
  }
  return authorization;
}

function authorizationIsValid(authorization: WorkAuthorization, plan: WorkPlan): boolean {
  if (authorization.revoked_at !== null || Date.parse(authorization.expires_at) <= Date.now()) {
    return false;
  }
  if (authorization.plan_hash !== plan.plan_hash) return false;
  const planEffects = parseEffects(plan.allowed_effects_json);
  const authorizedEffects = parseEffects(authorization.allowed_effects_json);
  if (!sameStringSet(planEffects, authorizedEffects)) return false;
  return (
    authorization.max_model_tool_calls <= plan.max_model_tool_calls &&
    authorization.max_retries_per_step <= plan.max_retries_per_step &&
    authorization.max_duration_seconds <= plan.max_duration_seconds
  );
}

function validateAuthorizationLimits(
  plan: WorkPlan,
  input: AuthorizeWorkPlanInput,
): {
  maxModelToolCalls: number;
  maxRetriesPerStep: number;
  maxDurationSeconds: number;
} {
  const maxModelToolCalls = boundedPositiveInt(
    input.maxModelToolCalls,
    plan.max_model_tool_calls,
    "maxModelToolCalls",
  );
  const maxRetriesPerStep = boundedInt(
    input.maxRetriesPerStep,
    0,
    plan.max_retries_per_step,
    "maxRetriesPerStep",
  );
  const maxDurationSeconds = boundedPositiveInt(
    input.maxDurationSeconds,
    plan.max_duration_seconds,
    "maxDurationSeconds",
  );
  return { maxModelToolCalls, maxRetriesPerStep, maxDurationSeconds };
}

function recoverInterruptedAttempt(
  db: Db,
  run: WorkRun,
  authorization: WorkAuthorization,
): void {
  const running = db
    .prepare<[number], WorkStep>(
      `${SELECT_STEP} WHERE work_plan_id = ? AND status = 'running' ORDER BY position`,
    )
    .all(run.work_plan_id);
  if (running.length === 0) return;
  db.transaction(() => {
    const timestamp = now();
    db.prepare<[string, number]>(
      `UPDATE tool_receipt
       SET status = 'failed', error_code = 'interrupted',
           error_message = 'Execution was interrupted before a durable result',
           completed_at = ?
       WHERE work_run_id = ? AND status = 'started'`,
    ).run(timestamp, run.id);
    for (const step of running) {
      if (step.attempt_count > authorization.max_retries_per_step) {
        failStepAndRun(
          db,
          run.id,
          run.work_plan_id,
          step.id,
          "retry_budget_exhausted",
          "Interrupted attempt exhausted the retry budget",
        );
        return;
      }
      db.prepare<[number]>(
        `UPDATE work_step
         SET status = 'pending', error_code = 'interrupted',
             error_message = 'Execution was interrupted before a durable result'
         WHERE id = ?`,
      ).run(step.id);
    }
  })();
}

type WorkRunLease = { token: string; recovered: boolean };

function claimWorkRun(db: Db, runId: number): WorkRunLease | null {
  return db.transaction(() => {
    const run = requireWorkRun(db, runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return null;
    const timestamp = Date.now();
    const existingLease = run.runner_lease_until === null
      ? Number.NaN
      : Date.parse(run.runner_lease_until);
    if (run.runner_token !== null && Number.isFinite(existingLease) && existingLease > timestamp) {
      return null;
    }
    const token = randomUUID();
    const leaseUntil = new Date(
      Math.min(Date.parse(run.deadline_at), timestamp + RUNNER_LEASE_MS),
    ).toISOString();
    const updated = db.prepare<[string, string, string, number, string]>(
      `UPDATE work_run
       SET runner_token = ?, runner_lease_until = ?, updated_at = ?
       WHERE id = ?
         AND (runner_token IS NULL OR runner_lease_until IS NULL OR runner_lease_until <= ?)`,
    ).run(token, leaseUntil, now(), runId, new Date(timestamp).toISOString());
    return updated.changes === 1
      ? { token, recovered: run.status === "running" || run.runner_token !== null }
      : null;
  }).immediate();
}

function executionClaimIsCurrent(
  db: Db,
  runId: number,
  stepId: number,
  receiptId: number,
  runnerToken: string,
): boolean {
  return Boolean(
    db.prepare<[number, number, number, string], { found: number }>(
      `SELECT 1 AS found
       FROM work_run run
       JOIN work_step step ON step.id = ? AND step.work_plan_id = run.work_plan_id
       JOIN tool_receipt receipt ON receipt.id = ? AND receipt.work_run_id = run.id
       WHERE run.id = ? AND run.runner_token = ? AND run.status = 'running'
         AND step.status = 'running' AND receipt.status = 'started'`,
    ).get(stepId, receiptId, runId, runnerToken),
  );
}

function refreshWorkRunLease(db: Db, runId: number, runnerToken: string): boolean {
  const run = requireWorkRun(db, runId);
  const timestamp = Date.now();
  if (Date.parse(run.deadline_at) <= timestamp) return false;
  const leaseUntil = new Date(
    Math.min(Date.parse(run.deadline_at), timestamp + RUNNER_LEASE_MS),
  ).toISOString();
  const refreshed = db.prepare<[string, string, number, string]>(
    `UPDATE work_run
     SET runner_lease_until = ?, updated_at = ?
     WHERE id = ? AND runner_token = ? AND status = 'running'`,
  ).run(leaseUntil, now(), runId, runnerToken);
  return refreshed.changes === 1;
}

function startWorkRunHeartbeat(
  db: Db,
  runId: number,
  runnerToken: string,
): (() => void) | null {
  if (!refreshWorkRunLease(db, runId, runnerToken)) return null;
  const timer = setInterval(() => {
    try {
      refreshWorkRunLease(db, runId, runnerToken);
    } catch {
      // The post-execution CAS remains authoritative if a transient DB lock blocks a beat.
    }
  }, RUNNER_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function startExecutionAbortBoundary(
  db: Db,
  runId: number,
  authorizationId: number,
  runnerToken: string,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const check = () => {
    if (controller.signal.aborted) return;
    try {
      const run = getWorkRun(db, runId);
      const authorization = getWorkAuthorization(db, authorizationId);
      if (
        !run || run.status !== "running" || run.runner_token !== runnerToken ||
        Date.parse(run.deadline_at) <= Date.now() ||
        !authorization || authorization.revoked_at !== null ||
        Date.parse(authorization.expires_at) <= Date.now()
      ) {
        controller.abort(new Error("The bounded work execution boundary changed"));
      }
    } catch {
      controller.abort(new Error("The bounded work execution boundary could not be verified"));
    }
  };
  check();
  const timer = setInterval(check, 250);
  timer.unref();
  return {
    signal: controller.signal,
    stop: () => clearInterval(timer),
  };
}

function postExecutionBoundaryIssue(
  db: Db,
  detail: WorkPlanDetail,
  runId: number,
  stepId: number,
  receiptId: number,
  runnerToken: string,
): { code: string; message: string } | null {
  const run = requireWorkRun(db, runId);
  if (!executionClaimIsCurrent(db, runId, stepId, receiptId, runnerToken)) {
    // The claim goes stale for several reasons and only one of them is a lease loss: a
    // different runner now holds the token. Pressing Cancel and replacing an
    // authorization also invalidate the claim, and both already announce themselves as
    // `work_run_stopped` — reporting them a second time as a degradation would charge a
    // person's own decision to the failure rate, and an event that fires on an ordinary
    // outcome is the one an operator learns to ignore.
    if (run.runner_token !== null && run.runner_token !== runnerToken) {
      // Work that finished and is about to be discarded, because another runner took the
      // run while this step was in flight. The most expensive way for a run to stop.
      logLeaseLost(db, run, "ownership_lost");
    }
    return { code: "execution_ownership_lost", message: "The work-run lease is no longer active" };
  }
  if (Date.parse(run.deadline_at) <= Date.now()) {
    return { code: "run_deadline_exceeded", message: "The bounded run deadline elapsed during the step" };
  }
  const authorization = getWorkAuthorization(db, run.authorization_id);
  if (!authorization || !authorizationIsValid(authorization, detail.plan)) {
    return { code: "authorization_invalid", message: "Exact authorization expired or was revoked during the step" };
  }
  if (run.plan_hash !== detail.plan.plan_hash || !storedPlanHashMatches(db, detail)) {
    return { code: "plan_hash_changed", message: "The exact work-plan scope changed during the step" };
  }
  return null;
}

function revokeAuthorization(db: Db, authorizationId: number): void {
  db.prepare<[string, number]>(
    "UPDATE work_authorization SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).run(now(), authorizationId);
}

function nextReadyStep(steps: readonly WorkStepWithDependencies[]): WorkStepWithDependencies | null {
  const byPosition = new Map(steps.map((step) => [step.position, step]));
  return (
    steps.find(
      (step) =>
        step.status === "pending" &&
        step.depends_on.every((position) => {
          const dependency = byPosition.get(position);
          return dependency?.status === "completed" || dependency?.status === "skipped";
        }),
    ) ?? null
  );
}

function completionEvidenceSatisfied(
  db: Db,
  planId: number,
  steps: readonly WorkStepWithDependencies[],
): boolean {
  const requiredStepIds = steps
    .filter((step) => step.status === "completed")
    .map((step) => step.id);
  if (requiredStepIds.length === 0) return false;
  const placeholders = requiredStepIds.map(() => "?").join(",");
  const count = db
    .prepare<[number, ...number[]], { count: number }>(
      `SELECT COUNT(DISTINCT work_step_id) AS count
       FROM work_artifact
       WHERE work_plan_id = ? AND work_step_id IN (${placeholders})`,
    )
    .get(planId, ...requiredStepIds)?.count ?? 0;
  return count === requiredStepIds.length;
}

function beginAttempt(
  db: Db,
  run: WorkRun,
  step: WorkStepWithDependencies,
  toolName: ToolName,
  connectorCapabilityId: number | null,
  attempt: number,
  idempotencyKey: string,
  runnerToken: string,
): ToolReceipt | null {
  return db.transaction(() => {
    const timestamp = now();
    const claimed = db.prepare<[number, string, number, number, string]>(
      `UPDATE work_step
       SET status = 'running', attempt_count = ?, started_at = COALESCE(started_at, ?),
           error_code = NULL, error_message = NULL
       WHERE id = ? AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM work_run
           WHERE id = ? AND runner_token = ? AND status = 'running'
         )`,
    ).run(attempt, timestamp, step.id, run.id, runnerToken);
    if (claimed.changes !== 1) return null;
    const callIndex = (db
      .prepare<[number], { max_call_index: number | null }>(
        "SELECT MAX(call_index) AS max_call_index FROM tool_receipt WHERE work_run_id = ?",
      )
      .get(run.id)?.max_call_index ?? 0) + 1;
    const inserted = db
      .prepare<
        [
          number,
          number,
          ToolName,
          EffectKind,
          number | null,
          number,
          string,
          string,
          string,
        ]
      >(
        `INSERT INTO tool_receipt
           (work_run_id, work_step_id, tool_name, effect_kind, connector_capability_id,
            call_index, input_json, status, idempotency_key, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`,
      )
      .run(
        run.id,
        step.id,
        toolName,
        step.effect_kind,
        connectorCapabilityId,
        callIndex,
        JSON.stringify(
          sanitizeForReceipt({
            plan_id: run.work_plan_id,
            step_id: step.id,
            position: step.position,
            title: step.title,
            instruction: step.instruction,
            attempt,
          }),
        ),
        idempotencyKey,
        timestamp,
      );
    const receipt = db
      .prepare<[number], ToolReceipt>(`${SELECT_RECEIPT} WHERE id = ?`)
      .get(Number(inserted.lastInsertRowid));
    if (!receipt) throw new Error("Tool receipt vanished after insertion");
    return receipt;
  })();
}

function finishReceiptCompleted(
  db: Db,
  receiptId: number,
  output: unknown,
  citations: readonly unknown[],
): void {
  db.prepare<[string, string, string, number]>(
    `UPDATE tool_receipt
     SET status = 'completed', output_json = ?, citations_json = ?,
         completed_at = ?, error_code = NULL, error_message = NULL
     WHERE id = ? AND status = 'started'`,
  ).run(
    JSON.stringify(sanitizeForReceipt(output ?? null)),
    JSON.stringify(sanitizeForReceipt(citations)),
    now(),
    receiptId,
  );
}

function finishReceiptFailed(
  db: Db,
  receiptId: number,
  code: string,
  message: string,
): void {
  db.prepare<[string, string, string, number]>(
    `UPDATE tool_receipt
     SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?
     WHERE id = ? AND status = 'started'`,
  ).run(normalizeCode(code), safeErrorMessage(message), now(), receiptId);
}

function markRunRunning(db: Db, runId: number, planId: number, runnerToken: string): boolean {
  return db.transaction(() => {
    const timestamp = now();
    const updated = db.prepare<[string, number, string]>(
      `UPDATE work_run
       SET status = 'running', updated_at = ?, error_code = NULL, error_message = NULL
       WHERE id = ? AND runner_token = ? AND status IN ('queued','paused','running')`,
    ).run(timestamp, runId, runnerToken);
    if (updated.changes !== 1) return false;
    db.prepare<[string, number]>(
      "UPDATE work_plan SET status = 'running', updated_at = ? WHERE id = ?",
    ).run(timestamp, planId);
    return true;
  })();
}

function addRunCounts(
  db: Db,
  runId: number,
  modelCalls: number,
  toolCalls: number,
  preserveTerminal = false,
): void {
  const statusGuard = preserveTerminal ? "" : "AND status != 'cancelled'";
  db.prepare<[number, number, string, number]>(
    `UPDATE work_run
     SET model_call_count = model_call_count + ?,
         tool_call_count = tool_call_count + ?, updated_at = ?
     WHERE id = ? ${statusGuard}`,
  ).run(modelCalls, toolCalls, now(), runId);
}

function completeStep(db: Db, runId: number, stepId: number): void {
  const timestamp = now();
  db.prepare<[string, number]>(
    `UPDATE work_step
     SET status = 'completed', completed_at = ?, error_code = NULL, error_message = NULL
     WHERE id = ?`,
  ).run(timestamp, stepId);
  db.prepare<[number, string, number]>(
    "UPDATE work_run SET checkpoint_step_id = ?, updated_at = ? WHERE id = ?",
  ).run(stepId, timestamp, runId);
}

function pauseStepAndRun(
  db: Db,
  runId: number,
  planId: number,
  stepId: number,
  code: string,
  message: string | null,
): void {
  const before = statusBeforeTransition(db, runId);
  const normalizedCode = normalizeCode(code);
  const normalizedMessage = message === null ? null : safeErrorMessage(message);
  const timestamp = now();
  db.prepare<[string, string | null, number]>(
    `UPDATE work_step
     SET status = 'pending', error_code = ?, error_message = ? WHERE id = ?`,
  ).run(normalizedCode, normalizedMessage, stepId);
  db.prepare<[string, string | null, string, string, number]>(
    `UPDATE work_run
     SET status = 'paused', error_code = ?, error_message = ?, updated_at = ?
         , runner_token = NULL, runner_lease_until = NULL, paused_at = ?
     WHERE id = ? AND status != 'cancelled'`,
  ).run(normalizedCode, normalizedMessage, timestamp, timestamp, runId);
  db.prepare<[string, number]>(
    "UPDATE work_plan SET status = 'paused', updated_at = ? WHERE id = ?",
  ).run(timestamp, planId);
  logRunStopped(db, runId, before);
}

/**
 * Give back the time a run spent waiting on a person.
 *
 * `max_duration_seconds` bounds how long Zeus may work, not how long the user may think.
 * Charging deliberation against it meant a run that stopped for a decision died while the
 * user was reading — and the created event, already sent, was left attached to a plan that
 * could never finish. The authorization expiry is what bounds the user's window, and it is
 * deliberately untouched here: the deadline is only ever extended up to that ceiling.
 */
function resumeDeadline(db: Db, run: WorkRun, authorizationExpiresAt: string): string {
  if (!run.paused_at) return run.deadline_at;
  const parkedMs = Math.max(0, Date.now() - Date.parse(run.paused_at));
  const extended = Date.parse(run.deadline_at) + parkedMs;
  const ceiling = Date.parse(authorizationExpiresAt);
  const deadline = new Date(
    Number.isFinite(ceiling) ? Math.min(extended, ceiling) : extended,
  ).toISOString();
  db.prepare<[string, number, number]>(
    `UPDATE work_run
     SET deadline_at = ?, paused_at = NULL, paused_ms_total = paused_ms_total + ?
     WHERE id = ?`,
  ).run(deadline, parkedMs, run.id);
  return deadline;
}

function pauseRun(db: Db, runId: number, code: string, message: string): void {
  const run = requireWorkRun(db, runId);
  const timestamp = now();
  db.transaction(() => {
    db.prepare<[string, string, string, number]>(
      `UPDATE work_run
       SET status = 'paused', error_code = ?, error_message = ?, updated_at = ?
           , runner_token = NULL, runner_lease_until = NULL
       WHERE id = ? AND status NOT IN ('completed','cancelled')`,
    ).run(normalizeCode(code), safeErrorMessage(message), timestamp, runId);
    db.prepare<[string, number]>(
      `UPDATE work_plan SET status = 'paused', updated_at = ?
       WHERE id = ? AND status NOT IN ('completed','cancelled')`,
    ).run(timestamp, run.work_plan_id);
  })();
  logRunStopped(db, runId, run.status);
}

function failStepAndRun(
  db: Db,
  runId: number,
  planId: number,
  stepId: number,
  code: string,
  message: string,
): void {
  const before = statusBeforeTransition(db, runId);
  db.transaction(() => {
    const timestamp = now();
    const normalizedCode = normalizeCode(code);
    const normalizedMessage = safeErrorMessage(message);
    db.prepare<[string, string, string, number]>(
      `UPDATE work_step
       SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?
       WHERE id = ?`,
    ).run(normalizedCode, normalizedMessage, timestamp, stepId);
    db.prepare<[string, string, string, string, number]>(
      `UPDATE work_run
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?,
           completed_at = ?, runner_token = NULL, runner_lease_until = NULL
       WHERE id = ? AND status != 'cancelled'`,
    ).run(normalizedCode, normalizedMessage, timestamp, timestamp, runId);
    db.prepare<[string, number]>(
      "UPDATE work_plan SET status = 'failed', updated_at = ? WHERE id = ?",
    ).run(timestamp, planId);
  })();
  logRunStopped(db, runId, before);
}

function failRun(
  db: Db,
  runId: number,
  planId: number,
  code: string,
  message: string,
): void {
  const before = statusBeforeTransition(db, runId);
  const timestamp = now();
  db.transaction(() => {
    db.prepare<[string, string, string, string, number]>(
      `UPDATE work_run
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?,
           completed_at = ?, runner_token = NULL, runner_lease_until = NULL
       WHERE id = ? AND status != 'cancelled'`,
    ).run(normalizeCode(code), safeErrorMessage(message), timestamp, timestamp, runId);
    db.prepare<[string, number]>(
      "UPDATE work_plan SET status = 'failed', updated_at = ? WHERE id = ?",
    ).run(timestamp, planId);
  })();
  logRunStopped(db, runId, before);
}

function completeRun(db: Db, runId: number, planId: number): void {
  const before = statusBeforeTransition(db, runId);
  const timestamp = now();
  db.transaction(() => {
    db.prepare<[string, string, number]>(
      `UPDATE work_run
       SET status = 'completed', updated_at = ?, completed_at = ?,
           error_code = NULL, error_message = NULL,
           runner_token = NULL, runner_lease_until = NULL WHERE id = ?`,
    ).run(timestamp, timestamp, runId);
    db.prepare<[string, string, number]>(
      `UPDATE work_plan
       SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?`,
    ).run(timestamp, timestamp, planId);
  })();
  logRunStopped(db, runId, before);
}

/**
 * The two halves of a run's life, reported from the transitions that make it.
 *
 * A run owes the person an answer from the moment it is queued until it stops, and both
 * lines describe that one set: `work_run_started` when a run joins it — created, or
 * resumed out of a checkpoint — and `work_run_stopped` when a run leaves it. Kept exactly
 * paired on purpose, because the first thing an operator does with them is subtract, and a
 * gauge that drifts negative does not merely mislead about work runs, it teaches its
 * reader to distrust every number in the stream.
 *
 * Without them, "did that run die or is it still going?" has no answer outside the store,
 * and a store that has stopped running work at all looks exactly like one nobody asked to
 * do any.
 */
function logRunStarted(db: Db, planId: number, runId: number): void {
  logEvent({
    event: "work_run_started",
    outcome: "ok",
    plan_id: planId,
    run_id: runId,
    ...accountEvent(db),
  });
}

/**
 * `before` is the status the run held when the caller began its transition, and a run that
 * had already stopped reports nothing, because nothing stopped. Cancelling a run parked at
 * a checkpoint, a guarded UPDATE that did not apply because the person cancelled a moment
 * earlier, and every retried resume of a run whose authorization is gone each restate a
 * stop already reported — and each would be a stop with no start left to close.
 *
 * A bounded run can hold a request for fifteen minutes, spend twenty model calls, and end
 * in any of four states, so the state it ended in is the payload. It is Zeus's own closed
 * vocabulary and safe to name; the `error_code` stored beside it deliberately is not: a
 * safe executor supplies its own codes, and `normalizeCode` would render a sentence about
 * the user as one long snake_case token that the log's shapes cannot tell apart from a
 * code Zeus wrote.
 */
function logRunStopped(db: Db, runId: number, before: WorkRunStatus | null): void {
  if (before !== "queued" && before !== "running") return;
  try {
    const run = getWorkRun(db, runId);
    if (!run || run.status === "queued" || run.status === "running") return;
    logEvent({
      event: "work_run_stopped",
      // Cancellation is the user's decision and completion is the point of the run;
      // neither is a fault. A pause is work left undone, which an operator should see.
      outcome: run.status === "failed" ? "error" : run.status === "paused" ? "degraded" : "ok",
      reason: run.status,
      plan_id: run.work_plan_id,
      run_id: run.id,
      count: run.model_call_count + run.tool_call_count,
      duration_ms: runAgeMs(run),
      ...accountEvent(db),
    });
  } catch {
    // Most callers are mid-transaction — several inside an outer one that still owes the
    // store a receipt failure, a pause, and a revoked authorization. A throw from this
    // read would roll all of that back and surface as a failed turn, so a diagnostic
    // would have caused the incident it exists to describe. Losing the line is cheaper.
  }
}

/**
 * The run's status as it stands before a caller changes it, for transitions that do not
 * already hold the row. Best effort for the same reason `logRunStopped` is: reading a
 * value for a log line must never be able to fail the write it accompanies, and an
 * unknown prior state is reported as no stop rather than as a possibly duplicate one.
 */
function statusBeforeTransition(db: Db, runId: number): WorkRunStatus | null {
  try {
    return getWorkRun(db, runId)?.status ?? null;
  } catch {
    return null;
  }
}

/**
 * How long the run had been alive when it stopped, pauses included — the same clock
 * `deadline_at` is set against, so a run that died at its ceiling and a run that died in
 * two seconds stay distinguishable.
 */
function runAgeMs(run: WorkRun): number | undefined {
  const startedAt = Date.parse(run.started_at);
  const stoppedAt = Date.parse(run.completed_at ?? run.updated_at);
  return Number.isFinite(startedAt) && Number.isFinite(stoppedAt)
    ? stoppedAt - startedAt
    : undefined;
}

/**
 * The runner lease changing hands, which is otherwise entirely invisible: a run whose
 * work is being redone by two processes, and a run whose runner died mid-step, both look
 * from the outside like a run that is simply slow.
 */
function logLeaseLost(
  db: Db,
  run: WorkRun,
  reason: "already_leased" | "expired" | "ownership_lost",
): void {
  logEvent({
    event: "work_run_lease_lost",
    outcome: "degraded",
    reason,
    plan_id: run.work_plan_id,
    run_id: run.id,
    ...accountEvent(db),
  });
}

function normalizeExecutionResult(result: SafeStepExecutionResult): Required<
  Pick<SafeStepExecutionResult, "modelCalls" | "toolCalls" | "citations" | "artifacts">
> &
  Pick<SafeStepExecutionResult, "output" | "pause"> {
  // An executor that reports nothing is still charged one call, so forgetting to account
  // for work cannot make it free. Claiming zero explicitly is a different, legitimate
  // claim: a step that spans a confirmation only re-reads the request it already made when
  // the run resumes, and the send itself was the user's instruction rather than the
  // autonomous work this budget exists to bound.
  const modelCalls = boundedCount(result.modelCalls ?? 0, "modelCalls");
  const toolCalls = boundedCount(result.toolCalls ?? 1, "toolCalls");
  return {
    output: result.output,
    citations: result.citations ?? [],
    artifacts: (result.artifacts ?? []).map(normalizeArtifact),
    modelCalls,
    toolCalls,
    pause: result.pause,
  };
}

function normalizeExecutionError(error: unknown): WorkStepExecutionError {
  if (error instanceof WorkStepExecutionError) return error;
  return new WorkStepExecutionError(
    error instanceof Error ? error.message : "Safe work executor failed",
  );
}

function normalizeArtifact(input: WorkArtifactInput): Required<WorkArtifactInput> {
  const title = input.title.replace(/\s+/gu, " ").trim();
  if (!title || title.length > 240) throw new Error("Artifact title must be 1-240 characters");
  const content = redactSecrets(input.content.trim());
  if (!content || content.length > MAX_ARTIFACT_CONTENT) {
    throw new Error(`Artifact content must be 1-${MAX_ARTIFACT_CONTENT} characters`);
  }
  if (!(["draft", "comparison", "report", "research_notes"] as const).includes(input.kind)) {
    throw new Error("Unsupported work artifact kind");
  }
  const sanitized = sanitizeForReceipt(input.citations ?? []);
  return {
    kind: input.kind,
    title,
    content,
    citations: Array.isArray(sanitized) ? sanitized : [],
    sourceMessageIds: [...new Set(input.sourceMessageIds ?? [])].filter(
      (id) => Number.isInteger(id) && id > 0,
    ),
    sourceMemoryItems: [...(input.sourceMemoryItems ?? [])],
  };
}

function normalizeArtifactMemorySources(
  db: Db,
  sources: readonly { sourceKind: WorkPlanMemorySourceKind; sourceId: number; snapshot: unknown }[],
): Array<{ sourceKind: WorkPlanMemorySourceKind; sourceId: number; snapshotJson: string }> {
  const byKey = new Map<
    string,
    { sourceKind: WorkPlanMemorySourceKind; sourceId: number; snapshotJson: string }
  >();
  for (const source of sources) {
    if (!Number.isInteger(source.sourceId) || source.sourceId <= 0) {
      throw new Error("Artifact memory provenance requires a positive source id");
    }
    const exists = db.prepare<[number], { found: number }>(
      source.sourceKind === "fact"
        ? "SELECT 1 AS found FROM fact WHERE id = ?"
        : "SELECT 1 AS found FROM understanding_facet WHERE id = ?",
    ).get(source.sourceId);
    if (!exists) throw new Error("An artifact memory source was deleted before persistence");
    const snapshotJson = canonicalJson(parseJsonValue(source.snapshot, "artifact memory snapshot"));
    byKey.set(`${source.sourceKind}:${source.sourceId}`, {
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      snapshotJson,
    });
  }
  return [...byKey.values()].sort(compareMemorySources);
}

function toolNameFor(effect: EffectKind): ToolName {
  switch (effect) {
    case "memory_read":
      return "memory_recall";
    case "web_read":
      return "web_search";
    case "prepare_local":
      return "local_artifact";
    case "external_read":
      return "connector_call";
    default:
      // A write effect prepares a request and stops. Only the later confirmed send is a
      // `connector_call`, so the step that produced the proposal must not claim to be one.
      return "effect_proposal";
  }
}

function minimumCallCostForEffect(effect: EffectKind): number {
  return effect === "memory_read" ? 1 : 2;
}

/**
 * The smallest call budget under which every step could still run.
 *
 * Exported because the model picks its own limits and can lowball them. A plan whose own
 * ceiling cannot cover its own steps is dead on arrival — and it fails late, after
 * spending calls and producing artifacts, which is the worst moment to find out.
 */
export function minimumCallBudgetForSteps(
  steps: readonly { effect_kind: EffectKind }[],
): number {
  return steps.reduce((total, step) => total + minimumCallCostForEffect(step.effect_kind), 0);
}

/**
 * Refuse a plan that could never finish.
 *
 * Checked at creation rather than discovered mid-run: a plan that runs out of budget on
 * its last step has already spent model calls and left artifacts, and when that last step
 * is the one that would have asked the user to confirm an action, the user is left with a
 * failure instead of a decision.
 */
function assertRunnableLimits(proposal: WorkPlanProposal): void {
  const required = minimumCallBudgetForSteps(proposal.steps);
  if (required > MAX_MODEL_TOOL_CALLS) {
    throw new Error(
      `This plan needs at least ${required} model/tool calls, above the ${MAX_MODEL_TOOL_CALLS} ceiling`,
    );
  }
  if (proposal.limits.max_model_tool_calls < required) {
    throw new Error(
      `This plan allows ${proposal.limits.max_model_tool_calls} model/tool calls but its steps need at least ${required}`,
    );
  }
}

/**
 * What this store may authorize right now.
 *
 * Deliberately separate from parsing: an effect becomes authorizable only when a bound,
 * enabled capability provides it, and that can change after a plan is written. `purchase`
 * is refused unconditionally — money is a different threat model and has no slot.
 */
function assertAuthorizableEffects(db: Db, effects: readonly EffectKind[]): void {
  for (const effect of effects) {
    if ((SAFE_EFFECT_KINDS as readonly EffectKind[]).includes(effect)) continue;
    if (effect === "purchase") {
      throw new Error("Zeus cannot be authorized to spend money");
    }
    if (!isConnectorEffect(effect) || !availableCapabilityForEffect(db, effect)) {
      throw new Error(
        `Effect ${effect} is unavailable without a connected service that provides it`,
      );
    }
  }
}

function uniqueEffects(effects: readonly EffectKind[]): EffectKind[] {
  return [...new Set(effects)].sort();
}

/**
 * Read stored effects without judging them.
 *
 * Policy deliberately lives at authorize and execute time instead. A plan written when a
 * calendar was connected must still *load* after that connector is removed — its hash,
 * its authorization record, and its receipts are audit data, and history that stops being
 * readable when configuration changes is not an audit trail.
 */
function parseEffects(json: string): EffectKind[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("Invalid stored work-plan effects");
  const effects = value.map((entry) => {
    const parsed = EffectKindSchema.safeParse(entry);
    if (!parsed.success) throw new Error("Invalid stored work-plan effect");
    return parsed.data;
  });
  return uniqueEffects(effects);
}

function parseStringArray(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid stored work-plan completion criteria");
  }
  return value as string[];
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((entry, index) => entry === right[index]);
}

function assertUserMessage(db: Db, id: number): void {
  const role = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(id)?.role;
  if (role !== "user") throw new Error("Work-plan provenance must be a stored user message");
}

function assertUserMessages(db: Db, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const count = db.prepare<unknown[], { count: number }>(
    `SELECT COUNT(*) AS count FROM message
     WHERE role = 'user' AND id IN (${ids.map(() => "?").join(",")})`,
  ).get(...ids)?.count ?? 0;
  if (count !== ids.length) {
    throw new Error("Work-plan memory provenance requires stored user-message evidence");
  }
}

function assertExactApprovalMessage(db: Db, id: number, planHash: string): void {
  const message = db
    .prepare<[number], { role: string; content: string }>(
      "SELECT role, content FROM message WHERE id = ?",
    )
    .get(id);
  if (message?.role !== "user") {
    throw new Error("Work-plan approval must be a stored user message");
  }
  if (!isExactApproval(message.content, planHash)) {
    throw new Error("User approval must explicitly approve the exact work-plan hash");
  }
}

function isExactApproval(content: string, planHash: string): boolean {
  return parseWorkPlanApproval(content)?.hash === planHash.toLowerCase();
}

function sourceInstructionDigest(db: Db, id: number): string {
  const message = db
    .prepare<[number], { role: string; content: string }>(
      "SELECT role, content FROM message WHERE id = ?",
    )
    .get(id);
  if (message?.role !== "user") {
    throw new Error("Work-plan provenance must be a stored user message");
  }
  return createHash("sha256").update(message.content, "utf8").digest("hex");
}

function assertAcyclic(dependencies: readonly (readonly number[])[]): void {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (position: number): void => {
    if (visiting.has(position)) throw new Error("Work-step dependencies must be acyclic");
    if (visited.has(position)) return;
    visiting.add(position);
    for (const dependency of dependencies[position - 1] ?? []) visit(dependency);
    visiting.delete(position);
    visited.add(position);
  };
  dependencies.forEach((_entry, index) => visit(index + 1));
}

function normalizeFutureDate(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error(`${label} must be a future ISO-8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function boundedPositiveInt(value: number, max: number, label: string): number {
  return boundedInt(value, 1, max, label);
}

function boundedInt(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boundedCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_MODEL_TOOL_CALLS) {
    throw new Error(`${label} must be an integer between 0 and ${MAX_MODEL_TOOL_CALLS}`);
  }
  return value;
}

function normalizeCode(value: string): string {
  const code = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
  return code || "work_error";
}

function safeErrorMessage(value: string): string {
  return redactSecrets(value.replace(/\s+/gu, " ").trim()).slice(0, MAX_ERROR_MESSAGE);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sanitizeForReceipt(value: unknown, depth = 0, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactSecrets(value).slice(0, MAX_RECEIPT_STRING);
  if (typeof value === "bigint") return value.toString();
  if (depth >= 7) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeForReceipt(entry, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, 100)) {
      output[entryKey] = sanitizeForReceipt(entryValue, depth + 1, entryKey);
    }
    return output;
  }
  return null;
}

const SENSITIVE_KEY = /(^|_)(api_?key|authorization|cookie|credential|password|secret|token)($|_)/iu;

function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/giu, "$1[REDACTED]")
    .replace(
      /\b(password|passcode|api[_ -]?key|secret|token)\s*[:=]\s*\S{6,}/giu,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:\d[ -]*?){13,19}\b/gu, "[REDACTED]");
}

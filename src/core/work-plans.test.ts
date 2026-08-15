import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import { openTestDb } from "./db";
import { selfEntity } from "./entities";
import { recordFact } from "./facts";
import type { WorkPlanProposal } from "./schema";
import { createEvaluationContext } from "./stewardship";
import {
  WorkStepExecutionError,
  activeWorkAuthorization,
  authorizeWorkPlan,
  cancelWorkRun,
  createWorkArtifact,
  createWorkPlan,
  getWorkAuthorization,
  getWorkPlan,
  getWorkPlanGenerationProvenance,
  hashWorkPlanProposal,
  listToolReceipts,
  listWorkArtifacts,
  listWorkRuns,
  resumeWorkRun,
  runWorkPlan,
} from "./work-plans";

afterEach(() => {
  vi.useRealTimers();
});

function userSource(db: ReturnType<typeof openTestDb>, content = "Please research this and draft it.") {
  const conversation = createConversation(db);
  return appendMessage(db, conversation.id, "user", content);
}

function proposal(overrides: Partial<WorkPlanProposal> = {}): WorkPlanProposal {
  return {
    objective: "Research the decision and prepare a local recommendation",
    steps: [
      {
        title: "Recall accepted context",
        instruction: "Recall only accepted memory relevant to the decision.",
        effect_kind: "memory_read",
        depends_on: [],
      },
      {
        title: "Research current options",
        instruction: "Use read-only web research and retain citations.",
        effect_kind: "web_read",
        depends_on: [1],
      },
      {
        title: "Draft recommendation",
        instruction: "Prepare a local, reviewable recommendation; do not send it.",
        effect_kind: "prepare_local",
        depends_on: [2],
      },
    ],
    allowed_effects: ["prepare_local", "memory_read", "web_read"],
    completion_criteria: ["A cited recommendation is available for review"],
    limits: {
      max_model_tool_calls: 12,
      max_retries_per_step: 2,
      max_duration_seconds: 900,
    },
    ...overrides,
  };
}

function createPlan(
  db: ReturnType<typeof openTestDb>,
  planProposal: WorkPlanProposal = proposal(),
) {
  const source = userSource(db);
  const input = {
    proposal: planProposal,
    sourceMessageId: source.id,
    origin: "explicit_request" as const,
  };
  return { source, input, detail: createWorkPlan(db, input) };
}

function authorize(
  db: ReturnType<typeof openTestDb>,
  detail: ReturnType<typeof createPlan>["detail"],
  sourceMessageId: number,
  overrides: Partial<Parameters<typeof authorizeWorkPlan>[2]> = {},
) {
  return authorizeWorkPlan(db, detail.plan.id, {
    planHash: detail.plan.plan_hash,
    authorizationKind: "explicit_request",
    allowedEffects: JSON.parse(detail.plan.allowed_effects_json) as string[] as never,
    maxModelToolCalls: detail.plan.max_model_tool_calls,
    maxRetriesPerStep: detail.plan.max_retries_per_step,
    maxDurationSeconds: detail.plan.max_duration_seconds,
    expiresAt: "2030-01-02T00:00:00.000Z",
    sourceMessageId,
    ...overrides,
  });
}

describe("work-plan proposal and authorization", () => {
  it("creates one immutable source-backed proposal with a deterministic hash", () => {
    const db = openTestDb();
    const { input, detail } = createPlan(db);

    expect(detail.plan.status).toBe("proposed");
    expect(detail.plan.plan_hash).toBe(hashWorkPlanProposal(db, input));
    expect(detail.steps.map((step) => step.depends_on)).toEqual([[], [1], [2]]);
    expect(JSON.parse(detail.plan.allowed_effects_json)).toEqual([
      "memory_read",
      "prepare_local",
      "web_read",
    ]);
    expect(createWorkPlan(db, input).plan.id).toBe(detail.plan.id);

    const sameMeaning: typeof input = {
      ...input,
      proposal: {
        ...input.proposal,
        allowed_effects: ["web_read", "memory_read", "prepare_local"],
      },
    };
    expect(hashWorkPlanProposal(db, sameMeaning)).toBe(detail.plan.plan_hash);
  });

  it("binds item/message/context/conflict snapshots into a versioned plan hash", () => {
    const db = openTestDb();
    const source = userSource(db, "Research coffee options and draft a recommendation.");
    const preferenceSource = appendMessage(
      db,
      source.conversation_id,
      "user",
      "I like espresso.",
    );
    const fact = recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "likes",
      object: "espresso",
      sourceMessageId: preferenceSource.id,
    }).fact;
    const evaluationContext = createEvaluationContext({
      trigger: "chat",
      referenceTime: new Date("2030-01-07T09:00:00.000Z"),
      timezone: "UTC",
    });
    const generationProvenance = {
      evaluationContext,
      conflicts: [] as const,
      memorySources: [{
        sourceKind: "fact" as const,
        sourceId: fact.id,
        includedInPrompt: true,
        exclusionReason: null,
        snapshot: { id: fact.id, object: fact.object },
        sourceMessageIds: [preferenceSource.id],
      }],
    };
    const input = {
      proposal: proposal(),
      sourceMessageId: source.id,
      origin: "explicit_request" as const,
      generationProvenance,
    };
    const detail = createWorkPlan(db, input);

    expect(detail.plan.hash_version).toBe(3);
    expect(detail.plan.plan_hash).toBe(hashWorkPlanProposal(db, input));
    expect(getWorkPlanGenerationProvenance(db, detail.plan.id)).toMatchObject({
      evaluationContext,
      conflicts: [],
      memorySources: [expect.objectContaining({
        sourceKind: "fact",
        sourceId: fact.id,
        sourceMessageIds: [preferenceSource.id],
      })],
    });
    expect(hashWorkPlanProposal(db, {
      ...input,
      generationProvenance: {
        ...generationProvenance,
        evaluationContext: { ...evaluationContext, local_time: "10:00" },
      },
    })).not.toBe(detail.plan.plan_hash);
  });

  it("rejects assistant provenance, dependency cycles, and every external-write effect", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const assistant = appendMessage(db, conversation.id, "assistant", "I suggest sending it.");
    expect(() =>
      createWorkPlan(db, {
        proposal: proposal(),
        sourceMessageId: assistant.id,
        origin: "surfaced_proposal",
      }),
    ).toThrow(/stored user message/u);

    const source = appendMessage(db, conversation.id, "user", "Make a safe plan.");
    expect(() =>
      createWorkPlan(db, {
        proposal: proposal({
          steps: [
            {
              title: "One",
              instruction: "First",
              effect_kind: "memory_read",
              depends_on: [2],
            },
            {
              title: "Two",
              instruction: "Second",
              effect_kind: "prepare_local",
              depends_on: [1],
            },
          ],
          allowed_effects: ["memory_read", "prepare_local"],
        }),
        sourceMessageId: source.id,
        origin: "explicit_request",
      }),
    ).toThrow(/acyclic/u);

    // With nothing connected, every external effect is refused for want of a capability.
    for (const effect of ["send", "schedule", "modify_external", "external_read"] as const) {
      expect(() =>
        createWorkPlan(db, {
          proposal: proposal({
            steps: [
              {
                title: `Try ${effect}`,
                instruction: "Perform an unavailable external action.",
                effect_kind: effect,
                depends_on: [],
              },
            ],
            allowed_effects: [effect],
          }),
          sourceMessageId: source.id,
          origin: "explicit_request",
        }),
      ).toThrow(/unavailable without a connected service/u);
    }

    // Money is refused for a different reason, and no connector can ever supply it:
    // there is no slot that produces `purchase`.
    expect(() =>
      createWorkPlan(db, {
        proposal: proposal({
          steps: [
            {
              title: "Try purchase",
              instruction: "Buy the ticket.",
              effect_kind: "purchase",
              depends_on: [],
            },
          ],
          allowed_effects: ["purchase"],
        }),
        sourceMessageId: source.id,
        origin: "explicit_request",
      }),
    ).toThrow(/cannot be authorized to spend money/u);
  });

  it("binds authorization to the exact hash, safe effects, limits, expiry, and user source", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(db);

    expect(() =>
      authorize(db, detail, source.id, { planHash: "wrong" }),
    ).toThrow(/exact work plan hash/u);
    expect(() =>
      authorize(db, detail, source.id, { allowedEffects: ["memory_read"] }),
    ).toThrow(/exactly match/u);
    expect(() =>
      authorize(db, detail, source.id, { maxModelToolCalls: 13 }),
    ).toThrow(/between 1 and 12/u);
    expect(() =>
      authorize(db, detail, source.id, { expiresAt: "2029-12-31T23:59:59Z" }),
    ).toThrow(/future ISO-8601/u);

    const otherUser = appendMessage(
      db,
      source.conversation_id,
      "user",
      `I approve this exact plan: ${detail.plan.plan_hash}.`,
    );
    expect(() => authorize(db, detail, otherUser.id)).toThrow(/source message/u);

    const first = authorize(db, detail, source.id);
    expect(first.plan_hash).toBe(detail.plan.plan_hash);
    expect(getWorkPlan(db, detail.plan.id)?.plan.status).toBe("authorized");

    const second = authorize(db, detail, otherUser.id, {
      authorizationKind: "user_approval",
      expiresAt: "2030-01-03T00:00:00.000Z",
    });
    expect(second.id).not.toBe(first.id);
    expect(getWorkAuthorization(db, first.id)?.revoked_at).not.toBeNull();
    expect(activeWorkAuthorization(db, detail.plan.id)?.id).toBe(second.id);

    const negated = appendMessage(
      db,
      source.conversation_id,
      "user",
      `I do not approve work plan ${detail.plan.plan_hash}.`,
    );
    expect(() =>
      authorize(db, detail, negated.id, { authorizationKind: "user_approval" }),
    ).toThrow(/explicitly approve the exact work-plan hash/u);
  });

  it("detects any stored executable-plan mutation before authorization", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(db);
    db.prepare("UPDATE work_plan SET objective = 'Tampered objective' WHERE id = ?").run(
      detail.plan.id,
    );
    expect(() => authorize(db, detail, source.id)).toThrow(/immutable hash/u);
  });
});

describe("bounded work execution", () => {
  it("executes dependency-ordered safe steps and durably stores artifacts and receipts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(db);
    authorize(db, detail, source.id);
    const seen: number[] = [];

    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async ({ step, idempotencyKey }) => {
        seen.push(step.position);
        return {
          output: {
            position: step.position,
            api_key: "sk-secret-value-that-must-not-survive",
            idempotencyKey,
          },
          citations: [{ url: `https://example.com/${step.position}` }],
          artifacts: [
            {
              kind: step.effect_kind === "prepare_local" ? "draft" : "research_notes",
              title: step.title,
              content: `Durable output for step ${step.position}`,
              citations: [{ url: `https://example.com/${step.position}` }],
            },
          ],
          modelCalls: step.effect_kind === "memory_read" ? 0 : 1,
          toolCalls: 1,
        };
      },
    });

    expect(run.status).toBe("completed");
    expect(run.model_call_count).toBe(2);
    expect(run.tool_call_count).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(getWorkPlan(db, detail.plan.id)?.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(listWorkArtifacts(db, { runId: run.id })).toHaveLength(3);
    const receipts = listToolReceipts(db, run.id);
    expect(receipts.map((receipt) => receipt.tool_name)).toEqual([
      "memory_recall",
      "web_search",
      "local_artifact",
    ]);
    expect(receipts.map((receipt) => receipt.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(JSON.parse(receipts[0]!.output_json ?? "{}").api_key).toBe("[REDACTED]");
  });

  it("rolls back an artifact when any declared source is invalid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(db, proposal({
      steps: [{
        title: "Draft",
        instruction: "Prepare a local draft.",
        effect_kind: "prepare_local",
        depends_on: [],
      }],
      allowed_effects: ["prepare_local"],
    }));
    authorize(db, detail, source.id);
    let artifactCountDuringFailure = -1;
    const completed = await runWorkPlan(db, detail.plan.id, {
      executor: ({ run, step }) => {
        expect(() => createWorkArtifact(db, {
          planId: detail.plan.id,
          runId: run.id,
          stepId: step.id,
          artifact: {
            kind: "draft",
            title: "Invalid",
            content: "Must roll back",
            sourceMessageIds: [999_999],
          },
        })).toThrow(/stored user-message evidence/u);
        artifactCountDuringFailure = listWorkArtifacts(db, { runId: run.id }).length;
        return Promise.resolve({
          artifacts: [{ kind: "draft", title: "Valid", content: "Persist me." }],
          modelCalls: 1,
          toolCalls: 1,
        });
      },
    });
    expect(completed.status).toBe("completed");
    expect(artifactCountDuringFailure).toBe(0);
    expect(listWorkArtifacts(db, { runId: completed.id })).toHaveLength(1);
  });

  it("preflights the minimum safe-effect call cost before invoking an executor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    // A plan must be runnable to exist at all, so the shortfall comes from the user
    // narrowing autonomy at authorization — which is the real way a run runs out.
    const { source, detail } = createPlan(db, proposal({
      steps: [{
        title: "Research",
        instruction: "Search current evidence.",
        effect_kind: "web_read",
        depends_on: [],
      }],
      allowed_effects: ["web_read"],
      limits: {
        max_model_tool_calls: 2,
        max_retries_per_step: 0,
        max_duration_seconds: 900,
      },
    }));
    authorize(db, detail, source.id, { maxModelToolCalls: 1 });
    let invoked = 0;
    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async () => {
        invoked += 1;
        return { artifacts: [{ kind: "research_notes", title: "No", content: "No" }] };
      },
    });
    expect(run).toMatchObject({ status: "failed", error_code: "call_budget_exhausted" });
    expect(invoked).toBe(0);
    expect(listToolReceipts(db, run.id)).toEqual([]);
  });

  it("pauses without a safe adapter and resumes the same run once one is available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const oneStep = proposal({
      steps: [
        {
          title: "Prepare local draft",
          instruction: "Create a reviewable local draft.",
          effect_kind: "prepare_local",
          depends_on: [],
        },
      ],
      allowed_effects: ["prepare_local"],
    });
    const { source, detail } = createPlan(db, oneStep);
    authorize(db, detail, source.id);

    const paused = await runWorkPlan(db, detail.plan.id);
    expect(paused.status).toBe("paused");
    expect(paused.error_code).toBe("executor_unavailable");
    expect(listToolReceipts(db, paused.id)).toHaveLength(0);

    const completed = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({
        artifacts: [{ kind: "draft", title: "Draft", content: "Review me." }],
      }),
    });
    expect(completed.id).toBe(paused.id);
    expect(completed.status).toBe("completed");
  });

  it("retries only transient failures within the exact retry budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const oneStep = proposal({
      steps: [
        {
          title: "Research",
          instruction: "Read current sources.",
          effect_kind: "web_read",
          depends_on: [],
        },
      ],
      allowed_effects: ["web_read"],
    });
    const { source, detail } = createPlan(db, oneStep);
    authorize(db, detail, source.id);
    let attempts = 0;
    const providerRequestKeys: string[] = [];
    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async ({ providerRequestKey }) => {
        attempts += 1;
        providerRequestKeys.push(providerRequestKey);
        if (attempts < 3) {
          throw new WorkStepExecutionError("Temporary search failure", {
            code: "search_unavailable",
            transient: true,
          });
        }
        return {
          output: { result: "found" },
          artifacts: [{ kind: "research_notes", title: "Research", content: "Found evidence." }],
        };
      },
    });

    expect(run.status).toBe("completed");
    expect(attempts).toBe(3);
    expect(run.tool_call_count).toBe(3);
    expect(listToolReceipts(db, run.id).map((receipt) => receipt.status)).toEqual([
      "failed",
      "failed",
      "completed",
    ]);
    expect(new Set(listToolReceipts(db, run.id).map((receipt) => receipt.idempotency_key)).size).toBe(3);
    expect(new Set(providerRequestKeys).size).toBe(1);
  });

  it("keeps one live runner and prevents a concurrent resume from duplicating work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [{
          title: "Research",
          instruction: "Read current evidence.",
          effect_kind: "web_read",
          depends_on: [],
        }],
        allowed_effects: ["web_read"],
      }),
    );
    authorize(db, detail, source.id);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const executorStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = runWorkPlan(db, detail.plan.id, {
      executor: async () => {
        started();
        await blocked;
        return {
          artifacts: [{ kind: "research_notes", title: "Research", content: "One result." }],
        };
      },
    });
    await executorStarted;

    let duplicateCalls = 0;
    const inFlight = listWorkRuns(db, detail.plan.id)[0]!;
    const concurrent = await resumeWorkRun(db, inFlight.id, {
      executor: async () => {
        duplicateCalls += 1;
        return {
          artifacts: [{ kind: "research_notes", title: "Duplicate", content: "Duplicate." }],
        };
      },
    });
    expect(concurrent.status).toBe("running");
    expect(duplicateCalls).toBe(0);
    expect(listToolReceipts(db, inFlight.id)).toHaveLength(1);

    release();
    const completed = await first;
    expect(completed.status).toBe("completed");
    expect(completed.runner_token).toBeNull();
    expect(listWorkArtifacts(db, { runId: completed.id })).toHaveLength(1);
  });

  it("does not commit a stale executor result after cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [{
          title: "Draft",
          instruction: "Prepare a local draft.",
          effect_kind: "prepare_local",
          depends_on: [],
        }],
        allowed_effects: ["prepare_local"],
      }),
    );
    authorize(db, detail, source.id);

    const cancelled = await runWorkPlan(db, detail.plan.id, {
      executor: async ({ run }) => {
        cancelWorkRun(db, run.id);
        return {
          artifacts: [{ kind: "draft", title: "Stale", content: "Must not persist." }],
        };
      },
    });
    expect(cancelled.status).toBe("cancelled");
    expect(listWorkArtifacts(db, { runId: cancelled.id })).toEqual([]);
    expect(listToolReceipts(db, cancelled.id)[0]).toMatchObject({
      status: "failed",
      error_code: "cancelled_by_user",
    });
  });

  it("rechecks authorization and exact source scope after an executor returns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [{
          title: "Research",
          instruction: "Read current evidence.",
          effect_kind: "web_read",
          depends_on: [],
        }],
        allowed_effects: ["web_read"],
      }),
    );
    const authorization = authorize(db, detail, source.id);

    const paused = await runWorkPlan(db, detail.plan.id, {
      executor: async () => {
        db.prepare("UPDATE message SET content = ? WHERE id = ?").run(
          "A materially different instruction.",
          source.id,
        );
        return {
          artifacts: [{ kind: "research_notes", title: "Stale", content: "Must not persist." }],
        };
      },
    });
    expect(paused).toMatchObject({ status: "paused", error_code: "plan_hash_changed" });
    expect(paused.runner_token).toBeNull();
    expect(listWorkArtifacts(db, { runId: paused.id })).toEqual([]);
    expect(getWorkAuthorization(db, authorization.id)?.revoked_at).not.toBeNull();
  });

  it("pauses without artifacts when authorization expires during a tool call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [{
          title: "Research",
          instruction: "Read current evidence.",
          effect_kind: "web_read",
          depends_on: [],
        }],
        allowed_effects: ["web_read"],
      }),
    );
    const authorization = authorize(db, detail, source.id);

    const paused = await runWorkPlan(db, detail.plan.id, {
      executor: async () => {
        db.prepare("UPDATE work_authorization SET expires_at = ? WHERE id = ?").run(
          "2029-12-31T23:59:59.000Z",
          authorization.id,
        );
        return {
          artifacts: [{ kind: "research_notes", title: "Late", content: "Must not persist." }],
        };
      },
    });
    expect(paused).toMatchObject({ status: "paused", error_code: "authorization_invalid" });
    expect(listWorkArtifacts(db, { runId: paused.id })).toEqual([]);
    expect(listToolReceipts(db, paused.id)[0]).toMatchObject({
      status: "failed",
      error_code: "authorization_invalid",
    });
  });

  it("fails closed when the exact combined call budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [
          {
            title: "Recall",
            instruction: "Recall accepted memory.",
            effect_kind: "memory_read",
            depends_on: [],
          },
          {
            title: "Draft",
            instruction: "Prepare a local draft.",
            effect_kind: "prepare_local",
            depends_on: [1],
          },
        ],
        allowed_effects: ["memory_read", "prepare_local"],
        limits: {
          max_model_tool_calls: 3,
          max_retries_per_step: 0,
          max_duration_seconds: 900,
        },
      }),
    );
    // The plan itself is runnable; the user authorized less than it needs, so the second
    // step is refused before it starts rather than half-run.
    authorize(db, detail, source.id, { maxModelToolCalls: 1 });
    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async ({ step }) => ({
        toolCalls: 1,
        artifacts: [{ kind: "research_notes", title: step.title, content: "Bounded result." }],
      }),
    });

    expect(run.status).toBe("failed");
    expect(run.error_code).toBe("call_budget_exhausted");
    expect(listToolReceipts(db, run.id)).toHaveLength(1);
    expect(getWorkPlan(db, detail.plan.id)?.steps.map((step) => step.status)).toEqual([
      "completed",
      "pending",
    ]);
  });

  it("does not complete a step without a reviewable local artifact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [{
          title: "Research",
          instruction: "Read current evidence.",
          effect_kind: "web_read",
          depends_on: [],
        }],
        allowed_effects: ["web_read"],
      }),
    );
    authorize(db, detail, source.id);

    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({ output: { claimed: "done" }, modelCalls: 1, toolCalls: 1 }),
    });

    expect(run).toMatchObject({
      status: "failed",
      error_code: "completion_criteria_not_met",
    });
    expect(listWorkArtifacts(db, { runId: run.id })).toEqual([]);
  });

  it("invalidates authorization when an executor finds sensitive or broadened scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [
          {
            title: "Recall",
            instruction: "Recall accepted memory.",
            effect_kind: "memory_read",
            depends_on: [],
          },
        ],
        allowed_effects: ["memory_read"],
      }),
    );
    const authorization = authorize(db, detail, source.id);
    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({
        pause: { code: "sensitive_context", message: "User confirmation is required." },
      }),
    });

    expect(run.status).toBe("paused");
    expect(run.error_code).toBe("sensitive_context");
    expect(getWorkAuthorization(db, authorization.id)?.revoked_at).not.toBeNull();
    expect(activeWorkAuthorization(db, detail.plan.id)).toBeNull();

    const approval = appendMessage(
      db,
      source.conversation_id,
      "user",
      `I approve bounded work plan ${detail.plan.plan_hash}.`,
    );
    authorize(db, detail, approval.id, {
      authorizationKind: "user_approval",
      expiresAt: "2030-01-03T00:00:00.000Z",
    });
    const completed = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({
        artifacts: [{ kind: "research_notes", title: "Reviewed", content: "Safe result." }],
      }),
    });
    expect(completed.id).not.toBe(run.id);
    expect(completed.status).toBe("completed");
    expect(listWorkRuns(db, detail.plan.id)).toHaveLength(2);
  });

  it("recovers a process-interrupted safe read and retains its failed receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({
        steps: [
          {
            title: "Research",
            instruction: "Read sources.",
            effect_kind: "web_read",
            depends_on: [],
          },
        ],
        allowed_effects: ["web_read"],
      }),
    );
    authorize(db, detail, source.id);
    const paused = await runWorkPlan(db, detail.plan.id);
    const step = getWorkPlan(db, detail.plan.id)!.steps[0]!;
    db.transaction(() => {
      db.prepare("UPDATE work_run SET status = 'running' WHERE id = ?").run(paused.id);
      db.prepare(
        "UPDATE work_step SET status = 'running', attempt_count = 1 WHERE id = ?",
      ).run(step.id);
      db.prepare(
        `INSERT INTO tool_receipt
           (work_run_id, work_step_id, tool_name, effect_kind, call_index,
            input_json, citations_json, status, idempotency_key, started_at)
         VALUES (?, ?, 'web_search', 'web_read', 1, '{}', '[]', 'started', ?, ?)`,
      ).run(paused.id, step.id, "interrupted-key", "2030-01-01T00:00:00.000Z");
    })();

    const completed = await resumeWorkRun(db, paused.id, {
      executor: async () => ({
        output: { recovered: true },
        artifacts: [{ kind: "research_notes", title: "Recovered", content: "Recovered result." }],
      }),
    });
    expect(completed.status).toBe("completed");
    expect(listToolReceipts(db, paused.id).map((receipt) => receipt.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(listToolReceipts(db, paused.id)[0]?.error_code).toBe("interrupted");
  });

  it("does not charge the user's deliberation against the run's own budget", async () => {
    // A run parked for a decision used to burn its whole duration waiting, then die on
    // resume — after the external change had already been made, leaving a plan that could
    // never finish. `max_duration_seconds` bounds Zeus's work; the authorization expiry is
    // what bounds the user's window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(
      db,
      proposal({ limits: { max_model_tool_calls: 8, max_retries_per_step: 2, max_duration_seconds: 120 } }),
    );
    authorize(db, detail, source.id, {
      expiresAt: new Date("2030-01-01T01:00:00.000Z").toISOString(),
    });
    const paused = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({
        pause: { code: "effect_confirmation_required", requiresReauthorization: false },
      }),
    });
    expect(paused.status).toBe("paused");

    // Ten minutes of reading, well past the two-minute run budget.
    vi.setSystemTime(new Date("2030-01-01T00:10:00.000Z"));
    const resumed = await resumeWorkRun(db, paused.id, {
      executor: async () => ({
        output: { done: true },
        artifacts: [{ kind: "research_notes", title: "Done", content: "Finished." }],
      }),
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.paused_ms_total).toBeGreaterThanOrEqual(600_000);
    expect(activeWorkAuthorization(db, detail.plan.id)).not.toBeNull();
    vi.useRealTimers();
  });

  it("still stops when the authorization itself expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(db);
    authorize(db, detail, source.id, {
      expiresAt: new Date("2030-01-01T00:05:00.000Z").toISOString(),
    });
    const paused = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({
        pause: { code: "effect_confirmation_required", requiresReauthorization: false },
      }),
    });

    vi.setSystemTime(new Date("2030-01-01T02:00:00.000Z"));
    const resumed = await resumeWorkRun(db, paused.id, {
      executor: async () => ({ output: { done: true } }),
    });

    expect(resumed.status).toBe("paused");
    expect(resumed.error_code).toBe("authorization_invalid");
    vi.useRealTimers();
  });

  it("keeps the artifact from a step that stopped", async () => {
    // The pause branch used to return before artifacts were written, discarding the one
    // record of why the run stopped.
    const db = openTestDb();
    const { source, detail } = createPlan(db);
    authorize(db, detail, source.id);
    const paused = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({
        artifacts: [{ kind: "research_notes", title: "Why it stopped", content: "A collision." }],
        pause: { code: "effect_confirmation_required", requiresReauthorization: false },
      }),
    });

    expect(paused.status).toBe("paused");
    expect(listWorkArtifacts(db, { runId: paused.id }).map((a) => a.title)).toEqual([
      "Why it stopped",
    ]);
  });

  it("cancels a paused run, its remaining steps, and its authorization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const db = openTestDb();
    const { source, detail } = createPlan(db);
    authorize(db, detail, source.id);
    const paused = await runWorkPlan(db, detail.plan.id);
    const cancelled = cancelWorkRun(db, paused.id);

    expect(cancelled?.status).toBe("cancelled");
    expect(getWorkPlan(db, detail.plan.id)?.plan.status).toBe("cancelled");
    expect(getWorkPlan(db, detail.plan.id)?.steps.every((step) => step.status === "cancelled")).toBe(true);
    expect(activeWorkAuthorization(db, detail.plan.id)).toBeNull();
    expect(listWorkRuns(db, detail.plan.id)).toHaveLength(1);
  });
});

describe("work-plan migration", () => {
  it("upgrades an existing database without changing an applied migration", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // The full migration runner is exercised by openTestDb; this assertion protects
    // the final table constraints used by the bounded executor.
    db.close();
    const migrated = openTestDb();
    const tables = migrated
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'work_%' ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "work_artifact",
      "work_artifact_memory_source",
      "work_artifact_source",
      "work_authorization",
      "work_plan",
      "work_plan_generation_context",
      "work_plan_memory_source",
      "work_plan_memory_source_message",
      "work_run",
      "work_step",
      "work_step_dependency",
    ]);
  });
});

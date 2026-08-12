import { describe, expect, it } from "vitest";

import { appendMessage, createConversation, getMessage } from "./conversations";
import { openTestDb } from "./db";
import { upsertEntity } from "./entities";
import { createCommitment, createGoal } from "./intentions";
import { createProject } from "./projects";
import { deleteConversationWithMemory } from "./retention";
import {
  activeWorkAuthorization,
  authorizeWorkPlan,
  createWorkPlan,
  getWorkPlan,
  listToolReceipts,
  listWorkArtifacts,
  listWorkRuns,
  runWorkPlan,
} from "./work-plans";

describe("bounded-work retention", () => {
  it("deletes the exact plan, authorization, run, artifacts, and receipts with its source", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "Research this and draft a recommendation.",
    );
    const detail = createWorkPlan(db, {
      proposal: {
        objective: source.content,
        steps: [
          {
            title: "Draft recommendation",
            instruction: "Prepare a local recommendation",
            effect_kind: "prepare_local",
            depends_on: [],
          },
        ],
        allowed_effects: ["prepare_local"],
        completion_criteria: ["A local draft exists"],
        limits: {
          max_model_tool_calls: 4,
          max_retries_per_step: 1,
          max_duration_seconds: 300,
        },
      },
      sourceMessageId: source.id,
      origin: "explicit_request",
    });
    authorizeWorkPlan(db, detail.plan.id, {
      planHash: detail.plan.plan_hash,
      authorizationKind: "explicit_request",
      allowedEffects: ["prepare_local"],
      maxModelToolCalls: 4,
      maxRetriesPerStep: 1,
      maxDurationSeconds: 300,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceMessageId: source.id,
    });
    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async () => ({
        output: { ok: true },
        artifacts: [
          {
            kind: "draft",
            title: "Recommendation",
            content: "Local only",
          },
        ],
        toolCalls: 1,
      }),
    });
    expect(run.status).toBe("completed");
    expect(listWorkArtifacts(db, { runId: run.id })).toHaveLength(1);
    expect(listToolReceipts(db, run.id)).toHaveLength(1);

    const dependencies = deleteConversationWithMemory(db, conversation.id);

    expect(dependencies.workPlans).toBe(1);
    expect(getWorkPlan(db, detail.plan.id)).toBeNull();
    expect(getMessage(db, source.id)).toBeNull();
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM work_authorization").get()
        ?.count,
    ).toBe(0);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM work_run").get()?.count,
    ).toBe(0);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM work_artifact").get()
        ?.count,
    ).toBe(0);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM tool_receipt").get()
        ?.count,
    ).toBe(0);
  });

  it("invalidates surviving plans before deleted lifecycle links are cleared", async () => {
    const db = openTestDb();
    const lifecycleConversation = createConversation(db, { title: "Lifecycle sources" });
    const goalSource = appendMessage(
      db,
      lifecycleConversation.id,
      "user",
      "I want to launch Nightjar.",
    );
    const commitmentSource = appendMessage(
      db,
      lifecycleConversation.id,
      "user",
      "I will draft the Nightjar brief.",
    );
    const projectSource = appendMessage(
      db,
      lifecycleConversation.id,
      "user",
      "Nightjar is a planned project.",
    );
    const projectEntity = upsertEntity(db, { name: "Nightjar", kind: "project" });
    const project = createProject(db, {
      entityId: projectEntity.id,
      sourceMessageId: projectSource.id,
    });
    const goal = createGoal(db, {
      title: "Launch Nightjar",
      projectId: project.id,
      sourceMessageId: goalSource.id,
    });
    const commitment = createCommitment(db, {
      title: "Draft the Nightjar brief",
      linkedGoalId: goal.id,
      projectId: project.id,
      sourceMessageId: commitmentSource.id,
    });

    const planConversation = createConversation(db, { title: "Surviving work requests" });
    async function linkedPlan(
      label: string,
      links: { sourceGoalId?: number; sourceCommitmentId?: number; sourceProjectId?: number },
    ) {
      const source = appendMessage(
        db,
        planConversation.id,
        "user",
        `Prepare a local ${label} report.`,
      );
      const detail = createWorkPlan(db, {
        proposal: {
          objective: `Prepare ${label}`,
          steps: [{
            title: `Draft ${label}`,
            instruction: `Prepare the ${label} in the local store.`,
            effect_kind: "prepare_local",
            depends_on: [],
          }],
          allowed_effects: ["prepare_local"],
          completion_criteria: [`The ${label} is ready`],
          limits: {
            max_model_tool_calls: 4,
            max_retries_per_step: 1,
            max_duration_seconds: 300,
          },
        },
        sourceMessageId: source.id,
        origin: "explicit_request",
        ...links,
      });
      authorizeWorkPlan(db, detail.plan.id, {
        planHash: detail.plan.plan_hash,
        authorizationKind: "explicit_request",
        allowedEffects: ["prepare_local"],
        maxModelToolCalls: 4,
        maxRetriesPerStep: 1,
        maxDurationSeconds: 300,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        sourceMessageId: source.id,
      });
      const run = await runWorkPlan(db, detail.plan.id);
      expect(run.status).toBe("paused");
      return { planId: detail.plan.id, runId: run.id };
    }

    const linked = [
      await linkedPlan("goal", { sourceGoalId: goal.id }),
      await linkedPlan("commitment", { sourceCommitmentId: commitment.id }),
      await linkedPlan("project", { sourceProjectId: project.id }),
    ];

    deleteConversationWithMemory(db, lifecycleConversation.id);

    for (const item of linked) {
      const detail = getWorkPlan(db, item.planId);
      expect(detail?.plan).toMatchObject({
        status: "paused",
        source_goal_id: null,
        source_commitment_id: null,
        source_project_id: null,
      });
      expect(activeWorkAuthorization(db, item.planId)).toBeNull();
      expect(listWorkRuns(db, item.planId)[0]).toMatchObject({
        id: item.runId,
        status: "paused",
        error_code: "scope_invalidated",
      });
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

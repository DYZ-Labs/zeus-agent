import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateWorkPlanProposal: vi.fn(),
  getBrowserOwnerAccess: vi.fn(),
}));

vi.mock("@/core/work-execution", () => ({
  generateWorkPlanProposal: mocks.generateWorkPlanProposal,
}));
vi.mock("@/server/auth/access", () => ({
  getBrowserOwnerAccess: mocks.getBrowserOwnerAccess,
}));

import { listConversations, messagesIn } from "@/core/conversations";
import { type Db, openTestDb } from "@/core/db";
import {
  activeWorkAuthorization,
  getWorkPlan,
  getWorkPlanGenerationProvenance,
} from "@/core/work-plans";

import { POST } from "./route";

const PROVENANCE = {
  evaluationContext: {
    trigger: "chat" as const,
    evaluated_at: "2030-01-01T09:00:00.000Z",
    timezone: "UTC",
    local_weekday: "tue" as const,
    local_time: "09:00",
    daypart: "morning" as const,
    location_zone: null,
    location_observed_at: null,
  },
  conflicts: [],
  memorySources: [],
};

const PROPOSAL = {
  objective: "Compare the backup options and prepare a recommendation",
  steps: [
    {
      title: "Research the options",
      instruction: "Compare reliable sources for the available backup options.",
      effect_kind: "web_read" as const,
      depends_on: [],
    },
    {
      title: "Prepare the recommendation",
      instruction: "Create a concise local recommendation from the research.",
      effect_kind: "prepare_local" as const,
      depends_on: [1],
    },
  ],
  allowed_effects: ["web_read" as const, "prepare_local" as const],
  completion_criteria: ["A reviewable recommendation exists"],
  limits: {
    max_model_tool_calls: 4,
    max_retries_per_step: 1,
    max_duration_seconds: 300,
  },
};

let db: Db;

beforeEach(() => {
  vi.clearAllMocks();
  db = openTestDb();
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "authorized",
    canAccessPrivateData: true,
    account: { id: "owner", email: "owner@example.com" },
    db,
    message: null,
  });
  mocks.generateWorkPlanProposal.mockResolvedValue({
    proposal: PROPOSAL,
    provenance: PROVENANCE,
  });
});

afterEach(() => {
  db.close();
});

describe("POST /api/work-plans", () => {
  it("creates a source-backed proposal without authorizing or running it", async () => {
    const objective = "Research backup options and draft a recommendation.";

    const response = await POST(
      new Request("http://127.0.0.1:3000/api/work-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "proposed",
      plan: {
        status: "proposed",
        objective: PROPOSAL.objective,
        origin: "explicit_request",
      },
      authorization: null,
      latestRun: null,
    });

    const planId = body.plan.id as number;
    expect(activeWorkAuthorization(db, planId)).toBeNull();
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM work_run").get()?.count,
    ).toBe(0);
    expect(getWorkPlan(db, planId)).toMatchObject({
      plan: { status: "proposed" },
      authorization: null,
      latestRun: null,
    });

    const [conversation] = listConversations(db);
    expect(conversation).toMatchObject({ title: "Work requests", source: "web" });
    expect(messagesIn(db, conversation!.id)).toMatchObject([
      {
        role: "user",
        content: objective,
        origin: "user_action",
        recall_state: "blocked",
      },
    ]);
    expect(getWorkPlanGenerationProvenance(db, planId)).toMatchObject(PROVENANCE);
    expect(mocks.generateWorkPlanProposal).toHaveBeenCalledExactlyOnceWith(db, objective);
  });
});

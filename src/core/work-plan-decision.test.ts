import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertResponseComplete: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("./openai", () => ({
  MODEL: "test-model",
  assertResponseComplete: mocks.assertResponseComplete,
  openai: () => ({ responses: { parse: mocks.parse } }),
}));

import { openTestDb } from "./db";
import { generateWorkPlanProposal } from "./work-execution";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("chat work-plan decisions", () => {
  it("returns no plan for ordinary conversation", async () => {
    const db = openTestDb();
    mocks.parse.mockResolvedValue({
      output_parsed: { decision: "none", proposal: null },
    });

    const generated = await generateWorkPlanProposal(db, "How are you?", {
      allowNoPlan: true,
    });

    expect(generated).toBeNull();
    expect(mocks.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        instructions: expect.stringContaining('Choose "none" for ordinary questions'),
        store: false,
      }),
    );
    expect(mocks.parse.mock.calls[0]?.[0].instructions).not.toContain("- schedule:");
  });

  it("returns a bounded proposal without authorizing or executing it", async () => {
    const db = openTestDb();
    const proposal = {
      objective: "Compare the backup options and prepare a recommendation",
      steps: [
        {
          title: "Research options",
          instruction: "Gather current public evidence.",
          effect_kind: "web_read" as const,
          depends_on: [],
        },
        {
          title: "Prepare recommendation",
          instruction: "Compare the evidence in a local draft.",
          effect_kind: "prepare_local" as const,
          depends_on: [1],
        },
      ],
      allowed_effects: ["web_read" as const, "prepare_local" as const],
      completion_criteria: ["A cited recommendation is ready for review"],
      limits: {
        max_model_tool_calls: 6,
        max_retries_per_step: 1,
        max_duration_seconds: 300,
      },
    };
    mocks.parse.mockResolvedValue({
      output_parsed: { decision: "propose", proposal },
    });

    const generated = await generateWorkPlanProposal(
      db,
      "Research the backup options and prepare a recommendation.",
      { allowNoPlan: true },
    );

    expect(generated?.proposal).toEqual(proposal);
    expect(generated?.provenance.evaluationContext.trigger).toBe("chat");
  });

  it("rejects connector-backed effects from a generic chat decision", async () => {
    const db = openTestDb();
    mocks.parse.mockResolvedValue({
      output_parsed: {
        decision: "propose",
        proposal: {
          objective: "Put lunch on my calendar",
          steps: [{
            title: "Schedule lunch",
            instruction: "Create the event.",
            effect_kind: "schedule",
            depends_on: [],
          }],
          allowed_effects: ["schedule"],
          completion_criteria: ["Lunch is scheduled"],
          limits: {
            max_model_tool_calls: 2,
            max_retries_per_step: 0,
            max_duration_seconds: 120,
          },
        },
      },
    });

    await expect(
      generateWorkPlanProposal(db, "Put lunch on my calendar.", { allowNoPlan: true }),
    ).rejects.toThrow("unavailable external effect");
  });
});

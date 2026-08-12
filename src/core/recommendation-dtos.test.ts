import { describe, expect, it } from "vitest";

import { recommendationDto } from "./recommendation-dtos";
import type { FollowThroughRecommendation } from "./schema";

describe("recommendationDto", () => {
  it("keeps local keys behind opaque consumer ids", () => {
    const dto = recommendationDto({
      commitment_id: 41,
      commitment_title: "Send the draft",
      commitment_source_message_id: 72,
      goal_id: 3,
      goal_title: "Launch",
      goal_priority: "high",
      due_at: null,
      reason: "priority",
      action_kind: "draft",
      effect_kind: "prepare_local",
      why: "This is the next useful step.",
      suggested_action: "Draft the launch note",
      chat_prompt: "Help me draft the launch note",
      requires_confirmation: false,
      score: 8,
    } satisfies FollowThroughRecommendation);

    expect(dto).toEqual({
      commitmentId: "commitment_15",
      sourceId: "message_20",
      suggestedAction: "Draft the launch note",
      why: "This is the next useful step.",
      chatPrompt: "Help me draft the launch note",
      requiresConfirmation: false,
    });
    expect(JSON.stringify(dto)).not.toContain('"goal_id"');
  });
});

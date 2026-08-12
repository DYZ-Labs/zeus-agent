import { z } from "zod";

import { ResourceId } from "./contracts";
import { resourceId } from "./resource-id";
import type { FollowThroughRecommendation } from "./schema";

export const RecommendationDto = z
  .object({
    commitmentId: ResourceId,
    sourceId: ResourceId,
    suggestedAction: z.string().trim().min(1),
    why: z.string().trim().min(1),
    chatPrompt: z.string().trim().min(1),
    requiresConfirmation: z.boolean(),
  })
  .strict();
export type RecommendationDto = z.infer<typeof RecommendationDto>;

export function recommendationDto(
  recommendation: FollowThroughRecommendation,
): RecommendationDto {
  return RecommendationDto.parse({
    commitmentId: resourceId("commitment", recommendation.commitment_id),
    sourceId: resourceId("message", recommendation.commitment_source_message_id),
    suggestedAction: recommendation.suggested_action,
    why: recommendation.why,
    chatPrompt: recommendation.chat_prompt,
    requiresConfirmation: recommendation.requires_confirmation,
  });
}

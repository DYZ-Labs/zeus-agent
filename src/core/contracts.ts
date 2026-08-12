import { z } from "zod";

/** Public application contracts. Database row shapes must not cross this boundary. */
export const ResourceId = z.string().trim().min(3).max(120);
export type ResourceId = z.infer<typeof ResourceId>;

export const RememberingMode = z.enum(["automatic", "confirm", "off"]);
export type RememberingMode = z.infer<typeof RememberingMode>;

export const SuggestionMode = z.enum(["off", "important", "helpful", "proactive"]);
export type SuggestionMode = z.infer<typeof SuggestionMode>;

export const ChatMode = z.enum(["standard", "temporary"]);
export type ChatMode = z.infer<typeof ChatMode>;

export const OnboardingStatus = z.enum(["welcome", "first_chat", "complete"]);
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;

export const ExperienceSettings = z
  .object({
    rememberingMode: RememberingMode,
    suggestionMode: SuggestionMode,
    onboardingStatus: OnboardingStatus,
    labsEnabled: z.boolean(),
  })
  .strict();
export type ExperienceSettings = z.infer<typeof ExperienceSettings>;

export const MemoryActivityItem = z
  .object({
    id: ResourceId,
    kind: z.enum(["detail", "preference", "plan"]),
    change: z.enum(["saved", "updated", "needs_review"]),
    label: z.string().trim().min(1).max(1_000),
    sourceId: ResourceId,
  })
  .strict();
export type MemoryActivityItem = z.infer<typeof MemoryActivityItem>;

export const ReviewItem = z
  .object({
    id: ResourceId,
    category: z.string().trim().min(1).max(100),
    statement: z.string().trim().min(1).max(2_000),
    reason: z.enum(["uncertain", "sensitive", "conflict", "ambiguous"]),
    evidence: z.array(
      z
        .object({
          quote: z.string().max(4_000),
          date: z.string(),
          sourceId: ResourceId,
        })
        .strict(),
    ),
  })
  .strict();
export type ReviewItem = z.infer<typeof ReviewItem>;

export const DeletionImpact = z
  .object({
    messages: z.number().int().nonnegative(),
    removedMemories: z.number().int().nonnegative(),
    retainedSharedMemories: z.number().int().nonnegative(),
    affectedPlans: z.number().int().nonnegative(),
    affectedAuditRecords: z.number().int().nonnegative(),
  })
  .strict();
export type DeletionImpact = z.infer<typeof DeletionImpact>;

export const MemoryJobStatus = z.enum(["pending", "running", "completed", "failed"]);
export type MemoryJobStatus = z.infer<typeof MemoryJobStatus>;

export const MemoryJobView = z
  .object({
    id: ResourceId,
    status: MemoryJobStatus,
    items: z.array(MemoryActivityItem),
    canUndo: z.boolean(),
    undone: z.boolean(),
    error: z.string().nullable(),
  })
  .strict();
export type MemoryJobView = z.infer<typeof MemoryJobView>;

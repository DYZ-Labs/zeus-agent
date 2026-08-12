import type {
  DeletionImpact,
  ExperienceSettings,
  MemoryActivityItem,
  MemoryJobView,
  RememberingMode,
  ResourceId,
  ReviewItem,
} from "@/core/contracts";

export interface HostedConversation {
  id: ResourceId;
  title: string | null;
  historyStatus: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface HostedMessage {
  id: ResourceId;
  conversationId: ResourceId;
  role: "user" | "assistant";
  content: string;
  crossChatRecallEligible: boolean;
  createdAt: string;
}

export interface HostedSearchResult {
  conversation: HostedConversation;
  message: HostedMessage;
  excerpt: string;
}

export interface HostedResponseTraceItem {
  rank: number;
  kind:
    | "fact"
    | "episode"
    | "facet"
    | "project"
    | "goal"
    | "commitment"
    | "recommendation";
  resourceId: ResourceId;
  snapshot: Readonly<Record<string, unknown>>;
}

export interface HostedMemoryCard {
  id: ResourceId;
  category: "Work" | "People" | "Preferences" | "Places" | "Plans" | "Important context";
  statement: string;
  validFrom: string;
  validTo: string | null;
  sourceId: ResourceId;
}

export interface HostedPlanItem {
  id: ResourceId;
  kind: "project" | "goal" | "commitment";
  title: string;
  status: "active" | "waiting" | "paused" | "completed" | "stopped";
  dueAt: string | null;
  sourceId: ResourceId;
}

export interface HostedRecommendation {
  id: ResourceId;
  planId: ResourceId;
  statement: string;
  createdAt: string;
}

export interface ConversationStorage {
  create(input?: { title?: string }): Promise<HostedConversation>;
  get(id: ResourceId): Promise<HostedConversation | null>;
  list(input: { historyStatus: "active" | "archived"; limit: number }): Promise<HostedConversation[]>;
  appendMessage(input: {
    conversationId: ResourceId;
    role: "user" | "assistant";
    content: string;
    crossChatRecallEligible: boolean;
  }): Promise<HostedMessage>;
  listMessages(conversationId: ResourceId): Promise<HostedMessage[]>;
  searchMessages(query: string, limit: number): Promise<HostedSearchResult[]>;
  archive(id: ResourceId): Promise<void>;
  restore(id: ResourceId): Promise<void>;
  previewPermanentDeletion(id: ResourceId): Promise<DeletionImpact>;
  deletePermanently(id: ResourceId, expectedImpact: DeletionImpact): Promise<void>;
}

export interface ResponseTraceStorage {
  record(input: {
    conversationId: ResourceId;
    assistantMessageId: ResourceId;
    model: string;
    promptVersion: string;
    items: HostedResponseTraceItem[];
  }): Promise<ResourceId>;
  getByAssistantMessage(assistantMessageId: ResourceId): Promise<HostedResponseTraceItem[]>;
}

export interface MemoryStorage {
  listCards(): Promise<HostedMemoryCard[]>;
  searchCurrent(query: string, limit: number): Promise<HostedMemoryCard[]>;
  listReviewItems(): Promise<ReviewItem[]>;
  acceptReviewItem(id: ResourceId, editedStatement?: string): Promise<MemoryActivityItem[]>;
  rejectReviewItem(id: ResourceId): Promise<void>;
  /** Implementations create their own stored user-action source; callers cannot pick provenance. */
  correct(id: ResourceId, statement: string): Promise<MemoryActivityItem[]>;
  markNoLongerTrue(id: ResourceId): Promise<MemoryActivityItem[]>;
  removeFromMemory(id: ResourceId): Promise<void>;
}

export interface IntentionStorage {
  listPlans(): Promise<HostedPlanItem[]>;
  setStatus(
    id: ResourceId,
    kind: HostedPlanItem["kind"],
    status: HostedPlanItem["status"],
  ): Promise<HostedPlanItem>;
}

export interface StewardshipStorage {
  nextRecommendation(): Promise<HostedRecommendation | null>;
  recordDecision(input: {
    recommendationId: ResourceId;
    decision: "accepted" | "completed" | "snoozed" | "dismissed" | "regret";
  }): Promise<void>;
}

export interface ExperienceStorage {
  get(): Promise<ExperienceSettings>;
  update(settings: Partial<ExperienceSettings>): Promise<ExperienceSettings>;
}

export interface MemoryJobStorage {
  enqueue(input: {
    conversationId: ResourceId;
    sourceMessageId: ResourceId;
    assistantMessageId: ResourceId;
    promptVersion: string;
    rememberingMode: Exclude<RememberingMode, "off">;
  }): Promise<ResourceId>;
  get(id: ResourceId): Promise<MemoryJobView | null>;
  complete(id: ResourceId, items: MemoryActivityItem[]): Promise<MemoryJobView>;
  fail(id: ResourceId, errorCode: string): Promise<MemoryJobView>;
  undo(id: ResourceId): Promise<{ status: "undone" } | { status: "conflict" }>;
}

export interface DataControlStorage {
  requestExport(): Promise<ResourceId>;
  getExport(id: ResourceId): Promise<{
    status: "pending" | "running" | "completed" | "failed" | "expired";
    downloadToken: string | null;
  } | null>;
  clearAllData(expectedImpact: DeletionImpact): Promise<void>;
  requestAccountDeletion(expectedImpact: DeletionImpact): Promise<ResourceId>;
}

/** Services are transaction-scoped and never accept a tenant/user ID. */
export interface HostedDomainServices {
  conversations: ConversationStorage;
  responseTraces: ResponseTraceStorage;
  memory: MemoryStorage;
  intentions: IntentionStorage;
  stewardship: StewardshipStorage;
  experience: ExperienceStorage;
  memoryJobs: MemoryJobStorage;
  dataControls: DataControlStorage;
}

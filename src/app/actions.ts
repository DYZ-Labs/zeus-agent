"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createCandidate,
  getCandidate,
  recordCandidateResolution,
  resolveCandidate,
} from "@/core/candidates";
import {
  acceptEligibleBackfillFacets,
  getUnderstandingBackfillJob,
  processUnderstandingBackfillBatch,
  startUnderstandingBackfill,
} from "@/core/backfill";
import { updateAmbientSetting } from "@/core/ambient";
import {
  appendMessage,
  createConversation,
  getConversation,
  hideAllConversationsFromHistory,
  hideConversationFromHistory,
  listConversations,
  setConversationTitle,
} from "@/core/conversations";
import {
  deleteEmbedding,
  embedFacet,
  embedFact,
  embedPassage,
} from "@/core/embed";
import { mergeEntities, resolveEntity, setEntitySummary } from "@/core/entities";
import { acceptCandidate } from "@/core/extract";
import type { ApplyResult } from "@/core/extract";
import {
  closeFacet,
  correctFacet,
  forgetFacet,
  facetSearchText,
  getFacet,
  recordFacet,
} from "@/core/facets";
import {
  addFactEvidence,
  correctFact,
  factSearchText,
  forgetFact,
  getFact,
  recordFact,
  setPredicateCardinality,
  supersedeFact,
} from "@/core/facts";
import { getCommitment, getGoal, updateCommitment, updateGoal } from "@/core/intentions";
import {
  allowWholeMessagePassage,
  blockMessageRecall,
  ensureEvidencePassage,
  sourceLooksSensitive,
} from "@/core/passages";
import {
  acceptBehavioralPolicySuggestionForReview,
  dismissBehavioralPolicySuggestion,
  getBehavioralPolicySuggestion,
} from "@/core/personalization";
import {
  getProject,
  markProjectBlocked,
  markProjectUnblocked,
  recordProjectProgress,
  updateProject,
} from "@/core/projects";
import {
  deleteAllConversationsWithMemory,
  deleteConversationWithMemory,
} from "@/core/retention";
import type { Db } from "@/core/db";
import type {
  Cardinality,
  CommitmentStatus,
  FollowThroughEventType,
  FacetKind,
  FacetMachineEffect,
  GoalPriority,
  GoalStatus,
  ProjectStatus,
  StewardshipMode,
  StructuredFacetCondition,
} from "@/core/schema";
import { StructuredFacetCondition as StructuredFacetConditionSchema } from "@/core/schema";
import {
  recommendationForCommitment,
  recordFollowThroughDecision,
  setStewardshipMode,
} from "@/core/stewardship";
import { requireOwnerDb } from "@/server/auth/access";

/**
 * Curation actions.
 *
 * Everything destructive lives here rather than in the pipeline, which is the point:
 * extraction may only add and supersede, while forgetting is something only the user
 * does. A memory you cannot correct or erase is not one worth trusting.
 */

export async function editFactAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const object = String(formData.get("object") ?? "").trim();
  if (!Number.isInteger(id) || !object) return;

  const db = await requireOwnerDb();
  const existing = getFact(db, id);
  if (!existing || existing.object === object) return;

  // A correction is a new sourced assertion, never an in-place rewrite of history.
  const source = curationMessage(
    db,
    `Corrected memory: ${existing.subject_name} ${existing.predicate.replace(/_/gu, " ")} ${object}.`,
  );
  const objectEntity = resolveEntity(db, object);
  const corrected = correctFact(db, existing.id, {
    object,
    objectEntityId: objectEntity?.id ?? null,
    confidence: 1,
    sourceMessageId: source.id,
  });

  if (corrected) {
    // The stored text changed, so its vector is now wrong — recompute rather than
    // leave semantic search pointing at the old wording.
    await embedFact(
      db,
      corrected.id,
      factSearchText(corrected.subject_name, corrected.predicate, corrected.object),
    ).catch(() => false);
  }

  revalidatePath("/memory");
}

export async function acceptCandidateAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.status !== "pending") return;
  const applied = acceptCandidate(db, id);
  if (applied) {
    await embedAppliedMemory(db, applied, candidate.evidence);
  }
  revalidatePath("/memory");
  revalidatePath("/understanding");
  revalidatePath("/today");
}

export async function rejectCandidateAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  rejectCandidateWithAudit(await requireOwnerDb(), id);
  revalidatePath("/memory");
}

export async function acceptFacetCandidateAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const statement = normalizedText(formData.get("statement"), 1_000);
  const machineEffect = parseMachineEffect(formData.get("machineEffect"));
  const structuredCondition = parseStructuredConditionForm(formData.get("structuredCondition"));
  if (
    !Number.isInteger(id) || !statement || machineEffect === undefined ||
    structuredCondition === undefined
  ) return;

  const db = await requireOwnerDb();
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.kind !== "facet" || candidate.status !== "pending") return;
  const applied = acceptCandidate(db, id, {
    facetEdit: { statement, machineEffect, structuredCondition },
  });
  if (applied) await embedAppliedMemory(db, applied, candidate.evidence);
  revalidatePath("/understanding");
  revalidatePath("/understanding/backfill");
  revalidatePath("/today");
}

export async function rejectFacetCandidateAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.kind !== "facet") return;
  rejectCandidateWithAudit(db, id);
  revalidatePath("/understanding");
  revalidatePath("/understanding/backfill");
}

export async function correctFacetAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const statement = normalizedText(formData.get("statement"), 1_000);
  const machineEffect = parseMachineEffect(formData.get("machineEffect"));
  const structuredCondition = parseStructuredConditionForm(formData.get("structuredCondition"));
  if (
    !Number.isInteger(id) || !statement || machineEffect === undefined ||
    structuredCondition === undefined
  ) return;

  const db = await requireOwnerDb();
  const existing = getFacet(db, id);
  if (!existing || existing.valid_to !== null) return;
  const existingCondition = existing.condition_json === null
    ? null
    : StructuredFacetConditionSchema.safeParse(
        JSON.parse(existing.condition_json) as unknown,
      ).data ?? null;
  if (
    existing.statement === statement && existing.machine_effect === machineEffect &&
    JSON.stringify(existingCondition) === JSON.stringify(structuredCondition)
  ) return;
  const source = curationMessage(db, `Corrected understanding: ${statement}`);
  const passage = ensureEvidencePassage(db, {
    messageId: source.id,
    quote: statement,
    sensitivity: existing.sensitivity,
    recallStatus: "blocked",
  });
  const replacement = correctFacet(db, id, {
    statement,
    condition: existing.condition_text,
    importance: existing.importance,
    sensitivity: existing.sensitivity,
    confidence: 1,
    machineEffect,
    structuredCondition,
    validFrom: null,
    sourceMessageId: source.id,
    passageIds: [passage.id],
    sourceKind: "user_action",
  });
  if (replacement) {
    await embedAppliedMemory(
      db,
      { facts: [], facets: [replacement] },
      [passage],
    );
  }
  revalidatePath("/understanding");
  revalidatePath("/today");
}

export async function closeFacetAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const facet = getFacet(db, id);
  if (!facet || facet.valid_to !== null) return;
  const source = curationMessage(db, `Marked understanding as no longer applicable: ${facet.statement}`);
  closeFacet(db, id, source.id);
  revalidatePath("/understanding");
  revalidatePath("/today");
}

export async function forgetFacetAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  forgetFacet(await requireOwnerDb(), id);
  revalidatePath("/understanding");
  revalidatePath("/today");
}

export async function answerReflectionAction(formData: FormData): Promise<void> {
  const prompt = normalizedText(formData.get("prompt"), 1_000);
  const answer = normalizedText(formData.get("answer"), 4_000);
  const kind = String(formData.get("kind") ?? "") as FacetKind;
  if (!prompt || !answer || !FACET_KIND_VALUES.has(kind)) return;

  const db = await requireOwnerDb();
  const conversation =
    listConversations(db, 500).find((entry) => entry.title === "Understanding reflections") ??
    createConversation(db, { title: "Understanding reflections", source: "web" });
  appendMessage(db, conversation.id, "assistant", prompt, {
    origin: "user_action",
    recallState: "blocked",
  });
  const source = appendMessage(db, conversation.id, "user", answer, {
    origin: "reflection",
    recallState: "unclassified",
  });
  const sensitive = sourceLooksSensitive(answer);
  const ambiguous = reflectionLooksAmbiguous(answer);
  const passage = ensureEvidencePassage(db, {
    messageId: source.id,
    quote: answer,
    sensitivity: sensitive ? "sensitive" : "normal",
    recallStatus: sensitive ? "pending" : "allowed",
  });
  if (sensitive) blockMessageRecall(db, source.id);
  else allowWholeMessagePassage(db, source.id);

  let acceptedFacet: ReturnType<typeof recordFacet> | null = null;
  if (sensitive || ambiguous) {
    const reasons = [sensitive ? "sensitive" : null, ambiguous ? "ambiguous" : null].filter(
      (reason): reason is "sensitive" | "ambiguous" => reason !== null,
    );
    createCandidate(db, {
      kind: "facet",
      payload: {
        item: reflectionFacet(kind, answer, source.id, sensitive, ambiguous),
        entities: [],
      },
      reason: reasons[0]!,
      reasons,
      confidence: ambiguous ? 0.55 : 0.95,
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });
  } else {
    acceptedFacet = recordFacet(db, {
      kind,
      statement: answer,
      scope: { kind: "global" },
      sensitivity: "normal",
      confidence: 1,
      sourceMessageId: source.id,
      passageIds: [passage.id],
      sourceKind: "message",
    });
  }
  if (acceptedFacet) {
    await embedAppliedMemory(db, { facts: [], facets: [acceptedFacet] }, [passage]);
  }
  revalidatePath("/understanding");
}

export async function startBackfillAction(): Promise<void> {
  startUnderstandingBackfill(await requireOwnerDb());
  revalidatePath("/understanding/backfill");
}

export async function processBackfillAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  if (!getUnderstandingBackfillJob(db, id)) return;
  await processUnderstandingBackfillBatch(db, id);
  revalidatePath("/understanding/backfill");
  revalidatePath("/understanding");
}

export async function acceptBackfillBatchAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const accepted = acceptEligibleBackfillFacets(db, id);
  await embedAppliedMemory(
    db,
    { facts: [], facets: accepted.facets },
    accepted.passages,
  );
  revalidatePath("/understanding/backfill");
  revalidatePath("/understanding");
  revalidatePath("/today");
}

export async function updateGoalStatusAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "") as GoalStatus;
  if (
    !Number.isInteger(id) ||
    !["active", "paused", "achieved", "abandoned"].includes(status)
  ) return;
  const db = await requireOwnerDb();
  const goal = getGoal(db, id);
  if (!goal) return;
  const source = curationMessage(db, `Set goal "${goal.title}" to ${status}.`);
  updateGoal(db, id, {
    status,
    sourceMessageId: source.id,
    sourceKind: "user_action",
  });
  revalidatePath("/today");
}

export async function setGoalPriorityAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const priority = String(formData.get("priority") ?? "") as GoalPriority;
  if (!Number.isInteger(id) || !["low", "normal", "high"].includes(priority)) return;
  const db = await requireOwnerDb();
  const goal = getGoal(db, id);
  if (!goal || goal.priority === priority) return;
  const source = curationMessage(db, `Set goal "${goal.title}" to ${priority} priority.`);
  updateGoal(db, id, {
    priority,
    sourceMessageId: source.id,
    sourceKind: "user_action",
  });
  revalidatePath("/today");
}

export async function updateCommitmentStatusAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "") as CommitmentStatus;
  if (!Number.isInteger(id) || !["open", "waiting", "done", "cancelled"].includes(status)) {
    return;
  }
  const db = await requireOwnerDb();
  const commitment = getCommitment(db, id);
  if (!commitment) return;
  const source = curationMessage(
    db,
    `Set commitment "${commitment.title}" to ${status}.`,
  );
  updateCommitment(db, id, {
    status,
    sourceMessageId: source.id,
    sourceKind: "user_action",
  });
  revalidatePath("/today");
}

export async function updateProjectStatusAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "") as ProjectStatus;
  if (
    !Number.isInteger(id) ||
    !["planned", "active", "paused", "completed", "abandoned"].includes(status)
  ) return;
  const db = await requireOwnerDb();
  const project = getProject(db, id);
  if (!project || project.status === status) return;
  const source = curationMessage(db, `Set project "${project.entity_name}" to ${status}.`);
  updateProject(db, id, {
    status,
    sourceMessageId: source.id,
    sourceKind: "user_action",
  });
  revalidatePath("/today");
}

export async function recordProjectProgressAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const summary = normalizedText(formData.get("summary"), 2_000);
  const rawPercent = String(formData.get("percent") ?? "").trim();
  const percent = rawPercent ? Number(rawPercent) / 100 : undefined;
  if (
    !Number.isInteger(id) ||
    (!summary && percent === undefined) ||
    (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > 1))
  ) return;
  const db = await requireOwnerDb();
  const project = getProject(db, id);
  if (!project) return;
  const source = curationMessage(
    db,
    `Recorded progress for project "${project.entity_name}"${percent === undefined ? "" : ` at ${Math.round(percent * 100)}%`}${summary ? `: ${summary}` : "."}`,
  );
  recordProjectProgress(db, id, {
    ...(summary ? { summary } : {}),
    ...(percent === undefined ? {} : { percent }),
    sourceMessageId: source.id,
    sourceKind: "user_action",
  });
  revalidatePath("/today");
}

export async function setProjectBlockedAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const blocked = String(formData.get("blocked") ?? "") === "true";
  const reason = normalizedText(formData.get("reason"), 1_000);
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const project = getProject(db, id);
  if (!project || (blocked ? project.blocked_at !== null : project.blocked_at === null)) return;
  const source = curationMessage(
    db,
    `${blocked ? "Marked" : "Cleared"} project "${project.entity_name}" ${blocked ? "as blocked" : "as unblocked"}${reason ? `: ${reason}` : "."}`,
  );
  if (blocked) {
    markProjectBlocked(db, id, {
      reason,
      sourceMessageId: source.id,
      sourceKind: "user_action",
    });
  } else {
    markProjectUnblocked(db, id, {
      resolution: reason,
      sourceMessageId: source.id,
      sourceKind: "user_action",
    });
  }
  revalidatePath("/today");
}

export async function snoozeCommitmentAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const until = String(formData.get("until") ?? "");
  if (!Number.isInteger(id) || !until) return;
  const db = await requireOwnerDb();
  const commitment = getCommitment(db, id);
  if (!commitment) return;
  const source = curationMessage(
    db,
    `Snoozed nudges for commitment "${commitment.title}" until ${until}.`,
  );
  updateCommitment(db, id, {
    snoozedUntil: until,
    sourceMessageId: source.id,
    sourceKind: "user_action",
  });
  revalidatePath("/today");
}

export async function setStewardshipModeAction(formData: FormData): Promise<void> {
  const mode = String(formData.get("mode") ?? "") as StewardshipMode;
  if (!["off", "quiet", "balanced", "proactive"].includes(mode)) return;
  const db = await requireOwnerDb();
  const source = curationMessage(db, `Set follow-through mode to ${mode}.`);
  setStewardshipMode(db, mode, source.id);
  revalidatePath("/today");
  revalidatePath("/settings");
}

export async function updateAmbientSettingAction(formData: FormData): Promise<void> {
  const timezone = normalizedText(formData.get("timezone"), 100);
  const quietStart = normalizedText(formData.get("quietStart"), 5);
  const quietEnd = normalizedText(formData.get("quietEnd"), 5);
  if (!timezone || !quietStart || !quietEnd) return;
  const enabled = formData.get("enabled") === "on";
  const locationConsent = formData.get("locationConsent") === "on";
  const db = await requireOwnerDb();
  const source = curationMessage(
    db,
    `Set ambient support ${enabled ? "on" : "off"} in ${timezone}, with quiet hours ${quietStart}-${quietEnd}${locationConsent ? " and coarse-zone consent" : " without location consent"}.`,
  );
  updateAmbientSetting(db, {
    enabled,
    timezone,
    quietStart,
    quietEnd,
    dailyLimit: 1,
    allowedChannels: ["macos"],
    locationConsent,
    sourceMessageId: source.id,
  });
  revalidatePath("/settings");
  revalidatePath("/today");
}

export async function reviewBehavioralPolicySuggestionAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const decision = String(formData.get("decision") ?? "");
  if (!Number.isInteger(id) || !["keep_for_review", "dismiss"].includes(decision)) return;
  const db = await requireOwnerDb();
  const suggestion = getBehavioralPolicySuggestion(db, id);
  if (!suggestion || suggestion.status !== "pending") return;
  const source = curationMessage(
    db,
    decision === "keep_for_review"
      ? `Keep behavioral policy suggestion ${id} for explicit review: ${suggestion.summary}`
      : `Dismiss behavioral policy suggestion ${id}: ${suggestion.summary}`,
  );
  if (decision === "keep_for_review") {
    acceptBehavioralPolicySuggestionForReview(db, id, source.id);
  } else {
    dismissBehavioralPolicySuggestion(db, id, source.id);
  }
  revalidatePath("/settings");
}

export async function followThroughDecisionAction(formData: FormData): Promise<void> {
  const commitmentId = Number(formData.get("id"));
  const decision = String(formData.get("decision") ?? "") as Exclude<
    FollowThroughEventType,
    "surfaced"
  >;
  if (
    !Number.isInteger(commitmentId) ||
    !["accepted", "dismissed", "snoozed", "completed", "regretted"].includes(decision)
  ) {
    return;
  }
  const db = await requireOwnerDb();
  const recommendation = recommendationForCommitment(db, commitmentId);
  const userReason = normalizedText(formData.get("reason"), 1_000);
  const event = recordFollowThroughDecision(db, {
    commitmentId,
    decision,
    ...(userReason ? { userReason } : {}),
  });
  if (!event) return;

  revalidatePath("/today");
  revalidatePath("/settings");
  if (decision === "accepted" && recommendation) {
    redirect(`/?prompt=${encodeURIComponent(recommendation.chat_prompt)}`);
  }
}

export async function deleteConversationAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const confirmation = String(formData.get("confirmation") ?? "");
  if (!Number.isInteger(id) || confirmation !== "erase-source") return;
  const db = await requireOwnerDb();
  const conversation = getConversation(db, id);
  if (!conversation || conversation.title === "Memory curation") return;
  deleteConversationWithMemory(db, id);
  revalidatePath("/", "layout");
  revalidatePath("/memory");
  revalidatePath("/today");
  revalidatePath("/understanding");
  revalidatePath("/conversations");
  revalidatePath("/settings");
  redirect("/settings#data");
}

export async function renameConversationAction(id: number, title: string): Promise<void> {
  const normalizedTitle = title.replace(/\s+/gu, " ").trim().slice(0, 100);
  if (!Number.isInteger(id) || !normalizedTitle) return;

  const db = await requireOwnerDb();
  const conversation = getConversation(db, id);
  if (!conversation || conversation.title === "Memory curation") return;

  setConversationTitle(db, id, normalizedTitle);
  revalidatePath("/", "layout");
  revalidatePath("/conversations");
  revalidatePath("/settings");
}

export async function deleteConversationFromHistoryAction(
  id: number,
  confirmation: string,
): Promise<void> {
  if (!Number.isInteger(id) || confirmation !== "erase-source") return;

  const db = await requireOwnerDb();
  const conversation = getConversation(db, id);
  if (!conversation || conversation.title === "Memory curation") return;
  deleteConversationWithMemory(db, id);
  revalidatePath("/", "layout");
  revalidatePath("/memory");
  revalidatePath("/today");
  revalidatePath("/understanding");
  revalidatePath("/conversations");
  revalidatePath("/settings");
}

export async function removeConversationFromHistoryAction(id: number): Promise<void> {
  if (!Number.isInteger(id)) return;

  const db = await requireOwnerDb();
  if (!hideConversationFromHistory(db, id)) return;
  revalidatePath("/", "layout");
  revalidatePath("/conversations");
  revalidatePath("/settings");
}

export async function clearConversationHistoryAction(): Promise<void> {
  hideAllConversationsFromHistory(await requireOwnerDb());
  revalidatePath("/", "layout");
  revalidatePath("/conversations");
  revalidatePath("/settings");
}

export async function deleteAllConversationsAction(formData: FormData): Promise<void> {
  const confirmation = String(formData.get("confirmation") ?? "");
  if (confirmation !== "erase-all-sources") return;

  deleteAllConversationsWithMemory(await requireOwnerDb());
  revalidatePath("/", "layout");
  revalidatePath("/memory");
  revalidatePath("/today");
  revalidatePath("/understanding");
  revalidatePath("/conversations");
  revalidatePath("/settings");
}

export async function supersedeFactAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;

  const db = await requireOwnerDb();
  const fact = getFact(db, id);
  if (!fact) return;
  const source = curationMessage(
    db,
    `Marked memory as no longer true: ${fact.subject_name} ${fact.predicate.replace(/_/gu, " ")} ${fact.object}.`,
  );
  addFactEvidence(db, id, source.id, "correction", 1);
  supersedeFact(db, id);
  revalidatePath("/memory");
}

export async function reviveFactAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;

  const db = await requireOwnerDb();
  const fact = getFact(db, id);
  if (!fact) return;
  const source = curationMessage(
    db,
    `Marked memory as true again: ${fact.subject_name} ${fact.predicate.replace(/_/gu, " ")} ${fact.object}.`,
  );
  const reasserted = recordFact(db, {
    subjectId: fact.subject_id,
    predicate: fact.predicate,
    object: fact.object,
    objectEntityId: fact.object_entity_id,
    confidence: 1,
    sourceMessageId: source.id,
    evidenceKind: "correction",
  }).fact;
  await embedFact(
    db,
    reasserted.id,
    factSearchText(reasserted.subject_name, reasserted.predicate, reasserted.object),
  ).catch(() => false);
  revalidatePath("/memory");
}

export async function forgetFactAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;

  const db = await requireOwnerDb();
  const fact = getFact(db, id);
  if (!fact) return;

  deleteEmbedding(db, "fact", id);
  forgetFact(db, id);

  revalidatePath("/memory");
  if (fact.subject_slug) revalidatePath(`/entity/${fact.subject_slug}`);
}

export async function setCardinalityAction(formData: FormData): Promise<void> {
  const name = String(formData.get("predicate") ?? "");
  const cardinality = String(formData.get("cardinality") ?? "") as Cardinality;
  if (!name || (cardinality !== "single" && cardinality !== "multi")) return;

  setPredicateCardinality(await requireOwnerDb(), name, cardinality);
  revalidatePath("/memory");
}

export async function mergeEntitiesAction(formData: FormData): Promise<void> {
  const source = Number(formData.get("source"));
  const target = Number(formData.get("target"));
  if (!Number.isInteger(source) || !Number.isInteger(target)) return;

  mergeEntities(await requireOwnerDb(), source, target);
  revalidatePath("/memory");
}

export async function setSummaryAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const slug = String(formData.get("slug") ?? "");
  const summary = String(formData.get("summary") ?? "").trim();
  if (!Number.isInteger(id)) return;

  setEntitySummary(await requireOwnerDb(), id, summary || null);
  if (slug) revalidatePath(`/entity/${slug}`);
}

function curationMessage(db: Db, content: string) {
  const conversation =
    listConversations(db, 100).find((entry) => entry.title === "Memory curation") ??
    createConversation(db, { title: "Memory curation", source: "web" });
  return appendMessage(db, conversation.id, "user", content, {
    origin: "user_action",
    recallState: "blocked",
  });
}

const FACET_KIND_VALUES = new Set<FacetKind>([
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

function parseMachineEffect(value: FormDataEntryValue | null): FacetMachineEffect | null | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized === "boost" || normalized === "deprioritize" || normalized === "block"
    ? normalized
    : undefined;
}

function parseStructuredConditionForm(
  value: FormDataEntryValue | null,
): StructuredFacetCondition | null | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  try {
    return StructuredFacetConditionSchema.parse(JSON.parse(normalized) as unknown);
  } catch {
    return undefined;
  }
}

function normalizedText(value: FormDataEntryValue | null, limit: number): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function reflectionLooksAmbiguous(answer: string): boolean {
  return (
    answer.length < 8 ||
    /^(?:i\s+)?(?:do not|don't|dont) know\b|^not sure\b|^it depends\.?$/iu.test(answer)
  );
}

function reflectionFacet(
  kind: FacetKind,
  statement: string,
  sourceMessageId: number,
  sensitive: boolean,
  ambiguous: boolean,
) {
  return {
    kind,
    statement,
    scope: { kind: "global" as const },
    condition: null,
    importance: "normal" as const,
    machine_effect: null,
    confidence: ambiguous ? 0.55 : 0.95,
    effective_from: null,
    evidence: [{ source_message_id: sourceMessageId, quote: statement }],
    grounding: "user_statement" as const,
    explicitness: "explicit" as const,
    sensitivity: sensitive ? ("sensitive" as const) : ("normal" as const),
    ambiguity: ambiguous ? ("ambiguous" as const) : ("clear" as const),
  };
}

function rejectCandidateWithAudit(db: Db, id: number): boolean {
  return db.transaction(() => {
    const candidate = getCandidate(db, id);
    if (!candidate || candidate.status !== "pending") return false;
    if (!resolveCandidate(db, id, "rejected")) return false;
    recordCandidateResolution(db, {
      candidateId: id,
      decision: "rejected",
      sourceKind: "user_action",
    });
    return true;
  })();
}

async function embedAppliedMemory(
  db: Db,
  applied: Pick<ApplyResult, "facts" | "facets">,
  passages: readonly { id: number; text: string }[],
): Promise<void> {
  const uniquePassages = [
    ...new Map(passages.map((passage) => [passage.id, passage])).values(),
  ];
  const jobs: Array<() => Promise<boolean>> = [
    ...applied.facts.map(
      (fact) => () =>
        embedFact(
          db,
          fact.id,
          factSearchText(fact.subject_name, fact.predicate, fact.object),
        ).catch(() => false),
    ),
    ...applied.facets.map(
      (facet) => () =>
        embedFacet(
          db,
          facet.id,
          facetSearchText(facet.kind, facet.statement, facet.condition_text),
        ).catch(() => false),
    ),
    ...uniquePassages.map(
      (passage) => () => embedPassage(db, passage.id, passage.text).catch(() => false),
    ),
  ];

  // Local inference is CPU-bound. A small bound prevents a large historical batch
  // from launching hundreds of model calls at once while keeping single reviews fast.
  for (let index = 0; index < jobs.length; index += 4) {
    await Promise.all(jobs.slice(index, index + 4).map((job) => job()));
  }
}

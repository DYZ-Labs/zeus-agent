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
import { updateCalendarActionSetting } from "@/core/calendar-policy";
import { syncCalendar } from "@/core/calendar-sync";
import { CONNECT_SYNC_TIMEOUT_MS, syncEmail } from "@/core/email-sync";
import {
  CAPABILITY_SLOTS,
  ConnectorPresetError,
  bindCapability,
  configureConnectorPreset,
  createConnector,
  deleteGoogleCalendarConnector,
  deleteGoogleGmailConnector,
  deleteConnector,
  getCapability,
  getConnector,
  getConnectorByPresetId,
  getGoogleCalendarConnector,
  getGoogleGmailConnector,
  setCapabilityEnabled,
  setConnectorEnabled,
} from "@/core/connectors";
import { getConnectorPreset, presetCapability } from "@/core/connector-catalog";
import { getSignal } from "@/core/detectors";
import {
  confirmEffect,
  declineEffect,
  executeConfirmedEffect,
  getProposedEffect,
} from "@/core/effects";
import { ConnectorError, probeConnectorPreset, verifyConnector } from "@/core/mcp-client";
import { createSafeWorkExecutor } from "@/core/work-execution";
import { resumeWorkRun } from "@/core/work-plans";
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
  recordSignalDecision,
  setStewardshipMode,
  signalChatPrompt,
} from "@/core/stewardship";
import { getOwnerAccess, requireOwnerDb } from "@/server/auth/access";
import {
  disconnectGoogleCalendarGrant,
  recordConnectionAction,
} from "@/server/google-calendar/integration";
import { disconnectGoogleGmailGrant } from "@/server/google-gmail/integration";

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

/**
 * Turn unattended calendar changes on or off.
 *
 * The setting removes the interruption, never the record: every change still writes a
 * receipt, and the conflict gate still has to clear before it applies. Switching it is an
 * explicit user action so `authorized_by_policy` always traces back to one.
 */
export async function setCalendarDirectExecutionAction(formData: FormData): Promise<void> {
  const enabled = formData.get("directExecution") === "on";
  const db = await requireOwnerDb();
  const source = curationMessage(
    db,
    enabled
      ? "Carry out calendar changes I ask for without confirming each one, when the time is free."
      : "Ask me to confirm every calendar change before making it.",
  );
  updateCalendarActionSetting(db, { directExecution: enabled }, source.id);
  revalidatePath("/settings");
  revalidatePath("/");
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

/**
 * Connections and external requests.
 *
 * Everything here is an explicit user act, so every one of these writes a real user
 * message first and passes its id down as provenance. That is what lets the store answer
 * "who allowed this?" for a connector, a capability, and — most importantly — for each
 * individual external request Zeus was permitted to send.
 */

export type ConnectorSetupCode =
  | "idle"
  | "connected"
  | "updated"
  | "local_only"
  | "invalid_request"
  | "invalid_preset"
  | "invalid_permissions"
  | "gcloud_missing"
  | "gcloud_unavailable"
  | "project_missing"
  | "adc_missing"
  | "scope_missing"
  | "api_or_iam_missing"
  | "server_unreachable"
  | "tool_contract_changed"
  | "already_connected";

export type ConnectorSetupState = {
  status: "idle" | "success" | "error";
  code: ConnectorSetupCode;
  message: string;
};

/**
 * Probe and apply the complete catalog decision in one user action.
 *
 * The network handshake happens before any write. Once it succeeds, the curation source,
 * connector, live schema bindings, and enabled grants are committed together, so neither
 * a failed provider check nor a partial database update can leave misleading state.
 */
export async function configureConnectorPresetAction(
  _previousState: ConnectorSetupState,
  formData: FormData,
): Promise<ConnectorSetupState> {
  const presetId = String(formData.get("presetId") ?? "");
  const rawSlots = formData.getAll("slots").map(String);
  if (
    rawSlots.length === 0 ||
    rawSlots.some(
      (slot) => !CAPABILITY_SLOTS.includes(slot as (typeof CAPABILITY_SLOTS)[number]),
    )
  ) {
    return connectorSetupError("invalid_permissions");
  }
  const selectedSlots = [...new Set(rawSlots)] as (typeof CAPABILITY_SLOTS)[number][];
  const expectedIdText = String(formData.get("connectorId") ?? "").trim();
  const expectedConnectorId = expectedIdText ? Number(expectedIdText) : undefined;
  // The browser submits a preset id and slot names; everything else — endpoint, remote tool
  // names, scopes — is resolved again from the trusted catalog. Presets are looked up rather
  // than compared against one literal, so adding Gmail did not mean adding a second branch
  // here that could drift from the first.
  const preset = getConnectorPreset(presetId);
  if (!preset) return connectorSetupError("invalid_preset");
  if (expectedConnectorId !== undefined && !Number.isInteger(expectedConnectorId)) {
    return connectorSetupError("invalid_request");
  }
  // A slot this preset cannot fill is not a permission it can be granted, whatever the form
  // said. `connectorPresetScopes` would throw on it later; refusing here keeps the failure a
  // form error rather than an exception.
  if (selectedSlots.some((slot) => !presetCapability(preset, slot))) {
    return connectorSetupError("invalid_permissions");
  }

  const access = await getOwnerAccess();
  if (access.state !== "local") return connectorSetupError("local_only", preset.label);
  const db = access.db;
  const existing = getConnectorByPresetId(db, presetId);
  if (expectedConnectorId === undefined && existing) {
    return connectorSetupError("already_connected", preset.label);
  }
  if (
    expectedConnectorId !== undefined &&
    (!existing || existing.id !== expectedConnectorId)
  ) {
    return connectorSetupError("invalid_request");
  }

  let tools: Awaited<ReturnType<typeof probeConnectorPreset>>["tools"];
  try {
    ({ tools } = await probeConnectorPreset(presetId, selectedSlots, {
      tokenFailureCode: existing ? "scope_missing" : "adc_missing",
    }));
  } catch (error) {
    return connectorSetupStateForError(error, preset.label);
  }

  try {
    db.transaction(() => {
      const decision = selectedSlots.join(", ");
      const source = curationMessage(
        db,
        existing
          ? `Set ${preset.label} permissions to: ${decision}.`
          : `Connect ${preset.label} with permissions: ${decision}.`,
      );
      configureConnectorPreset(db, {
        presetId,
        selectedSlots,
        discoveredTools: tools,
        sourceMessageId: source.id,
        connectorId: existing?.id,
      });
    })();
  } catch (error) {
    return connectorSetupStateForError(error);
  }

  revalidatePath("/settings");
  revalidatePath("/today");
  return {
    status: "success",
    code: existing ? "updated" : "connected",
    message: existing
      ? `${preset.label} permissions were updated.`
      : `${preset.label} is connected.`,
  };
}

export async function addConnectorAction(formData: FormData): Promise<void> {
  const label = normalizedText(formData.get("label"), 120);
  const transport = String(formData.get("transport") ?? "stdio");
  if (!label || (transport !== "stdio" && transport !== "http")) return;
  const db = await requireOwnerDb();
  const envVarNames = String(formData.get("envVarNames") ?? "")
    .split(/[\s,]+/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const source = curationMessage(db, `Connect the service "${label}".`);
  try {
    createConnector(db, {
      label,
      transport,
      command: normalizedText(formData.get("command"), 500),
      args: String(formData.get("args") ?? "")
        .split(/\s+/u)
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0),
      cwd: normalizedText(formData.get("cwd"), 500) || null,
      url: normalizedText(formData.get("url"), 2000) || null,
      envVarNames,
      sourceMessageId: source.id,
    });
  } catch (error) {
    // Surfacing the reason matters here: "names only, never values" is a rule the user
    // has to understand, not just obey.
    redirect(`/settings?connector_error=${encodeURIComponent(connectorErrorMessage(error))}#connections`);
  }
  revalidatePath("/settings");
}

export async function verifyConnectorAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  try {
    await verifyConnector(db, id);
  } catch (error) {
    redirect(`/settings?connector_error=${encodeURIComponent(connectorErrorMessage(error))}#connections`);
  }
  // A verify that put a calendar back into service should also put its schedule back: warm
  // the cache now rather than on the next turn. `syncCalendar` never throws and refuses on
  // its own when this connector serves no calendar capability.
  const connector = getConnector(db, id);
  if (
    connector?.provider === "google_calendar" ||
    connector?.capabilities.some((capability) => capability.slot === "calendar.list_events")
  ) {
    await syncCalendar(db, { signal: AbortSignal.timeout(10_000) });
  }
  if (
    connector?.provider === "google_gmail" ||
    connector?.capabilities.some((capability) => capability.slot === "email.search_threads")
  ) {
    await syncEmail(db, { signal: AbortSignal.timeout(CONNECT_SYNC_TIMEOUT_MS) });
  }
  revalidatePath("/settings");
}

/**
 * Bind a discovered tool to a capability slot.
 *
 * The schema comes from what the connector actually offers, not from the form: the hash
 * stored here is what a later drift check compares against, so it has to describe a real
 * contract the user could have read.
 */
export async function bindCapabilityAction(formData: FormData): Promise<void> {
  const connectorId = Number(formData.get("connectorId"));
  const slot = String(formData.get("slot") ?? "");
  const remoteToolName = normalizedText(formData.get("remoteToolName"), 200);
  if (!Number.isInteger(connectorId) || !remoteToolName) return;
  if (!CAPABILITY_SLOTS.includes(slot as (typeof CAPABILITY_SLOTS)[number])) return;
  const db = await requireOwnerDb();
  const connector = getConnector(db, connectorId);
  const discovered = connector?.discoveredTools.find((tool) => tool.name === remoteToolName);
  if (!discovered) {
    redirect(
      `/settings?connector_error=${encodeURIComponent(
        `Verify the connection first, then pick a tool it actually offers.`,
      )}#connections`,
    );
  }
  const source = curationMessage(
    db,
    `Allow "${remoteToolName}" to fill the ${slot} capability.`,
  );
  bindCapability(db, {
    connectorId,
    slot: slot as (typeof CAPABILITY_SLOTS)[number],
    remoteToolName,
    inputSchema: discovered.inputSchema,
    sourceMessageId: source.id,
  });
  revalidatePath("/settings");
}

export async function setConnectorEnabledAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const source = curationMessage(
    db,
    enabled ? `Enable connected service ${id}.` : `Disable connected service ${id}.`,
  );
  try {
    setConnectorEnabled(db, id, enabled, source.id);
  } catch (error) {
    redirect(`/settings?connector_error=${encodeURIComponent(connectorErrorMessage(error))}#connections`);
  }
  revalidatePath("/settings");
  revalidatePath("/today");
}

export async function setCapabilityEnabledAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const capability = getCapability(db, id);
  if (!capability) return;
  const source = curationMessage(
    db,
    enabled
      ? `Allow Zeus to use ${capability.slot} through "${capability.remote_tool_name}".`
      : `Stop allowing ${capability.slot}.`,
  );
  try {
    setCapabilityEnabled(db, id, enabled, source.id);
  } catch (error) {
    redirect(`/settings?connector_error=${encodeURIComponent(connectorErrorMessage(error))}#connections`);
  }
  revalidatePath("/settings");
  revalidatePath("/today");
}

export async function removeConnectorAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  curationMessage(db, `Remove connected service ${id}.`);
  deleteConnector(db, id);
  revalidatePath("/settings");
  revalidatePath("/today");
}

export async function disconnectGoogleCalendarAction(): Promise<void> {
  const access = await getOwnerAccess();
  if (!access.canAccessPrivateData || access.state !== "authorized" || !access.account) {
    redirect(
      `/settings?connector_error=${encodeURIComponent(
        "Sign in before disconnecting Google Calendar.",
      )}#connections`,
    );
  }
  const connector = getGoogleCalendarConnector(access.db);
  if (!connector?.provider_connection_id) return;
  try {
    await disconnectGoogleCalendarGrant(
      access.account.id,
      connector.provider_connection_id,
    );
  } catch (error) {
    redirect(
      `/settings?connector_error=${encodeURIComponent(connectorErrorMessage(error))}#connections`,
    );
  }
  recordConnectionAction(access.db, "Disconnect Google Calendar and revoke its access.");
  deleteGoogleCalendarConnector(access.db, connector.id);
  revalidatePath("/settings");
  revalidatePath("/today");
}

export async function disconnectGoogleGmailAction(): Promise<void> {
  const access = await getOwnerAccess();
  if (!access.canAccessPrivateData || access.state !== "authorized" || !access.account) {
    redirect(
      `/settings?connector_error=${encodeURIComponent(
        "Sign in before disconnecting Gmail.",
      )}#connections`,
    );
  }
  const connector = getGoogleGmailConnector(access.db);
  if (!connector?.provider_connection_id) return;
  try {
    await disconnectGoogleGmailGrant(
      access.account.id,
      connector.provider_connection_id,
    );
  } catch (error) {
    redirect(
      `/settings?connector_error=${encodeURIComponent(connectorErrorMessage(error))}#connections`,
    );
  }
  recordConnectionAction(access.db, "Disconnect Gmail and revoke its read access.");
  deleteGoogleGmailConnector(access.db, connector.id);
  revalidatePath("/settings");
  revalidatePath("/today");
}

/**
 * Confirm one exact external request, then let it happen.
 *
 * The confirming message contains the payload hash because that is what makes it a
 * confirmation rather than a general assent — `confirmEffect` refuses anything else. The
 * send and the run's resumption follow only after that record exists.
 */
export async function confirmEffectAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const payloadHash = String(formData.get("payloadHash") ?? "");
  if (!Number.isInteger(id) || !/^[0-9a-f]{64}$/u.test(payloadHash)) return;
  const db = await requireOwnerDb();
  const effect = getProposedEffect(db, id);
  if (!effect || effect.status !== "pending_confirmation") return;
  // The decision is the first line and nothing echoed back can influence it; the
  // description follows as context so the message still reads as a record of what
  // was agreed to.
  const source = curationMessage(
    db,
    `I confirm external request ${payloadHash}.\n${effect.preview_text}`,
  );
  try {
    confirmEffect(db, id, payloadHash, source.id);
  } catch (error) {
    redirect(`/today?effect_error=${encodeURIComponent(connectorErrorMessage(error))}#confirmations`);
  }
  const result = await executeConfirmedEffect(db, id);
  if (result.status === "executed") {
    // The run was parked waiting for exactly this. Resuming here means the user sees the
    // finished work rather than having to ask for it again.
    await resumeWorkRun(db, effect.work_run_id, {
      executor: createSafeWorkExecutor(db),
    }).catch(() => undefined);
  }
  revalidatePath("/today");
  revalidatePath("/");
}

export async function declineEffectAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const reason = normalizedText(formData.get("reason"), 500);
  if (!Number.isInteger(id)) return;
  const db = await requireOwnerDb();
  const effect = getProposedEffect(db, id);
  if (!effect || effect.status !== "pending_confirmation") return;
  const source = curationMessage(db, `Do not send this external request: ${effect.preview_text}`);
  declineEffect(db, id, source.id, reason || undefined);
  revalidatePath("/today");
}

export async function signalDecisionAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const decision = String(formData.get("decision") ?? "") as FollowThroughEventType;
  const reason = normalizedText(formData.get("reason"), 1000);
  if (!Number.isInteger(id)) return;
  if (!["accepted", "dismissed", "snoozed", "completed", "regretted"].includes(decision)) return;
  const db = await requireOwnerDb();
  const signal = getSignal(db, id);
  if (!signal) return;
  const source = curationMessage(db, `Recorded "${decision}" on: ${signal.why}`);
  recordSignalDecision(db, {
    signalId: id,
    decision: decision as Exclude<FollowThroughEventType, "surfaced">,
    sourceMessageId: source.id,
    userReason: reason || null,
  });
  revalidatePath("/today");
  revalidatePath("/settings");
  // "Help me fix this" used to record the decision and stop there, which made the most
  // action-shaped button on the page the one that did the least. Accepting a signal now
  // opens chat on the request itself, the same handoff a follow-through acceptance makes.
  // Still only a prefilled prompt: the turn it starts is bound by every gate a typed one is.
  if (decision === "accepted") {
    redirect(`/?prompt=${encodeURIComponent(signalChatPrompt(signal))}`);
  }
}

/** Show why a connection or request was refused, without leaking anything it contained. */
function connectorErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "That did not work.";
  return message.slice(0, 200);
}

function connectorSetupStateForError(
  error: unknown,
  serviceLabel = "Google Calendar",
): ConnectorSetupState {
  if (error instanceof ConnectorError || error instanceof ConnectorPresetError) {
    return connectorSetupError(
      isConnectorSetupErrorCode(error.code) ? error.code : "invalid_request",
      serviceLabel,
    );
  }
  return connectorSetupError("invalid_request");
}

function isConnectorSetupErrorCode(value: string): value is Exclude<
  ConnectorSetupCode,
  "idle" | "connected" | "updated"
> {
  return [
    "local_only",
    "invalid_request",
    "invalid_preset",
    "invalid_permissions",
    "gcloud_missing",
    "gcloud_unavailable",
    "project_missing",
    "adc_missing",
    "scope_missing",
    "api_or_iam_missing",
    "server_unreachable",
    "tool_contract_changed",
    "already_connected",
  ].includes(value);
}

function connectorSetupError(
  code: Exclude<ConnectorSetupCode, "idle" | "connected" | "updated">,
  serviceLabel = "Google Calendar",
): ConnectorSetupState {
  const gmail = serviceLabel === "Gmail";
  const messages: Record<typeof code, string> = {
    local_only: gmail
      ? "Guided Gmail setup is available only in local mode."
      : "Guided Google Calendar setup is available only in local mode.",
    invalid_request: "That connection request was invalid. Refresh Settings and try again.",
    invalid_preset: "That connection preset is not available.",
    invalid_permissions: gmail
      ? "Select at least one Gmail permission."
      : "Select at least one Google Calendar permission.",
    gcloud_missing: "Install the Google Cloud CLI, then run the setup check again.",
    gcloud_unavailable: "The Google Cloud CLI did not answer safely. Try its commands in a terminal.",
    project_missing: `Select an active Google Cloud project before connecting ${gmail ? "Gmail" : "Calendar"}.`,
    adc_missing: `Create Application Default Credentials with the generated ${gmail ? "Gmail" : "Calendar"} scopes.`,
    scope_missing: `Your Application Default Credentials need the newly selected ${gmail ? "Gmail" : "Calendar"} scopes.`,
    api_or_iam_missing: "Check that both APIs and the required IAM roles are enabled in the active project.",
    server_unreachable: `Zeus could not reach Google's ${gmail ? "Gmail" : "Calendar"} MCP server. No connection was saved.`,
    tool_contract_changed: `Google's ${gmail ? "Gmail" : "Calendar"} tool contract changed, so Zeus left the permission disabled for review.`,
    already_connected: `${gmail ? "Gmail" : "Google Calendar"} is already connected. Refresh Settings to manage its permissions.`,
  };
  return { status: "error", code, message: messages[code] };
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

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { resolveCandidate } from "@/core/candidates";
import { appendMessage, createConversation, listConversations } from "@/core/conversations";
import { deleteEmbedding, embedFact } from "@/core/embed";
import { mergeEntities, resolveEntity, setEntitySummary } from "@/core/entities";
import { acceptCandidate } from "@/core/extract";
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
  deleteAllConversationsWithMemory,
  deleteConversationWithMemory,
} from "@/core/retention";
import type { Db } from "@/core/db";
import type {
  Cardinality,
  CommitmentStatus,
  FollowThroughEventType,
  GoalPriority,
  GoalStatus,
  StewardshipMode,
} from "@/core/schema";
import {
  recommendationForCommitment,
  recordFollowThroughDecision,
  setStewardshipMode,
} from "@/core/stewardship";
import { getDb } from "@/server/db";

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

  const db = getDb();
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
  const db = getDb();
  const applied = acceptCandidate(db, id);
  if (applied) {
    await Promise.all(
      applied.facts.map((fact) =>
        embedFact(
          db,
          fact.id,
          factSearchText(fact.subject_name, fact.predicate, fact.object),
        ).catch(() => false),
      ),
    );
  }
  revalidatePath("/memory");
  revalidatePath("/today");
}

export async function rejectCandidateAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  resolveCandidate(getDb(), id, "rejected");
  revalidatePath("/memory");
}

export async function updateGoalStatusAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "") as GoalStatus;
  if (
    !Number.isInteger(id) ||
    !["active", "paused", "achieved", "abandoned"].includes(status)
  ) return;
  const db = getDb();
  const goal = getGoal(db, id);
  if (!goal) return;
  const source = curationMessage(db, `Set goal "${goal.title}" to ${status}.`);
  updateGoal(db, id, {
    status,
    sourceMessageId: source.id,
    sourceKind: "message",
  });
  revalidatePath("/today");
}

export async function setGoalPriorityAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const priority = String(formData.get("priority") ?? "") as GoalPriority;
  if (!Number.isInteger(id) || !["low", "normal", "high"].includes(priority)) return;
  const db = getDb();
  const goal = getGoal(db, id);
  if (!goal || goal.priority === priority) return;
  const source = curationMessage(db, `Set goal "${goal.title}" to ${priority} priority.`);
  updateGoal(db, id, {
    priority,
    sourceMessageId: source.id,
    sourceKind: "message",
  });
  revalidatePath("/today");
}

export async function updateCommitmentStatusAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const status = String(formData.get("status") ?? "") as CommitmentStatus;
  if (!Number.isInteger(id) || !["open", "waiting", "done", "cancelled"].includes(status)) {
    return;
  }
  const db = getDb();
  const commitment = getCommitment(db, id);
  if (!commitment) return;
  const source = curationMessage(
    db,
    `Set commitment "${commitment.title}" to ${status}.`,
  );
  updateCommitment(db, id, {
    status,
    sourceMessageId: source.id,
    sourceKind: "message",
  });
  revalidatePath("/today");
}

export async function snoozeCommitmentAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const until = String(formData.get("until") ?? "");
  if (!Number.isInteger(id) || !until) return;
  const db = getDb();
  const commitment = getCommitment(db, id);
  if (!commitment) return;
  const source = curationMessage(
    db,
    `Snoozed nudges for commitment "${commitment.title}" until ${until}.`,
  );
  updateCommitment(db, id, {
    snoozedUntil: until,
    sourceMessageId: source.id,
    sourceKind: "message",
  });
  revalidatePath("/today");
}

export async function setStewardshipModeAction(formData: FormData): Promise<void> {
  const mode = String(formData.get("mode") ?? "") as StewardshipMode;
  if (!["quiet", "balanced", "proactive"].includes(mode)) return;
  const db = getDb();
  const source = curationMessage(db, `Set follow-through mode to ${mode}.`);
  setStewardshipMode(db, mode, source.id);
  revalidatePath("/today");
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
  const db = getDb();
  const recommendation = recommendationForCommitment(db, commitmentId);
  const event = recordFollowThroughDecision(db, { commitmentId, decision });
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
  if (!Number.isInteger(id) || confirmation !== "delete") return;
  deleteConversationWithMemory(getDb(), id);
  revalidatePath("/", "layout");
  revalidatePath("/memory");
  revalidatePath("/today");
  revalidatePath("/conversations");
  revalidatePath("/settings");
  redirect("/settings#data");
}

export async function deleteAllConversationsAction(formData: FormData): Promise<void> {
  const confirmation = String(formData.get("confirmation") ?? "");
  if (confirmation !== "delete-all") return;

  deleteAllConversationsWithMemory(getDb());
  revalidatePath("/", "layout");
  revalidatePath("/memory");
  revalidatePath("/today");
  revalidatePath("/conversations");
  revalidatePath("/settings");
  redirect("/settings#data");
}

export async function supersedeFactAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;

  const db = getDb();
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

  const db = getDb();
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

  const db = getDb();
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

  setPredicateCardinality(getDb(), name, cardinality);
  revalidatePath("/memory");
}

export async function mergeEntitiesAction(formData: FormData): Promise<void> {
  const source = Number(formData.get("source"));
  const target = Number(formData.get("target"));
  if (!Number.isInteger(source) || !Number.isInteger(target)) return;

  mergeEntities(getDb(), source, target);
  revalidatePath("/memory");
}

export async function setSummaryAction(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const slug = String(formData.get("slug") ?? "");
  const summary = String(formData.get("summary") ?? "").trim();
  if (!Number.isInteger(id)) return;

  setEntitySummary(getDb(), id, summary || null);
  if (slug) revalidatePath(`/entity/${slug}`);
}

function curationMessage(db: Db, content: string) {
  const conversation =
    listConversations(db, 100).find((entry) => entry.title === "Memory curation") ??
    createConversation(db, { title: "Memory curation", source: "web" });
  return appendMessage(db, conversation.id, "user", content);
}

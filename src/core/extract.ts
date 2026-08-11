import { zodTextFormat } from "openai/helpers/zod";

import { MODEL, assertResponseComplete, openai } from "./openai";
import { createCandidate, getCandidate, resolveCandidate } from "./candidates";
import type { CandidateView } from "./candidates";
import type { Db } from "./db";
import { resolveEntity, selfEntity, upsertEntity } from "./entities";
import { getPredicate, listPredicates, liveFacts, recordFact } from "./facts";
import {
  createCommitment,
  createGoal,
  getCommitment,
  getGoal,
  listCommitments,
  listGoals,
  updateCommitment,
  updateGoal,
} from "./intentions";
import type {
  CandidateReason,
  CommitmentView,
  ExtractedCommitment,
  ExtractedFact,
  ExtractedGoal,
  Extraction,
  FactView,
  Goal,
  Message,
  ParsedExtraction,
} from "./schema";
import { Extraction as ExtractionSchema, SELF_REF } from "./schema";

/**
 * Distilling durable knowledge and open loops out of conversation. The model proposes;
 * the deterministic policy below decides what is safe to become canonical.
 */

const SYSTEM_PROMPT = `You extract durable memory from a conversation between a user and their personal assistant.

Only the user's statements can be evidence. Assistant text may help resolve what a short reply such as "yes, do that" refers to, but an idea, claim, or suggestion that appears only in assistant text must be marked assistant_only and must never be restated as a user fact.

A fact is worth extracting when it is likely to remain useful in six months: names, relationships, roles, locations, preferences, ongoing projects, values, and topics the user explicitly follows. Passing states and details of the current chat are not durable facts.

Goals are outcomes the user wants to achieve. Commitments are concrete promises, next actions, or things the user is waiting on. Do not also encode goals or commitments as generic facts. Use an existing ID when the user updates, completes, pauses, abandons, waits on, or cancels an item from the supplied lists. When a new commitment belongs to a new goal in the same output, use linked_goal_title with the exact new goal title.

Declare every named person who owns a commitment in entities. Use "self" for the user rather than declaring them.

Extract nothing rather than noise. Do not fill missing owners, dates, or motives. Mark an item inferred when interpretation is required, ambiguous when a material detail is unclear, sensitive for health, finance, legal, intimate identity, credentials, or private secrets, and assistant_only when the user never stated or endorsed it.

Write facts as subject, snake_case predicate, and a short object phrase. Use "${SELF_REF}" for the user. Link object_entity when the object is an entity. Set supersedes_previous only when the user clearly states a correction or life change. effective_from is only a date the user actually supplied.

Confidence: 0.9+ for a direct user statement about themselves, 0.7-0.85 for a clear statement about someone else, and below 0.6 for inference.`;

export type ExtractionContext = {
  knownPredicates: readonly string[];
  knownEntities: readonly string[];
  activeGoals: readonly { id: number; title: string; status: string; target_at: string | null }[];
  openCommitments: readonly {
    id: number;
    title: string;
    status: string;
    owner: string;
    due_at: string | null;
  }[];
};

export function extractionContext(db: Db, entityLimit = 100): ExtractionContext {
  const knownPredicates = listPredicates(db).map((predicate) => predicate.name);
  const knownEntities = db
    .prepare<[number], { name: string }>(
      "SELECT name FROM entity WHERE slug != 'self' ORDER BY updated_at DESC LIMIT ?",
    )
    .all(entityLimit)
    .map((row) => row.name);
  const activeGoals = listGoals(db, { limit: 30 }).map((goal) => ({
    id: goal.id,
    title: goal.title,
    status: goal.status,
    target_at: goal.target_at,
  }));
  const openCommitments = listCommitments(db, { limit: 50 }).map((commitment) => ({
    id: commitment.id,
    title: commitment.title,
    status: commitment.status,
    owner: commitment.owner_name,
    due_at: commitment.due_at,
  }));

  return { knownPredicates, knownEntities, activeGoals, openCommitments };
}

function renderTranscript(messages: readonly Pick<Message, "role" | "content">[]): string {
  return messages
    .map((message, index) =>
      `${message.role === "user" ? "USER EVIDENCE" : "ASSISTANT CONTEXT ONLY"} ${index + 1}: ${message.content}`,
    )
    .join("\n\n");
}

export type ExtractOptions = {
  messages: readonly Pick<Message, "role" | "content">[];
  context: ExtractionContext;
};

function emptyExtraction(): ParsedExtraction {
  return ExtractionSchema.parse({ entities: [], facts: [], goals: [], commitments: [] });
}

export async function extract(options: ExtractOptions): Promise<ParsedExtraction> {
  const transcript = renderTranscript(options.messages);
  if (!transcript.trim()) return emptyExtraction();

  const known = [
    `Current date: ${new Date().toISOString()}`,
    options.context.knownPredicates.length
      ? `Existing predicates: ${options.context.knownPredicates.join(", ")}`
      : null,
    options.context.knownEntities.length
      ? `Entities already known: ${options.context.knownEntities.join(", ")}`
      : null,
    options.context.activeGoals.length
      ? `Active goals (use IDs for updates): ${JSON.stringify(options.context.activeGoals)}`
      : null,
    options.context.openCommitments.length
      ? `Open commitments (use IDs for updates): ${JSON.stringify(options.context.openCommitments)}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const response = await openai().responses.parse({
    model: MODEL,
    max_output_tokens: 8000,
    reasoning: { effort: "low" },
    instructions: SYSTEM_PROMPT,
    text: { format: zodTextFormat(ExtractionSchema, "memory_extraction") },
    input: [
      {
        role: "user",
        content: `${known}\n\nConversation to extract from:\n\n${transcript}`,
      },
    ],
    store: false,
  });

  assertResponseComplete(response);

  return response.output_parsed ?? emptyExtraction();
}

export type ApplyResult = {
  facts: FactView[];
  goals: Goal[];
  commitments: CommitmentView[];
  candidates: CandidateView[];
  supersededIds: number[];
  skipped: { subject: string; predicate: string; object: string; reason: string }[];
};

export function emptyApplyResult(): ApplyResult {
  return {
    facts: [],
    goals: [],
    commitments: [],
    candidates: [],
    supersededIds: [],
    skipped: [],
  };
}

export function applyExtraction(
  db: Db,
  extraction: Extraction,
  sourceMessageId: number | null = null,
  options: { forceAccept?: boolean } = {},
): ApplyResult {
  const parsed = ExtractionSchema.parse(extraction);
  const result = emptyApplyResult();

  if (sourceMessageId !== null) {
    const role = db
      .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
      .get(sourceMessageId)?.role;
    if (role !== "user") {
      throw new Error("Memory extraction source must be a stored user message");
    }
  }

  return db.transaction((): ApplyResult => {
    for (const entity of parsed.entities) {
      if (!entity.name.trim() || isSelf(entity.name)) continue;
      upsertEntity(db, {
        name: entity.name,
        kind: entity.kind,
        aliases: entity.aliases.filter((alias) => alias.trim()),
      });
    }

    for (const fact of parsed.facts) {
      applyFact(db, fact, sourceMessageId, result, options.forceAccept ?? false);
    }
    for (const goal of parsed.goals) {
      applyGoal(db, goal, sourceMessageId, result, options.forceAccept ?? false);
    }
    for (const commitment of parsed.commitments) {
      applyCommitment(db, commitment, sourceMessageId, result, options.forceAccept ?? false);
    }

    return result;
  })();
}

function applyFact(
  db: Db,
  fact: ParsedExtraction["facts"][number],
  sourceMessageId: number | null,
  result: ApplyResult,
  forceAccept: boolean,
): void {
  const object = fact.object.trim();
  const predicate = normalizePredicate(fact.predicate);
  if (!object || !predicate) {
    skip(result, fact.subject, fact.predicate, fact.object, "empty predicate or object");
    return;
  }
  if (fact.grounding === "assistant_only") {
    skip(result, fact.subject, predicate, object, "appeared only in assistant text");
    return;
  }

  const me = selfEntity(db);
  const subject = isSelf(fact.subject) ? me : resolveEntity(db, fact.subject);
  if (!subject) {
    skip(result, fact.subject, predicate, object, "subject entity was not declared in the extraction");
    return;
  }

  const objectEntity =
    fact.object_entity && isSelf(fact.object_entity)
      ? me
      : fact.object_entity
        ? resolveEntity(db, fact.object_entity)
        : null;

  const registered = getPredicate(db, predicate);
  const conflicting =
    registered?.cardinality === "single" &&
    liveFacts(db, subject.id, predicate).some(
      (current) =>
        !(
          current.object_entity_id !== null &&
          objectEntity !== null &&
          current.object_entity_id === objectEntity.id
        ) && fold(current.object) !== fold(object),
    );
  const hasExplicitChange =
    fact.supersedes_previous && sourceHasExplicitChange(db, sourceMessageId);
  const reason = forceAccept
    ? null
    : trustReason(
        withSourceSensitivity(db, sourceMessageId, fact),
        conflicting && !hasExplicitChange,
      );
  if (reason) {
    if (sourceMessageId === null) {
      skip(result, fact.subject, predicate, object, `requires review (${reason}) but has no source`);
      return;
    }
    result.candidates.push(
      createCandidate(db, {
        kind: predicate === "cares_about" ? "interest" : "fact",
        payload: fact,
        reason,
        confidence: fact.confidence,
        sourceMessageId,
      }),
    );
    return;
  }

  const written = recordFact(db, {
    subjectId: subject.id,
    predicate,
    object,
    objectEntityId: objectEntity?.id ?? null,
    confidence: fact.confidence,
    sourceMessageId,
    validFrom: fact.effective_from,
    evidenceKind: hasExplicitChange || (forceAccept && conflicting) ? "correction" : "assertion",
  });
  result.facts.push(written.fact);
  result.supersededIds.push(...written.supersededIds);
}

function applyGoal(
  db: Db,
  goal: ParsedExtraction["goals"][number],
  sourceMessageId: number | null,
  result: ApplyResult,
  forceAccept: boolean,
): void {
  if (!goal.title.trim() || goal.grounding === "assistant_only") return;
  const existing = goal.existing_id === null ? null : getGoal(db, goal.existing_id);
  const invalidReference = goal.existing_id !== null && existing === null;
  const terminalWithoutExisting =
    goal.existing_id === null && (goal.status === "achieved" || goal.status === "abandoned");
  const reason = forceAccept
    ? null
    : trustReason(
        withSourceSensitivity(db, sourceMessageId, goal),
        invalidReference || terminalWithoutExisting,
      );
  if (reason || sourceMessageId === null) {
    if (sourceMessageId !== null) {
      result.candidates.push(
        createCandidate(db, {
          kind: "goal",
          payload: goal,
          reason: reason ?? "ambiguous",
          confidence: goal.confidence,
          sourceMessageId,
        }),
      );
    }
    return;
  }
  const applied = existing
    ? updateGoal(db, existing.id, {
        title: goal.title,
        status: goal.status,
        targetAt: goal.target_at,
        confidence: goal.confidence,
        sourceMessageId,
        sourceKind: "message",
      })
    : createGoal(db, {
        title: goal.title,
        status: goal.status,
        targetAt: goal.target_at,
        confidence: goal.confidence,
        sourceMessageId,
      });
  if (applied) result.goals.push(applied);
}

function applyCommitment(
  db: Db,
  commitment: ParsedExtraction["commitments"][number],
  sourceMessageId: number | null,
  result: ApplyResult,
  forceAccept: boolean,
): void {
  if (!commitment.title.trim() || commitment.grounding === "assistant_only") return;
  const existing =
    commitment.existing_id === null ? null : getCommitment(db, commitment.existing_id);
  const owner = isSelf(commitment.owner)
    ? selfEntity(db)
    : resolveEntity(db, commitment.owner);
  const linkedGoal =
    commitment.linked_goal_id !== null
      ? getGoal(db, commitment.linked_goal_id)
      : commitment.linked_goal_title
        ? listGoals(db, { includeClosed: true, limit: 500 }).find(
            (goal) => fold(goal.title) === fold(commitment.linked_goal_title ?? ""),
          ) ?? null
        : null;
  const requestedGoalLink =
    commitment.linked_goal_id !== null || commitment.linked_goal_title !== null;
  const invalidReference =
    (commitment.existing_id !== null && existing === null) ||
    owner === null ||
    (requestedGoalLink && linkedGoal === null) ||
    (commitment.existing_id === null &&
      (commitment.status === "done" || commitment.status === "cancelled"));
  const reason = forceAccept
    ? null
    : trustReason(withSourceSensitivity(db, sourceMessageId, commitment), invalidReference);
  if (reason || sourceMessageId === null) {
    if (sourceMessageId !== null) {
      result.candidates.push(
        createCandidate(db, {
          kind: "commitment",
          payload: commitment,
          reason: reason ?? "ambiguous",
          confidence: commitment.confidence,
          sourceMessageId,
        }),
      );
    }
    return;
  }
  if (!owner) {
    throw new Error(`Cannot accept commitment with unknown owner "${commitment.owner}"`);
  }

  const applied = existing
    ? updateCommitment(db, existing.id, {
        title: commitment.title,
        ownerEntityId: owner.id,
        linkedGoalId: linkedGoal?.id ?? null,
        status: commitment.status,
        dueAt: commitment.due_at,
        confidence: commitment.confidence,
        sourceMessageId,
        sourceKind: "message",
      })
    : createCommitment(db, {
        title: commitment.title,
        ownerEntityId: owner.id,
        linkedGoalId: linkedGoal?.id ?? null,
        status: commitment.status,
        dueAt: commitment.due_at,
        confidence: commitment.confidence,
        sourceMessageId,
      });
  if (applied) result.commitments.push(applied);
}

type TrustSignal = {
  explicitness: "explicit" | "inferred";
  sensitivity: "normal" | "sensitive";
  ambiguity: "clear" | "ambiguous";
  confidence: number;
};

function trustReason(signal: TrustSignal, conflict: boolean): CandidateReason | null {
  if (signal.sensitivity === "sensitive") return "sensitive";
  if (signal.ambiguity === "ambiguous") return "ambiguous";
  if (conflict) return "conflict";
  if (signal.explicitness === "inferred" || signal.confidence < 0.6) return "inference";
  return null;
}

function withSourceSensitivity<T extends TrustSignal>(
  db: Db,
  sourceMessageId: number | null,
  signal: T,
): TrustSignal {
  if (signal.sensitivity === "sensitive" || sourceMessageId === null) return signal;
  const content = db
    .prepare<[number], { content: string }>("SELECT content FROM message WHERE id = ?")
    .get(sourceMessageId)?.content;
  if (!content) return signal;
  const looksSensitive =
    /\b(api key|bank account|credit card|credential|debt|diagnos(?:is|ed)|financial|health|income|lawsuit|legal case|medical|medication|password|religion|salary|secret|sexuality|social security)\b/iu.test(
      content,
    );
  return looksSensitive ? { ...signal, sensitivity: "sensitive" } : signal;
}

function sourceHasExplicitChange(db: Db, sourceMessageId: number | null): boolean {
  if (sourceMessageId === null) return false;
  const content = db
    .prepare<[number], { content: string }>("SELECT content FROM message WHERE id = ?")
    .get(sourceMessageId)?.content;
  return content
    ? /\b(actually|as of|became|changed|correction|joined|left|moved|new role|no longer|now|promoted|promotion|relocated|started|switched|updated)\b/iu.test(
        content,
      )
    : false;
}

/** Accepting is an explicit user action, so it bypasses the gate but keeps the source. */
export function acceptCandidate(db: Db, id: number): ApplyResult | null {
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.status !== "pending") return null;

  let extraction: Extraction;
  if (candidate.kind === "fact" || candidate.kind === "interest") {
    extraction = { entities: [], facts: [candidate.payload as ExtractedFact] };
  } else if (candidate.kind === "goal") {
    extraction = { entities: [], facts: [], goals: [candidate.payload as ExtractedGoal] };
  } else {
    extraction = {
      entities: [],
      facts: [],
      commitments: [candidate.payload as ExtractedCommitment],
    };
  }

  return db.transaction(() => {
    const applied = applyExtraction(db, extraction, candidate.source_message_id, {
      forceAccept: true,
    });
    if (!resolveCandidate(db, id, "accepted")) {
      throw new Error(`Candidate ${id} changed while it was being accepted`);
    }
    return applied;
  })();
}

function normalizePredicate(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
}

function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function skip(
  result: ApplyResult,
  subject: string,
  predicate: string,
  object: string,
  reason: string,
): void {
  result.skipped.push({ subject, predicate, object, reason });
}

function isSelf(name: string): boolean {
  const folded = name.trim().toLowerCase();
  return folded === SELF_REF || folded === "the user" || folded === "user" || folded === "me";
}

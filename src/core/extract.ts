import { zodTextFormat } from "openai/helpers/zod";

import { MODEL, assertResponseComplete, openai } from "./openai";
import {
  createCandidate,
  getCandidate,
  recordCandidateResolution,
  resolveCandidate,
} from "./candidates";
import type { CandidateView } from "./candidates";
import { now } from "./db";
import type { Db } from "./db";
import {
  AmbiguousEntityError,
  resolveEntity,
  resolveEntityCandidates,
  selfEntity,
  upsertEntity,
  upsertEntityWithEvidence,
} from "./entities";
import { listFacets, recordFacet } from "./facets";
import type { FacetScopeInput } from "./facets";
import {
  addFactEvidence,
  getPredicate,
  listPredicates,
  liveFacts,
  recomputeFactEvidenceAggregates,
  recordFact,
  retractFact,
} from "./facts";
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
  EvidencePassage,
  ExtractionEvidence,
  ExtractedFact,
  ExtractedFacet,
  ExtractedEntity,
  ExtractedGoal,
  ExtractedGoalLink,
  ExtractedFacetScope,
  Extraction,
  FactView,
  FieldPatch,
  Goal,
  Message,
  ParsedExtraction,
  UnderstandingFacetView,
} from "./schema";
import { Extraction as ExtractionSchema, SELF_REF } from "./schema";
import { toFtsQuery } from "./search";
import {
  allowPassage,
  allowWholeMessagePassage,
  blockMessageRecall,
  ensureEvidencePassage,
  passagesForMessage,
  sourceLooksSensitive,
} from "./passages";

/**
 * Distilling durable knowledge and open loops out of conversation. The model proposes;
 * the deterministic policy below decides what is safe to become canonical.
 */

const SYSTEM_PROMPT = `You extract durable memory from a conversation between a user and their personal assistant.

Only the user's statements can be evidence. Every extracted item must cite the numeric USER EVIDENCE message ID and an exact contiguous quote copied from that message. Assistant text may help resolve what a short reply such as "yes, do that" refers to, but an idea, claim, or suggestion that appears only in assistant text must be marked assistant_only and must never be restated as a user fact.

A fact is worth extracting when it is likely to remain useful in six months: names, relationships, roles, locations, preferences, ongoing projects, values, and topics the user explicitly follows. Passing states and details of the current chat are not durable facts.

Goals are outcomes the user wants to achieve. Commitments are concrete promises, next actions, or things the user is waiting on. Do not also encode goals or commitments as generic facts. Use an existing ID when the user updates, completes, pauses, abandons, waits on, or cancels an item from the supplied lists.

Mutable goal and commitment details use patches. For an existing item, use keep when the user did not mention that detail, set only when the user supplied a replacement, and clear only when the user explicitly removed it. Never translate an omitted detail into clear. For a new item, set details the user supplied and clear details that have no initial value. Clearing goal priority resets it to normal; clearing commitment owner resets it to self. To link a commitment to an existing goal, set linked_goal with kind id. When it belongs to a goal first created in the same output, set linked_goal with kind title and the exact new goal title.

Declare every named person who owns a commitment in entities. Use "self" for the user rather than declaring them.

Extract nothing rather than noise. Do not fill missing owners, dates, or motives. Mark an item inferred when interpretation is required, ambiguous when a material detail is unclear, sensitive for health, finance, legal, intimate identity, credentials, or private secrets, and assistant_only when the user never stated or endorsed it.

Facets are contextual whole-person understanding: values, decision criteria, constraints, preferences, motivations, routines, communication or working styles, boundaries, capacity patterns, skills, and relationship dynamics. Do not diagnose the user or assign personality labels. A direct clear non-sensitive facet may be accepted; every inferred pattern remains a proposal. A recurring pattern needs exact evidence from at least two distinct user messages. Emit at most one inferred facet. Set machine_effect only when the user explicitly asks Zeus to boost, deprioritize, or block recommendations in that scope.
If a proposed facet appears to contradict accepted understanding supplied below, mark it ambiguous rather than resolving the conflict yourself.

Classify every USER EVIDENCE source in source_assessments. Copy each sensitive excerpt exactly. When uncertain, mark the source uncertain; never call it normal merely because no memory item was extracted.

Write facts as subject, snake_case predicate, and a short object phrase. Use "${SELF_REF}" for the user. Link object_entity when the object is an entity. Set supersedes_previous only when the user clearly states a correction or life change. effective_from is only a date the user actually supplied.

For an explicit retraction of one current multi-valued fact (for example, “I no longer like espresso”), emit that same subject, predicate, and object with operation=retract. Never use retract for a single-valued predicate or for vague absence. Reuse a current fact below exactly; deterministic policy will refuse an unknown or ambiguous target.

Confidence: 0.9+ for a direct user statement about themselves, 0.7-0.85 for a clear statement about someone else, and below 0.6 for inference.`;

export const EXTRACTION_PROMPT_VERSION = "understanding-v1";
export const EXTRACTION_INPUT_TOKEN_BUDGET = 6_000;
const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
const EXTRACTION_INPUT_CHARACTER_BUDGET =
  EXTRACTION_INPUT_TOKEN_BUDGET * APPROXIMATE_CHARACTERS_PER_TOKEN;

export type ExtractionContext = {
  knownPredicates: readonly string[];
  knownEntities: readonly string[];
  activeGoals: readonly {
    id: number;
    title: string;
    status: string;
    priority: string;
    target_at: string | null;
  }[];
  openCommitments: readonly {
    id: number;
    title: string;
    status: string;
    owner: string;
    due_at: string | null;
  }[];
  currentFacts: readonly {
    id: number;
    subject: string;
    predicate: string;
    object: string;
  }[];
  acceptedFacets: readonly {
    id: number;
    kind: string;
    statement: string;
    scope: string;
  }[];
  acceptedPassages: readonly {
    id: number;
    message_id: number;
    text: string;
    learned_at: string;
  }[];
};

export function extractionContext(
  db: Db,
  entityLimit = 100,
  query = "",
): ExtractionContext {
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
    priority: goal.priority,
    target_at: goal.target_at,
  }));
  const openCommitments = listCommitments(db, { limit: 50 }).map((commitment) => ({
    id: commitment.id,
    title: commitment.title,
    status: commitment.status,
    owner: commitment.owner_name,
    due_at: commitment.due_at,
  }));
  const acceptedFacets = listFacets(db, { limit: 50 })
    .map((facet) => ({
      id: facet.id,
      kind: facet.kind,
      statement: facet.statement,
      scope: facet.scope_kind === "domain" ? `domain:${facet.scope_label}` : facet.scope_kind,
      relevance: extractionRelevance(query, `${facet.kind} ${facet.statement} ${facet.scope_label ?? ""}`),
    }))
    .filter((facet) => !query.trim() || facet.relevance > 0 || facet.scope === "global")
    .sort((left, right) => right.relevance - left.relevance || right.id - left.id)
    .slice(0, 16)
    .map(({ relevance: _relevance, ...facet }) => facet);
  const acceptedPassages = relevantAcceptedPassages(db, query, 8);
  const currentFacts = db
    .prepare<
      [number],
      { id: number; subject: string; predicate: string; object: string }
    >(
      `SELECT f.id, e.name AS subject, f.predicate, f.object
       FROM fact f
       JOIN entity e ON e.id = f.subject_id
       WHERE f.valid_to IS NULL
       ORDER BY f.last_seen_at DESC, f.id DESC
       LIMIT ?`,
    )
    .all(100)
    .map((fact) => ({
      ...fact,
      relevance: extractionRelevance(
        query,
        `${fact.subject} ${fact.predicate} ${fact.object}`,
      ),
    }))
    .filter((fact) => !query.trim() || fact.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || right.id - left.id)
    .slice(0, 24)
    .map(({ relevance: _relevance, ...fact }) => fact);

  return {
    knownPredicates,
    knownEntities,
    activeGoals,
    openCommitments,
    currentFacts,
    acceptedFacets,
    acceptedPassages,
  };
}

function renderTranscript(messages: readonly Pick<Message, "id" | "role" | "content">[]): string {
  return messages
    .map((message) =>
      `${message.role === "user" ? "USER EVIDENCE" : "ASSISTANT CONTEXT ONLY"} message:${message.id}: ${message.content}`,
    )
    .join("\n\n");
}

export type ExtractOptions = {
  messages: readonly Pick<Message, "id" | "role" | "content">[];
  context: ExtractionContext;
};

type PreparedExtractionInput = {
  input: string;
  messages: Pick<Message, "id" | "role" | "content">[];
};

function prepareExtractionInput(options: ExtractOptions): PreparedExtractionInput {
  const knownBudget = Math.floor(EXTRACTION_INPUT_CHARACTER_BUDGET * 0.34);
  const known = renderBoundedKnownContext(options.context, knownBudget);
  const wrapper = `${known}\n\nConversation to extract from:\n\n`;
  const transcriptBudget = Math.max(
    1,
    EXTRACTION_INPUT_CHARACTER_BUDGET - wrapper.length,
  );
  const messages = boundExtractionMessages(options.messages, transcriptBudget);
  const transcript = renderTranscript(messages);
  return {
    input: `${wrapper}${transcript}`.slice(0, EXTRACTION_INPUT_CHARACTER_BUDGET),
    messages,
  };
}

export function buildExtractionInput(options: ExtractOptions): string {
  return prepareExtractionInput(options).input;
}

/**
 * The deterministic allowlist for model-supplied evidence IDs. This is derived from
 * the same bounded transcript as buildExtractionInput(), so an item cannot cite a
 * stored message that the extraction model was never shown.
 */
export function extractionSourceMessageIds(options: ExtractOptions): number[] {
  return prepareExtractionInput(options).messages
    .filter((message) => message.role === "user")
    .map((message) => message.id);
}

function renderBoundedKnownContext(
  context: ExtractionContext,
  characterBudget: number,
): string {
  const lines = [`Current date: ${new Date().toISOString()}`];
  const appendList = (label: string, values: readonly unknown[]): void => {
    if (values.length === 0) return;
    const remaining = characterBudget - lines.join("\n").length - 1;
    if (remaining <= label.length + 4) return;
    const kept: unknown[] = [];
    for (const value of values) {
      const next = JSON.stringify([...kept, value]);
      if (`${label}: ${next}`.length > remaining) break;
      kept.push(value);
    }
    if (kept.length > 0) lines.push(`${label}: ${JSON.stringify(kept)}`);
  };

  appendList("Existing predicates", context.knownPredicates);
  appendList("Entities already known", context.knownEntities);
  appendList("Active goals (use IDs for updates)", context.activeGoals);
  appendList("Open commitments (use IDs for updates)", context.openCommitments);
  appendList("Current facts (reuse exact values for retractions)", context.currentFacts);
  appendList("Accepted understanding (do not duplicate)", context.acceptedFacets);
  appendList(
    "Relevant accepted evidence passages (context only)",
    context.acceptedPassages,
  );
  return lines.join("\n").slice(0, characterBudget);
}

function boundExtractionMessages(
  messages: readonly Pick<Message, "id" | "role" | "content">[],
  characterBudget: number,
): Pick<Message, "id" | "role" | "content">[] {
  const window = messages.slice(-13);
  const selected: Pick<Message, "id" | "role" | "content">[] = [];
  let remaining = characterBudget;
  for (const message of [...window].reverse()) {
    const label = `${
      message.role === "user" ? "USER EVIDENCE" : "ASSISTANT CONTEXT ONLY"
    } message:${message.id}: `;
    const separator = selected.length === 0 ? 0 : 2;
    const available = remaining - label.length - separator;
    if (available <= 0) continue;
    const content = truncateSourceContent(message.content, available);
    if (!content) continue;
    selected.unshift({ ...message, content });
    remaining -= label.length + content.length + separator;
  }
  return selected;
}

function truncateSourceContent(content: string, limit: number): string {
  if (content.length <= limit) return content;
  if (limit < 24) return content.slice(0, limit);
  const marker = "\n…\n";
  const usable = limit - marker.length;
  const startLength = Math.ceil(usable / 2);
  const endLength = Math.floor(usable / 2);
  return `${content.slice(0, startLength)}${marker}${content.slice(-endLength)}`;
}

function relevantAcceptedPassages(
  db: Db,
  query: string,
  limit: number,
): ExtractionContext["acceptedPassages"] {
  const match = toFtsQuery(query);
  if (!match) return [];
  try {
    return db
      .prepare<
        [string, number],
        { id: number; message_id: number; text: string; learned_at: string }
      >(
        `SELECT p.id, p.message_id, p.text, m.created_at AS learned_at
         FROM passage_fts
         JOIN evidence_passage p ON p.id = passage_fts.rowid
         JOIN message m ON m.id = p.message_id
         WHERE passage_fts MATCH ? AND p.recall_status = 'allowed'
           AND NOT EXISTS (
             SELECT 1
             FROM candidate_evidence ce
             JOIN memory_candidate mc ON mc.id = ce.candidate_id
             WHERE ce.passage_id = p.id AND mc.kind = 'facet'
               AND mc.status IN ('pending','rejected')
           )
         ORDER BY bm25(passage_fts), p.id DESC
         LIMIT ?`,
      )
      .all(match, limit)
      .map((passage) => ({
        ...passage,
        text: passage.text.slice(0, 800),
      }));
  } catch {
    return [];
  }
}

function extractionRelevance(query: string, value: string): number {
  const queryTerms = new Set(
    query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
  if (queryTerms.size === 0) return 0;
  let score = 0;
  for (const term of value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    if (queryTerms.has(term)) score += 1;
  }
  return score;
}

function emptyExtraction(): ParsedExtraction {
  return ExtractionSchema.parse({ entities: [], facts: [], goals: [], commitments: [] });
}

export async function extract(options: ExtractOptions): Promise<ParsedExtraction> {
  if (options.messages.length === 0) return emptyExtraction();
  const input = buildExtractionInput(options);

  const response = await openai().responses.parse({
    model: MODEL,
    max_output_tokens: 8000,
    reasoning: { effort: "low" },
    instructions: SYSTEM_PROMPT,
    text: { format: zodTextFormat(ExtractionSchema, "memory_extraction") },
    input: [
      {
        role: "user",
        content: input,
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
  facets: UnderstandingFacetView[];
  candidates: CandidateView[];
  supersededIds: number[];
  skipped: { subject: string; predicate: string; object: string; reason: string }[];
};

export type ExtractionRun = {
  id: number;
  model: string;
  prompt_version: string;
  focus_message_id: number | null;
  status: "started" | "completed" | "failed";
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
};

export function startExtractionRun(
  db: Db,
  focusMessageId: number | null,
): ExtractionRun {
  if (focusMessageId !== null) {
    const role = db
      .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
      .get(focusMessageId)?.role;
    if (role !== "user") throw new Error("Extraction focus must be a stored user message");
  }
  const startedAt = now();
  const inserted = db
    .prepare<[string, string, number | null, string]>(
      `INSERT INTO extraction_run
         (model, prompt_version, focus_message_id, status, started_at)
       VALUES (?, ?, ?, 'started', ?)`,
    )
    .run(MODEL, EXTRACTION_PROMPT_VERSION, focusMessageId, startedAt);
  const run = getExtractionRun(db, Number(inserted.lastInsertRowid));
  if (!run) throw new Error("Extraction run vanished immediately after insert");
  return run;
}

export function getExtractionRun(db: Db, id: number): ExtractionRun | null {
  return (
    db
      .prepare<[number], ExtractionRun>(
        `SELECT id, model, prompt_version, focus_message_id, status,
                error_code, started_at, completed_at
         FROM extraction_run WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function finishExtractionRun(
  db: Db,
  id: number,
  status: "completed" | "failed",
  errorCode: string | null = null,
): ExtractionRun | null {
  const normalizedCode = errorCode?.replace(/[^a-z0-9_.:-]+/giu, "_").slice(0, 120) ?? null;
  db.prepare<["completed" | "failed", string | null, string, number]>(
    `UPDATE extraction_run
     SET status = ?, error_code = ?, completed_at = ?
     WHERE id = ? AND status = 'started'`,
  ).run(status, normalizedCode, now(), id);
  return getExtractionRun(db, id);
}

export function emptyApplyResult(): ApplyResult {
  return {
    facts: [],
    goals: [],
    commitments: [],
    facets: [],
    candidates: [],
    supersededIds: [],
    skipped: [],
  };
}

export function applyExtraction(
  db: Db,
  extraction: Extraction,
  sourceMessageId: number | null = null,
  options: {
    forceAccept?: boolean;
    requireEvidence?: boolean;
    extractionRunId?: number | null;
    /** Exact user-message IDs present in the bounded model transcript. */
    allowedSourceMessageIds?: readonly number[];
  } = {},
): ApplyResult {
  const parsed = ExtractionSchema.parse(normalizeExtractionInput(extraction));
  const result = emptyApplyResult();
  const allowedSourceMessageIds = options.allowedSourceMessageIds === undefined
    ? null
    : new Set(options.allowedSourceMessageIds);

  if (sourceMessageId !== null) {
    const role = db
      .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
      .get(sourceMessageId)?.role;
    if (role !== "user") {
      throw new Error("Memory extraction source must be a stored user message");
    }
    if (allowedSourceMessageIds !== null && !allowedSourceMessageIds.has(sourceMessageId)) {
      throw new Error("Extraction focus was not present in the bounded model transcript");
    }
  }

  const evidencePolicy = evidenceApplicationPolicy(db, parsed, allowedSourceMessageIds);

  return db.transaction((): ApplyResult => {
    applySourceAssessments(
      db,
      parsed,
      sourceMessageId,
      options.extractionRunId ?? null,
      evidencePolicy,
    );

    for (const fact of parsed.facts) {
      applyFact(
        db,
        fact,
        parsed.entities,
        sourceMessageId,
        result,
        options.forceAccept ?? false,
        options.requireEvidence ?? false,
        options.extractionRunId ?? null,
        evidencePolicy,
      );
    }
    for (const goal of parsed.goals) {
      applyGoal(
        db,
        goal,
        sourceMessageId,
        result,
        options.forceAccept ?? false,
        options.requireEvidence ?? false,
        options.extractionRunId ?? null,
        evidencePolicy,
      );
    }
    for (const commitment of parsed.commitments) {
      applyCommitment(
        db,
        commitment,
        parsed.entities,
        sourceMessageId,
        result,
        options.forceAccept ?? false,
        options.requireEvidence ?? false,
        options.extractionRunId ?? null,
        evidencePolicy,
      );
    }
    let inferredFacetEmitted = false;
    for (const facet of parsed.facets) {
      if (facet.explicitness === "inferred" && inferredFacetEmitted) continue;
      const emitted = applyFacet(
        db,
        facet,
        parsed.entities,
        sourceMessageId,
        result,
        options.forceAccept ?? false,
        options.requireEvidence ?? false,
        options.extractionRunId ?? null,
        evidencePolicy,
      );
      if (facet.explicitness === "inferred" && emitted) inferredFacetEmitted = true;
    }

    return result;
  })();
}

type EvidenceApplicationPolicy = {
  allowedSourceMessageIds: ReadonlySet<number> | null;
  protectedSourceSensitivity: ReadonlyMap<
    number,
    Extract<EvidencePassage["sensitivity"], "sensitive" | "uncertain">
  >;
};

function evidenceApplicationPolicy(
  db: Db,
  extraction: ParsedExtraction,
  allowedSourceMessageIds: ReadonlySet<number> | null,
): EvidenceApplicationPolicy {
  const protectedSourceSensitivity = new Map<
    number,
    Extract<EvidencePassage["sensitivity"], "sensitive" | "uncertain">
  >();
  const protect = (
    sourceMessageId: number,
    sensitivity: Extract<EvidencePassage["sensitivity"], "sensitive" | "uncertain">,
  ): void => {
    if (
      allowedSourceMessageIds !== null &&
      !allowedSourceMessageIds.has(sourceMessageId)
    ) {
      return;
    }
    const current = protectedSourceSensitivity.get(sourceMessageId);
    if (current !== "sensitive") {
      protectedSourceSensitivity.set(sourceMessageId, sensitivity);
    }
  };

  for (const assessment of extraction.source_assessments) {
    if (
      (allowedSourceMessageIds !== null &&
        !allowedSourceMessageIds.has(assessment.source_message_id)) ||
      assessment.sensitivity === "normal"
    ) {
      continue;
    }
    protect(assessment.source_message_id, assessment.sensitivity);
  }

  // An item cannot downgrade another item that depends on the same protected
  // source. Precompute these sources so application order (facts before facets,
  // for example) cannot decide whether a proposal crosses the review boundary.
  const items = [
    ...extraction.facts,
    ...extraction.goals,
    ...extraction.commitments,
    ...extraction.facets,
  ];
  for (const item of items) {
    if (item.sensitivity !== "sensitive") continue;
    for (const evidence of item.evidence) {
      protect(evidence.source_message_id, "sensitive");
    }
  }

  const relevantSourceIds = allowedSourceMessageIds ?? new Set([
    ...extraction.source_assessments.map((assessment) => assessment.source_message_id),
    ...items.flatMap((item) =>
      item.evidence.map((evidence) => evidence.source_message_id),
    ),
  ]);
  for (const sourceMessageId of relevantSourceIds) {
    for (const passage of passagesForMessage(db, sourceMessageId)) {
      if (passage.sensitivity !== "normal") {
        protect(sourceMessageId, passage.sensitivity);
      }
    }
  }
  return { allowedSourceMessageIds, protectedSourceSensitivity };
}

function applyFact(
  db: Db,
  fact: ParsedExtraction["facts"][number],
  declarations: readonly ExtractedEntity[],
  sourceMessageId: number | null,
  result: ApplyResult,
  forceAccept: boolean,
  requireEvidence: boolean,
  extractionRunId: number | null,
  evidencePolicy: EvidenceApplicationPolicy,
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

  const passages = materializeEvidence(
    db,
    fact.evidence,
    sourceMessageId,
    fact.sensitivity,
    requireEvidence,
    extractionRunId,
    evidencePolicy,
  );
  const itemSourceId = passages[0]?.message_id ?? sourceMessageId;
  if (requireEvidence && (itemSourceId === null || passages.length === 0)) {
    skip(result, fact.subject, predicate, object, "missing exact user evidence");
    return;
  }

  const preliminaryReasons = forceAccept || itemSourceId === null
    ? []
    : trustReasonsForEvidence(
        withSourceSensitivity(db, itemSourceId, fact),
        false,
        passages,
      );
  const preliminaryReason = preliminaryReasons[0] ?? null;
  if (preliminaryReason && itemSourceId !== null) {
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: predicate === "cares_about" ? "interest" : "fact",
        payload: candidateEnvelope(fact, declarations),
        reason: preliminaryReason,
        reasons: preliminaryReasons,
        confidence: fact.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return;
  }

  const me = selfEntity(db);
  const subject = isSelf(fact.subject)
    ? me
    : resolveOrCreateEntity(db, fact.subject, declarations, itemSourceId);
  if (!subject) {
    if (itemSourceId === null) {
      skip(
        result,
        fact.subject,
        predicate,
        object,
        "subject entity was not declared in the extraction",
      );
      return;
    }
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: predicate === "cares_about" ? "interest" : "fact",
        payload: candidateEnvelope(fact, declarations),
        reason: "ambiguous",
        confidence: fact.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return;
  }

  const existingObjectEntity =
    fact.object_entity && isSelf(fact.object_entity)
      ? me
      : fact.object_entity
        ? resolveEntity(db, fact.object_entity)
        : null;

  const registered = getPredicate(db, predicate);
  if (fact.operation === "retract") {
    const matches = liveFacts(db, subject.id, predicate).filter(
      (current) =>
        (current.object_entity_id !== null &&
          existingObjectEntity !== null &&
          current.object_entity_id === existingObjectEntity.id) ||
        fold(current.object) === fold(object),
    );
    const retractionReasons = forceAccept
      ? []
      : trustReasonsForEvidence(
          withSourceSensitivity(db, itemSourceId, fact),
          false,
          passages,
        );
    if (
      (registered?.cardinality !== "multi" || matches.length !== 1) &&
      !retractionReasons.includes("ambiguous")
    ) {
      retractionReasons.push("ambiguous");
    }
    const retractionReason = retractionReasons[0] ?? null;
    if (retractionReason && itemSourceId !== null) {
      appendPendingCandidate(
        result,
        createCandidate(db, {
          kind: predicate === "cares_about" ? "interest" : "fact",
          payload: candidateEnvelope(fact, declarations),
          reason: retractionReason,
          reasons: retractionReasons,
          confidence: fact.confidence,
          sourceMessageId: itemSourceId,
          passageIds: passages.map((passage) => passage.id),
        }),
      );
      return;
    }
    if (itemSourceId === null || registered?.cardinality !== "multi" || matches.length !== 1) {
      skip(result, fact.subject, predicate, object, "retraction did not resolve to one live multi-valued fact");
      return;
    }
    const primaryPassage = passages.find(
      (passage) => passage.message_id === itemSourceId,
    );
    const retracted = retractFact(db, matches[0]!.id, {
      sourceMessageId: itemSourceId,
      validTo: fact.effective_from,
      confidence: fact.confidence,
      passageId: primaryPassage?.id ?? null,
    });
    if (retracted) {
      result.facts.push(retracted);
      result.supersededIds.push(retracted.id);
    }
    return;
  }
  const conflicting =
    registered?.cardinality === "single" &&
    liveFacts(db, subject.id, predicate).some(
      (current) =>
        !(
          current.object_entity_id !== null &&
          existingObjectEntity !== null &&
          current.object_entity_id === existingObjectEntity.id
        ) && fold(current.object) !== fold(object),
    );
  const hasExplicitChange =
    fact.supersedes_previous && sourceHasExplicitChange(db, itemSourceId);
  const reasons = forceAccept
    ? []
    : trustReasonsForEvidence(
        withSourceSensitivity(db, itemSourceId, fact),
        conflicting && !hasExplicitChange,
        passages,
      );
  const reason = reasons[0] ?? null;
  if (reason) {
    if (itemSourceId === null) {
      skip(result, fact.subject, predicate, object, `requires review: ${reason}`);
      return;
    }
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: predicate === "cares_about" ? "interest" : "fact",
        payload: candidateEnvelope(fact, declarations),
        reason,
        reasons,
        confidence: fact.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return;
  }

  const objectEntity =
    fact.object_entity && isSelf(fact.object_entity)
      ? me
      : fact.object_entity
        ? resolveOrCreateEntity(db, fact.object_entity, declarations, itemSourceId)
        : null;
  if (fact.object_entity && !objectEntity) {
    if (itemSourceId === null) {
      skip(
        result,
        fact.subject,
        predicate,
        object,
        "object entity was not declared in the extraction",
      );
      return;
    }
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: predicate === "cares_about" ? "interest" : "fact",
        payload: candidateEnvelope(fact, declarations),
        reason: "ambiguous",
        confidence: fact.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
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
    sourceMessageId: itemSourceId,
    validFrom: fact.effective_from,
    evidenceKind: hasExplicitChange || (forceAccept && conflicting) ? "correction" : "assertion",
    passageId:
      passages.find((passage) => passage.message_id === itemSourceId)?.id ?? null,
  });
  const extraSourceIds = [
    ...new Set(
      passages
        .map((passage) => passage.message_id)
        .filter((id) => id !== itemSourceId),
    ),
  ];
  for (const extraSourceId of extraSourceIds) {
    const evidencePassage = passages.find(
      (passage) => passage.message_id === extraSourceId,
    );
    addFactEvidence(
      db,
      written.fact.id,
      extraSourceId,
      hasExplicitChange ? "correction" : "assertion",
      fact.confidence,
      evidencePassage?.id ?? null,
    );
  }
  result.facts.push(
    extraSourceIds.length > 0
      ? (recomputeFactEvidenceAggregates(db, written.fact.id) ?? written.fact)
      : written.fact,
  );
  result.supersededIds.push(...written.supersededIds);
}

function applyGoal(
  db: Db,
  goal: ParsedExtraction["goals"][number],
  sourceMessageId: number | null,
  result: ApplyResult,
  forceAccept: boolean,
  requireEvidence: boolean,
  extractionRunId: number | null,
  evidencePolicy: EvidenceApplicationPolicy,
): void {
  if (!goal.title.trim() || goal.grounding === "assistant_only") return;
  const passages = materializeEvidence(
    db,
    goal.evidence,
    sourceMessageId,
    goal.sensitivity,
    requireEvidence,
    extractionRunId,
    evidencePolicy,
  );
  const itemSourceId = passages[0]?.message_id ?? sourceMessageId;
  if (itemSourceId === null || (requireEvidence && passages.length === 0)) return;
  const existing = goal.existing_id === null ? null : getGoal(db, goal.existing_id);
  const invalidReference = goal.existing_id !== null && existing === null;
  const terminalWithoutExisting =
    goal.existing_id === null && (goal.status === "achieved" || goal.status === "abandoned");
  const reasons = forceAccept
    ? []
    : trustReasonsForEvidence(
        withSourceSensitivity(db, itemSourceId, goal),
        false,
        passages,
      );
  if (
    !forceAccept &&
    (invalidReference || terminalWithoutExisting) &&
    !reasons.includes("ambiguous")
  ) {
    reasons.push("ambiguous");
  }
  const reason = reasons[0] ?? null;
  if (reason) {
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: "goal",
        payload: candidateEnvelope(goal, []),
        reason,
        reasons,
        confidence: goal.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return;
  }
  const priority =
    goal.priority.op === "set"
      ? goal.priority.value
      : goal.priority.op === "clear"
        ? existing
          ? "normal"
          : undefined
        : undefined;
  const targetAt = patchToNullableUpdate(goal.target_at);
  const applied = existing
    ? updateGoal(db, existing.id, {
        title: goal.title,
        status: goal.status,
        priority,
        targetAt,
        confidence: goal.confidence,
        sourceMessageId: itemSourceId,
        sourceKind: "message",
        passageId:
          passages.find((passage) => passage.message_id === itemSourceId)?.id ?? null,
      })
    : createGoal(db, {
        title: goal.title,
        status: goal.status,
        priority,
        targetAt,
        confidence: goal.confidence,
        sourceMessageId: itemSourceId,
        passageId:
          passages.find((passage) => passage.message_id === itemSourceId)?.id ?? null,
      });
  if (applied) result.goals.push(applied);
}

function applyCommitment(
  db: Db,
  commitment: ParsedExtraction["commitments"][number],
  declarations: readonly ExtractedEntity[],
  sourceMessageId: number | null,
  result: ApplyResult,
  forceAccept: boolean,
  requireEvidence: boolean,
  extractionRunId: number | null,
  evidencePolicy: EvidenceApplicationPolicy,
): void {
  if (!commitment.title.trim() || commitment.grounding === "assistant_only") return;
  const passages = materializeEvidence(
    db,
    commitment.evidence,
    sourceMessageId,
    commitment.sensitivity,
    requireEvidence,
    extractionRunId,
    evidencePolicy,
  );
  const itemSourceId = passages[0]?.message_id ?? sourceMessageId;
  if (itemSourceId === null || (requireEvidence && passages.length === 0)) return;
  const preliminaryReasons = forceAccept
    ? []
    : trustReasonsForEvidence(
        withSourceSensitivity(db, itemSourceId, commitment),
        false,
        passages,
      );
  const preliminaryReason = preliminaryReasons[0] ?? null;
  if (preliminaryReason) {
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: "commitment",
        payload: candidateEnvelope(commitment, declarations),
        reason: preliminaryReason,
        reasons: preliminaryReasons,
        confidence: commitment.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return;
  }
  const existing =
    commitment.existing_id === null ? null : getCommitment(db, commitment.existing_id);
  const requestedOwner =
    commitment.owner.op === "set"
      ? commitment.owner.value
      : commitment.owner.op === "clear" || existing === null
        ? SELF_REF
        : null;
  const linkedGoalPatch = commitment.linked_goal;
  const linkedGoal =
    linkedGoalPatch.op !== "set"
      ? null
      : resolveLinkedGoal(db, linkedGoalPatch.value);
  const linkedGoalId =
    linkedGoalPatch.op === "keep"
      ? existing
        ? undefined
        : null
      : linkedGoalPatch.op === "clear"
        ? null
        : linkedGoal?.id;
  const invalidWithoutOwner =
    (commitment.existing_id !== null && existing === null) ||
    (linkedGoalPatch.op === "set" && linkedGoal === null) ||
    (commitment.existing_id === null &&
      (commitment.status === "done" || commitment.status === "cancelled"));
  if (invalidWithoutOwner && !forceAccept) {
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: "commitment",
        payload: candidateEnvelope(commitment, declarations),
        reason: "ambiguous",
        confidence: commitment.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return;
  }

  const owner =
    requestedOwner === null
      ? null
      : isSelf(requestedOwner)
        ? selfEntity(db)
        : resolveOrCreateEntity(db, requestedOwner, declarations, itemSourceId);
  const ownerEntityId = requestedOwner === null ? undefined : owner?.id;
  if (requestedOwner !== null && owner === null && !forceAccept) {
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: "commitment",
        payload: candidateEnvelope(commitment, declarations),
        reason: "ambiguous",
        confidence: commitment.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return;
  }
  if (requestedOwner !== null && !owner) {
    throw new Error(`Cannot accept commitment with unknown owner "${requestedOwner}"`);
  }
  if (linkedGoalPatch.op === "set" && !linkedGoal) {
    throw new Error("Cannot accept commitment with an unknown linked goal");
  }

  const dueAt = patchToNullableUpdate(commitment.due_at);
  const applied = existing
    ? updateCommitment(db, existing.id, {
        title: commitment.title,
        ownerEntityId,
        linkedGoalId,
        status: commitment.status,
        dueAt,
        confidence: commitment.confidence,
        sourceMessageId: itemSourceId,
        sourceKind: "message",
        passageId:
          passages.find((passage) => passage.message_id === itemSourceId)?.id ?? null,
      })
    : createCommitment(db, {
        title: commitment.title,
        ownerEntityId: ownerEntityId ?? selfEntity(db).id,
        linkedGoalId,
        status: commitment.status,
        dueAt,
        confidence: commitment.confidence,
        sourceMessageId: itemSourceId,
        passageId:
          passages.find((passage) => passage.message_id === itemSourceId)?.id ?? null,
      });
  if (applied) result.commitments.push(applied);
}

function applyFacet(
  db: Db,
  facet: ParsedExtraction["facets"][number],
  declarations: readonly ExtractedEntity[],
  sourceMessageId: number | null,
  result: ApplyResult,
  forceAccept: boolean,
  requireEvidence: boolean,
  extractionRunId: number | null,
  evidencePolicy: EvidenceApplicationPolicy,
): boolean {
  const statement = facet.statement.replace(/\s+/gu, " ").trim();
  if (!statement || facet.grounding === "assistant_only") return false;
  const passages = materializeEvidence(
    db,
    facet.evidence,
    sourceMessageId,
    facet.sensitivity,
    requireEvidence,
    extractionRunId,
    evidencePolicy,
  );
  const itemSourceId = passages[0]?.message_id ?? sourceMessageId;
  if (itemSourceId === null || (requireEvidence && passages.length === 0)) return false;

  const distinctSources = new Set(passages.map((passage) => passage.message_id)).size;
  const repeatedPatternMissingSupport = facet.explicitness === "inferred" && distinctSources < 2;
  const machineEffectNeedsConfirmation = facet.machine_effect !== null;
  const related = relatedAcceptedFacets(db, facet);
  const hasConflict = related.some((accepted) => facetsConflict(accepted, facet));
  const reasons = forceAccept
    ? []
    : trustReasonsForEvidence(
        withSourceSensitivity(db, itemSourceId, facet),
        false,
        passages,
      );
  if (!forceAccept && repeatedPatternMissingSupport && !reasons.includes("inference")) {
    reasons.push("inference");
  }
  if (!forceAccept && machineEffectNeedsConfirmation && !reasons.includes("ambiguous")) {
    reasons.push("ambiguous");
  }
  if (!forceAccept && hasConflict && !reasons.includes("conflict")) {
    reasons.push("conflict");
  }
  const reason = reasons[0] ?? null;
  if (reason) {
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: "facet",
        payload: facetCandidateEnvelope(facet, declarations, related),
        reason,
        reasons,
        confidence: facet.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return true;
  }

  const scope = resolveFacetScope(db, facet.scope, declarations, itemSourceId);
  if (!scope) {
    if (forceAccept) throw new Error("Cannot accept facet with an unresolved scope");
    appendPendingCandidate(
      result,
      createCandidate(db, {
        kind: "facet",
        payload: facetCandidateEnvelope(facet, declarations, related),
        reason: "ambiguous",
        confidence: facet.confidence,
        sourceMessageId: itemSourceId,
        passageIds: passages.map((passage) => passage.id),
      }),
    );
    return true;
  }

  result.facets.push(
    recordFacet(db, {
      kind: facet.kind,
      statement,
      scope,
      condition: facet.condition,
      importance: facet.importance,
      sensitivity:
        facet.sensitivity === "sensitive" || hasProtectedEvidence(passages)
          ? "sensitive"
          : "normal",
      confidence: facet.confidence,
      machineEffect: facet.machine_effect,
      validFrom: facet.effective_from,
      sourceMessageId: itemSourceId,
      passageIds: passages.map((passage) => passage.id),
      evidenceKind: facet.explicitness === "inferred" ? "pattern_support" : "assertion",
      sourceKind: "message",
    }),
  );
  return true;
}

type TrustSignal = {
  explicitness: "explicit" | "inferred";
  sensitivity: "normal" | "sensitive";
  ambiguity: "clear" | "ambiguous";
  confidence: number;
};

function trustReasons(signal: TrustSignal, conflict: boolean): CandidateReason[] {
  const reasons: CandidateReason[] = [];
  if (signal.sensitivity === "sensitive") reasons.push("sensitive");
  if (signal.ambiguity === "ambiguous") reasons.push("ambiguous");
  if (conflict) reasons.push("conflict");
  if (signal.explicitness === "inferred" || signal.confidence < 0.6) {
    reasons.push("inference");
  }
  return reasons;
}

function trustReasonsForEvidence(
  signal: TrustSignal,
  conflict: boolean,
  passages: readonly EvidencePassage[],
): CandidateReason[] {
  const reasons = trustReasons(signal, conflict);
  if (hasProtectedEvidence(passages) && !reasons.includes("sensitive")) {
    // Protected evidence is the strongest gate. The model may under-label an item,
    // but it cannot downgrade a source or exact passage that privacy classification
    // has already marked sensitive or uncertain.
    reasons.unshift("sensitive");
  }
  return reasons;
}

function hasProtectedEvidence(passages: readonly EvidencePassage[]): boolean {
  return passages.some((passage) => passage.sensitivity !== "normal");
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

function applySourceAssessments(
  db: Db,
  extraction: ParsedExtraction,
  fallbackSourceMessageId: number | null,
  extractionRunId: number | null,
  evidencePolicy: EvidenceApplicationPolicy,
): void {
  const assessed = new Set<number>();
  for (const assessment of extraction.source_assessments) {
    if (
      evidencePolicy.allowedSourceMessageIds !== null &&
      !evidencePolicy.allowedSourceMessageIds.has(assessment.source_message_id)
    ) {
      continue;
    }
    const message = db
      .prepare<[number], { role: string; content: string }>(
        "SELECT role, content FROM message WHERE id = ?",
      )
      .get(assessment.source_message_id);
    if (!message || message.role !== "user") continue;
    assessed.add(assessment.source_message_id);
    if (
      assessment.sensitivity === "normal" &&
      !sourceLooksSensitive(message.content) &&
      !evidencePolicy.protectedSourceSensitivity.has(assessment.source_message_id)
    ) {
      allowWholeMessagePassage(db, assessment.source_message_id, extractionRunId);
      continue;
    }
    blockMessageRecall(db, assessment.source_message_id);
    for (const quote of assessment.sensitive_quotes) {
      try {
        ensureEvidencePassage(db, {
          messageId: assessment.source_message_id,
          quote,
          sensitivity:
            assessment.sensitivity === "normal" ? "uncertain" : assessment.sensitivity,
          recallStatus: "pending",
          extractionRunId,
        });
      } catch {
        // Invalid model spans never make a source recallable.
      }
    }
  }

  if (fallbackSourceMessageId !== null && !assessed.has(fallbackSourceMessageId)) {
    const message = db
      .prepare<[number], { role: string; content: string }>(
        "SELECT role, content FROM message WHERE id = ?",
      )
      .get(fallbackSourceMessageId);
    // Missing classification is a failure of episodic recall only. Canonical memory
    // can still be written from validated claim evidence, but no raw passage is exposed.
    if (message?.role === "user") blockMessageRecall(db, fallbackSourceMessageId);
  }
}

function materializeEvidence(
  db: Db,
  evidence: readonly ExtractionEvidence[],
  fallbackSourceMessageId: number | null,
  sensitivity: "normal" | "sensitive",
  requireEvidence: boolean,
  extractionRunId: number | null,
  evidencePolicy: EvidenceApplicationPolicy,
): EvidencePassage[] {
  const refs = evidence.length
    ? evidence
    : fallbackSourceMessageId !== null && !requireEvidence
      ? [{
          source_message_id: fallbackSourceMessageId,
          quote:
            db
              .prepare<[number], { content: string }>("SELECT content FROM message WHERE id = ?")
              .get(fallbackSourceMessageId)?.content ?? "",
        }]
      : [];
  const passages: EvidencePassage[] = [];
  for (const ref of refs) {
    if (!ref.quote.trim()) continue;
    if (
      evidencePolicy.allowedSourceMessageIds !== null &&
      !evidencePolicy.allowedSourceMessageIds.has(ref.source_message_id)
    ) {
      continue;
    }
    const source = db
      .prepare<[number], { role: string; content: string; recall_state: string }>(
        "SELECT role, content, recall_state FROM message WHERE id = ?",
      )
      .get(ref.source_message_id);
    if (!source || source.role !== "user") continue;
    const sourceSensitive = sourceLooksSensitive(source.content);
    const assessedSensitivity = evidencePolicy.protectedSourceSensitivity.get(
      ref.source_message_id,
    );
    const passageSensitivity =
      sensitivity === "sensitive" || sourceSensitive
        ? "sensitive"
        : assessedSensitivity ?? "normal";
    try {
      passages.push(
        ensureEvidencePassage(db, {
          messageId: ref.source_message_id,
          quote: ref.quote,
          sensitivity: passageSensitivity,
          recallStatus:
            passageSensitivity !== "normal"
              ? "pending"
              : source.recall_state === "blocked"
                ? "pending"
                : "allowed",
          extractionRunId,
        }),
      );
    } catch {
      // A paraphrase, assistant quote, or unknown message is not evidence.
    }
  }
  return [...new Map(passages.map((passage) => [passage.id, passage])).values()];
}

function resolveOrCreateEntity(
  db: Db,
  name: string,
  declarations: readonly ExtractedEntity[],
  sourceMessageId: number | null,
) {
  const candidates = resolveEntityCandidates(db, name);
  if (candidates.length > 1) return null;
  const declarationMatches = declarations.filter(
    (declaration) =>
      fold(declaration.name) === fold(name) ||
      declaration.aliases.some((alias) => fold(alias) === fold(name)),
  );
  if (declarationMatches.length > 1) return null;
  const existing = candidates[0] ?? null;
  const declaration = declarationMatches[0];
  if (!existing && !declaration) return null;
  try {
    const input = {
      name: declaration?.name ?? existing!.name,
      kind: declaration?.kind ?? existing!.kind,
      aliases: declaration
        ? declaration.aliases.filter((alias) => alias.trim())
        : fold(existing!.name) === fold(name)
          ? []
          : [name],
    };
    if (sourceMessageId === null) return upsertEntity(db, input);
    return upsertEntityWithEvidence(db, {
      ...input,
      sourceMessageId,
      evidenceKind: "mention",
    });
  } catch (error) {
    if (error instanceof AmbiguousEntityError) return null;
    throw error;
  }
}

function resolveFacetScope(
  db: Db,
  scope: ExtractedFacetScope,
  declarations: readonly ExtractedEntity[],
  sourceMessageId: number,
): FacetScopeInput | null {
  if (scope.kind === "global") return { kind: "global" };
  if (scope.kind === "domain") {
    return scope.label.trim() ? { kind: "domain", label: scope.label } : null;
  }
  if (scope.kind === "entity") {
    const entity = resolveOrCreateEntity(db, scope.name, declarations, sourceMessageId);
    return entity ? { kind: "entity", entityId: entity.id } : null;
  }
  if (scope.kind === "goal") {
    return getGoal(db, scope.id) ? { kind: "goal", goalId: scope.id } : null;
  }
  return getCommitment(db, scope.id)
    ? { kind: "commitment", commitmentId: scope.id }
    : null;
}

type CandidateEnvelope<T> = { item: T; entities: readonly ExtractedEntity[] };

function candidateEnvelope<T>(item: T, entities: readonly ExtractedEntity[]): CandidateEnvelope<T> {
  return { item, entities };
}

function facetCandidateEnvelope(
  item: ParsedExtraction["facets"][number],
  entities: readonly ExtractedEntity[],
  related: readonly UnderstandingFacetView[],
): CandidateEnvelope<typeof item> & {
  conflict_preview: string[];
  supersedes_facet_ids: number[];
} {
  const previews = related.slice(0, 3).map(
    (facet) =>
      `Currently accepted: “${facet.statement}”. Acceptance keeps both visible until you explicitly correct or close one.`,
  );
  if (item.machine_effect !== null) {
    previews.push(
      `If confirmed, ${item.machine_effect} will deterministically affect follow-through ranking only within this facet's scope.`,
    );
  }
  return {
    item,
    entities,
    conflict_preview: previews,
    supersedes_facet_ids: [],
  };
}

function relatedAcceptedFacets(
  db: Db,
  facet: ParsedExtraction["facets"][number],
): UnderstandingFacetView[] {
  return listFacets(db, { kinds: [facet.kind], limit: 200 }).filter((accepted) => {
    if (accepted.scope_kind !== facet.scope.kind) return false;
    if (facet.scope.kind === "global") return true;
    if (facet.scope.kind === "domain") {
      return fold(accepted.scope_label ?? "") === fold(facet.scope.label);
    }
    if (facet.scope.kind === "goal") return accepted.scope_goal_id === facet.scope.id;
    if (facet.scope.kind === "commitment") {
      return accepted.scope_commitment_id === facet.scope.id;
    }
    return fold(accepted.scope_entity_name ?? "") === fold(facet.scope.name);
  });
}

function facetsConflict(
  accepted: UnderstandingFacetView,
  proposed: ParsedExtraction["facets"][number],
): boolean {
  const acceptedTerms = contentTerms(accepted.statement);
  const proposedTerms = contentTerms(proposed.statement);
  const overlap = [...acceptedTerms].filter((term) => proposedTerms.has(term)).length;
  const denominator = Math.max(1, Math.min(acceptedTerms.size, proposedTerms.size));
  const closelyRelated = overlap / denominator >= 0.6;
  const negation = /\b(?:avoid|cannot|don't|never|no|not|without|won't)\b/iu;
  const oppositePolarity = negation.test(accepted.statement) !== negation.test(proposed.statement);
  const incompatibleEffect =
    accepted.machine_effect !== null &&
    proposed.machine_effect !== null &&
    accepted.machine_effect !== proposed.machine_effect;
  return closelyRelated && (oppositePolarity || incompatibleEffect);
}

function contentTerms(value: string): Set<string> {
  const stop = new Set(["and", "for", "the", "this", "that", "with", "without"]);
  return new Set(
    (value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
      (term) => !stop.has(term),
    ),
  );
}

function unwrapCandidatePayload<T>(payload: unknown): CandidateEnvelope<T> {
  if (payload && typeof payload === "object" && "item" in payload) {
    const envelope = payload as { item: T; entities?: unknown };
    return {
      item: envelope.item,
      entities: Array.isArray(envelope.entities)
        ? (envelope.entities as ExtractedEntity[])
        : [],
    };
  }
  return { item: payload as T, entities: [] };
}

export type FacetCandidateEdit = {
  statement: string;
  machineEffect: "boost" | "deprioritize" | "block" | null;
};

/**
 * Accepting is an explicit user action, so it bypasses the gate but keeps the source.
 * Facet wording and deterministic effects may be edited at this boundary; the edit is
 * applied to the proposal, never to its immutable evidence or source identity.
 */
export function acceptCandidate(
  db: Db,
  id: number,
  options: { facetEdit?: FacetCandidateEdit } = {},
): ApplyResult | null {
  const candidate = getCandidate(db, id);
  if (!candidate || candidate.status !== "pending") return null;
  if (options.facetEdit && candidate.kind !== "facet") {
    throw new Error("Only understanding-facet candidates support editable acceptance");
  }

  let extraction: Extraction;
  let editedPayload: ExtractedFacet | undefined;
  if (candidate.kind === "fact" || candidate.kind === "interest") {
    const payload = unwrapCandidatePayload<ExtractedFact>(candidate.payload);
    extraction = {
      entities: [...payload.entities],
      facts: [withCandidateEvidence(payload.item, candidate.evidence)],
    };
  } else if (candidate.kind === "goal") {
    const payload = unwrapCandidatePayload<ExtractedGoal>(candidate.payload);
    extraction = {
      entities: [...payload.entities],
      facts: [],
      goals: [withCandidateEvidence(payload.item, candidate.evidence)],
    };
  } else if (candidate.kind === "commitment") {
    const payload = unwrapCandidatePayload<ExtractedCommitment>(candidate.payload);
    extraction = {
      entities: [...payload.entities],
      facts: [],
      commitments: [withCandidateEvidence(payload.item, candidate.evidence)],
    };
  } else {
    const payload = unwrapCandidatePayload<ExtractedFacet>(candidate.payload);
    const evidencedItem = withCandidateEvidence(payload.item, candidate.evidence);
    const statement = options.facetEdit?.statement.replace(/\s+/gu, " ").trim();
    if (options.facetEdit && !statement) {
      throw new Error("Accepted understanding cannot have an empty statement");
    }
    const acceptedPayload = options.facetEdit
      ? {
          ...evidencedItem,
          statement: statement!,
          machine_effect: options.facetEdit.machineEffect,
        }
      : evidencedItem;
    const originalStatement = evidencedItem.statement.replace(/\s+/gu, " ").trim();
    const wasEdited =
      options.facetEdit !== undefined &&
      (acceptedPayload.statement !== originalStatement ||
        acceptedPayload.machine_effect !== evidencedItem.machine_effect);
    editedPayload = wasEdited ? acceptedPayload : undefined;
    extraction = {
      entities: [...payload.entities],
      facts: [],
      facets: [acceptedPayload],
    };
  }

  return db.transaction(() => {
    const applied = applyExtraction(db, extraction, candidate.source_message_id, {
      forceAccept: true,
    });
    const materialized =
      applied.facts.length +
      applied.goals.length +
      applied.commitments.length +
      applied.facets.length;
    if (materialized === 0) {
      throw new Error(`Candidate ${id} could not be materialized`);
    }
    if (!resolveCandidate(db, id, "accepted")) {
      throw new Error(`Candidate ${id} changed while it was being accepted`);
    }
    for (const passage of candidate.evidence) allowPassage(db, passage.id);
    recordCandidateResolution(db, {
      candidateId: id,
      decision: editedPayload === undefined ? "accepted" : "edited_accepted",
      editedPayload,
      sourceKind: "user_action",
    });
    return applied;
  })();
}

function withCandidateEvidence<T extends { evidence?: readonly ExtractionEvidence[] }>(
  item: T,
  passages: readonly EvidencePassage[],
): T {
  if (passages.length === 0) return item;
  const evidence = [
    ...(item.evidence ?? []),
    ...passages.map((passage) => ({
      source_message_id: passage.message_id,
      quote: passage.text,
    })),
  ];
  const unique = [
    ...new Map(
      evidence.map((entry) => [
        `${entry.source_message_id}:${entry.quote}`,
        entry,
      ]),
    ).values(),
  ];
  return { ...item, evidence: unique };
}

function normalizePredicate(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
}

function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function appendPendingCandidate(
  result: ApplyResult,
  candidate: CandidateView,
): void {
  // createCandidate also returns durable accepted/rejected suppression records
  // when their semantic key reappears. They are audit history, not a new item
  // awaiting review, so they must not leak into chat receipts or apply results.
  if (
    candidate.status !== "pending" ||
    result.candidates.some((current) => current.id === candidate.id)
  ) {
    return;
  }
  result.candidates.push(candidate);
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

function patchToNullableUpdate<T>(patch: FieldPatch<T>): T | null | undefined {
  if (patch.op === "set") return patch.value;
  return patch.op === "clear" ? null : undefined;
}

function resolveLinkedGoal(db: Db, link: ExtractedGoalLink): Goal | null {
  if (link.kind === "id") return getGoal(db, link.id);
  return (
    listGoals(db, { includeClosed: true, limit: 500 }).find(
      (goal) => fold(goal.title) === fold(link.title),
    ) ?? null
  );
}

/**
 * Old seeds and pending candidates used nullable scalar fields. Normalize them
 * only at the application boundary; the model-facing schema remains patch-only.
 */
function normalizeExtractionInput(extraction: Extraction): unknown {
  return {
    ...extraction,
    goals: (extraction.goals ?? []).map((goal) => {
      const isNew = (goal.existing_id ?? null) === null;
      return {
        ...goal,
        existing_id: goal.existing_id ?? null,
        priority: normalizeLegacyPatch(goal.priority, {
          isNew,
          nullMeans: "keep",
        }),
        target_at: normalizeLegacyPatch(goal.target_at, {
          isNew,
          nullMeans: "clear",
        }),
      };
    }),
    commitments: (extraction.commitments ?? []).map((commitment) => {
      const isNew = (commitment.existing_id ?? null) === null;
      const {
        linked_goal_id: linkedGoalId,
        linked_goal_title: linkedGoalTitle,
        ...current
      } = commitment;
      const linkedGoal = isFieldPatch(current.linked_goal)
        ? current.linked_goal
        : linkedGoalId !== undefined || linkedGoalTitle !== undefined
          ? linkedGoalId !== null && linkedGoalId !== undefined
            ? { op: "set" as const, value: { kind: "id" as const, id: linkedGoalId } }
            : linkedGoalTitle
              ? {
                  op: "set" as const,
                  value: { kind: "title" as const, title: linkedGoalTitle },
                }
              : { op: "clear" as const }
          : isNew
            ? { op: "clear" as const }
            : { op: "keep" as const };
      return {
        ...current,
        existing_id: commitment.existing_id ?? null,
        owner: normalizeLegacyPatch(commitment.owner, {
          isNew,
          nullMeans: "clear",
        }),
        linked_goal: linkedGoal,
        due_at: normalizeLegacyPatch(commitment.due_at, {
          isNew,
          nullMeans: "clear",
        }),
      };
    }),
  };
}

function normalizeLegacyPatch<T>(
  value: FieldPatch<T> | T | null | undefined,
  options: { isNew: boolean; nullMeans: "keep" | "clear" },
): FieldPatch<T> {
  if (isFieldPatch(value)) return value;
  if (value !== null && value !== undefined) return { op: "set", value };
  if (value === null && options.nullMeans === "clear") return { op: "clear" };
  return { op: options.isNew ? "clear" : "keep" };
}

function isFieldPatch<T>(value: unknown): value is FieldPatch<T> {
  if (typeof value !== "object" || value === null || !("op" in value)) return false;
  const op = (value as { op?: unknown }).op;
  return op === "keep" || op === "set" || op === "clear";
}

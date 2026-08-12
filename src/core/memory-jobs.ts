import { randomUUID } from "node:crypto";

import {
  MemoryActivityItem as MemoryActivityItemSchema,
  type MemoryActivityItem,
  type MemoryJobView,
  type RememberingMode,
} from "./contracts";
import type { CandidateView } from "./candidates";
import { getMessage } from "./conversations";
import type { Db } from "./db";
import { now } from "./db";
import {
  embedFact,
  embedFacet,
  embedMessage,
  embedPassage,
  type MemoryJobEmbeddingGuard,
} from "./embed";
import {
  applyExtraction,
  extract,
  extractionContext,
  finishExtractionRun,
  startExtractionRun,
  type ApplyResult,
} from "./extract";
import { facetSearchText } from "./facets";
import { factSearchText, forgetFact } from "./facts";
import {
  blockMessageRecall,
  deletePassagesForMessage,
  passagesForMessage,
} from "./passages";
import { resourceId } from "./resource-id";
import type {
  Extraction,
  EvidencePassage,
  FactView,
  Message,
  ParsedExtraction,
} from "./schema";

const JOB_RESULT_VERSION = 1;
const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1_000;
const DEFAULT_DRAIN_LIMIT = 32;

type MemoryJobRow = {
  id: string;
  conversation_id: number;
  source_message_id: number;
  assistant_message_id: number;
  prompt_version: string;
  remembering_mode: RememberingMode;
  status: "pending" | "running" | "completed" | "failed";
  activity_json: string;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  undone_at: string | null;
};

type Claim = MemoryJobRow & { started_at: string };

type FactRowSnapshot = {
  id: number;
  subject_id: number;
  predicate: string;
  object: string;
  object_entity_id: number | null;
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  superseded_by: number | null;
  source_message_id: number | null;
  assertion_count: number;
  last_seen_at: string;
  created_at: string;
};

type FactEvidenceSnapshot = {
  id: number;
  fact_id: number;
  source_message_id: number;
  passage_id: number | null;
  kind: string;
  confidence: number;
  created_at: string;
};

type UndoPlan = {
  kind: "inserted_facts";
  sourceMessageId: number;
  passages: EvidencePassage[];
  facts: Array<{
    row: FactRowSnapshot;
    evidence: FactEvidenceSnapshot[];
  }>;
};

type StoredJobResult = {
  version: typeof JOB_RESULT_VERSION;
  extractionRunId?: number;
  extraction?: ParsedExtraction;
  applied?: ApplyResult;
  activity?: MemoryActivityItem[];
  undo?: UndoPlan | null;
};

type BeforeApply = {
  fact: number;
  goal: number;
  commitment: number;
  project: number;
  facet: number;
  candidate: number;
  predicates: Set<string>;
};

export type MemoryJobDependencies = {
  extractMessages?: typeof extract;
  embedApplied?: (
    db: Db,
    sourceMessageId: number,
    applied: ApplyResult,
    mode: RememberingMode,
    guard: MemoryJobEmbeddingGuard,
  ) => Promise<void>;
  clock?: () => Date;
  staleAfterMs?: number;
};

export function createMemoryJob(
  db: Db,
  input: {
    conversationId: number;
    sourceMessageId: number;
    assistantMessageId: number;
    promptVersion: string;
    rememberingMode: Exclude<RememberingMode, "off">;
    id?: string;
  },
): MemoryJobView {
  const source = getMessage(db, input.sourceMessageId);
  const assistant = getMessage(db, input.assistantMessageId);
  if (
    !source ||
    source.role !== "user" ||
    source.conversation_id !== input.conversationId
  ) {
    throw new Error("Memory job source must be a user message in its conversation");
  }
  if (
    !assistant ||
    assistant.role !== "assistant" ||
    assistant.conversation_id !== input.conversationId
  ) {
    throw new Error("Memory job response must be an assistant message in its conversation");
  }

  const id = input.id ?? randomUUID();
  db.prepare<[
    string,
    number,
    number,
    number,
    string,
    Exclude<RememberingMode, "off">,
    string,
  ]>(
    `INSERT OR IGNORE INTO memory_job
       (id, conversation_id, source_message_id, assistant_message_id,
        prompt_version, remembering_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.sourceMessageId,
    input.assistantMessageId,
    input.promptVersion,
    input.rememberingMode,
    now(),
  );

  const row = db
    .prepare<[number, string], MemoryJobRow>(
      `SELECT * FROM memory_job
       WHERE source_message_id = ? AND prompt_version = ?`,
    )
    .get(input.sourceMessageId, input.promptVersion);
  if (!row) throw new Error("Memory job vanished immediately after insert");
  return jobView(db, row);
}

export function getMemoryJob(db: Db, id: string): MemoryJobView | null {
  const row = getMemoryJobRow(db, id);
  return row ? jobView(db, row) : null;
}

export type ConversationMemoryJob = {
  assistantMessageId: number;
  job: MemoryJobView;
};

/**
 * Read the latest durable memory state attached to each assistant turn.
 *
 * A source can be reprocessed under a later prompt version, so this projection
 * deliberately keeps the newest job for an assistant message. The job id itself is
 * opaque and is safe to expose through the consumer DTO boundary.
 */
export function memoryJobsForConversation(
  db: Db,
  conversationId: number,
): ConversationMemoryJob[] {
  const rows = db
    .prepare<[number], MemoryJobRow>(
      `SELECT * FROM memory_job
       WHERE conversation_id = ?
       ORDER BY created_at, rowid`,
    )
    .all(conversationId);
  const byResponse = new Map<number, MemoryJobRow>();
  for (const row of rows) byResponse.set(row.assistant_message_id, row);
  return [...byResponse.values()].map((row) => ({
    assistantMessageId: row.assistant_message_id,
    job: jobView(db, row),
  }));
}

/** True while a server-side runner still has durable work to recover or complete. */
export function hasUnfinishedMemoryJobs(db: Db): boolean {
  return Boolean(
    db
      .prepare<[], { found: number }>(
        `SELECT 1 AS found FROM memory_job
         WHERE status IN ('pending','running') LIMIT 1`,
      )
      .get(),
  );
}

/**
 * Release leases owned by a server process that no longer exists.
 *
 * The local Next runtime invokes this exactly once per process before starting its
 * worker. Claim timestamps still recover a hung worker within a live process; this
 * boundary handles the distinct case where a restart made every old lease orphaned.
 */
export function recoverInterruptedMemoryJobs(db: Db): number {
  return db.prepare(
    `UPDATE memory_job
     SET status = 'pending', started_at = NULL, error_code = NULL
     WHERE status = 'running'`,
  ).run().changes;
}

/**
 * Claim and execute at most one job from the requested job's conversation.
 *
 * Processing the oldest pending item, rather than only the requested item, prevents a
 * later browser poll from starving an earlier response whose tab closed. SQLite's
 * transaction makes the claim atomic; `started_at` is also the lease token, so a stale
 * worker cannot commit after a replacement worker has reclaimed the row.
 */
export async function processMemoryJob(
  db: Db,
  requestedId: string,
  dependencies: MemoryJobDependencies = {},
): Promise<MemoryJobView | null> {
  const requested = getMemoryJobRow(db, requestedId);
  if (!requested) return null;
  if (requested.status === "completed" || requested.status === "failed") {
    return jobView(db, requested);
  }

  const claim = claimOldestJob(db, requested.conversation_id, dependencies);
  if (claim) await executeClaim(db, claim, dependencies);
  const refreshed = getMemoryJobRow(db, requestedId);
  return refreshed ? jobView(db, refreshed) : null;
}

/**
 * Drain durable work without a browser selecting a particular job.
 *
 * This is the boundary used by the local server runner. Claims remain atomic and
 * serialized per conversation, while jobs from different conversations are handled
 * in durable creation order. A bounded batch yields back to the Next.js runtime so a
 * large backlog cannot monopolize one event-loop turn indefinitely.
 */
export async function processPendingMemoryJobs(
  db: Db,
  dependencies: MemoryJobDependencies = {},
  limit = DEFAULT_DRAIN_LIMIT,
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  let processed = 0;
  while (processed < boundedLimit) {
    const claim = claimNextJob(db, dependencies);
    if (!claim) break;
    await executeClaim(db, claim, dependencies);
    processed += 1;
  }
  return processed;
}

export type UndoMemoryJobResult =
  | { outcome: "undone"; job: MemoryJobView }
  | { outcome: "conflict"; job: MemoryJobView }
  | { outcome: "not_found" };

/** Undo is deliberately limited to newly inserted, self-scoped facts. */
export function undoMemoryJob(db: Db, id: string): UndoMemoryJobResult {
  const row = getMemoryJobRow(db, id);
  if (!row) return { outcome: "not_found" };
  if (row.undone_at !== null) return { outcome: "undone", job: jobView(db, row) };

  const plan = parseStoredResult(row.result_json)?.undo ?? null;
  if (
    row.status !== "completed" ||
    !plan ||
    undoHasConflict(db, plan)
  ) {
    return { outcome: "conflict", job: jobView(db, row) };
  }

  const undone = db.transaction((): boolean => {
    const current = getMemoryJobRow(db, id);
    const currentPlan = parseStoredResult(current?.result_json ?? null)?.undo ?? null;
    if (
      !current ||
      current.status !== "completed" ||
      current.undone_at !== null ||
      !currentPlan ||
      undoHasConflict(db, currentPlan)
    ) {
      return false;
    }
    for (const fact of currentPlan.facts) {
      if (!forgetFact(db, fact.row.id)) return false;
    }
    deletePassagesForMessage(db, currentPlan.sourceMessageId);
    db.prepare<[number]>(
      "DELETE FROM embedding WHERE owner_kind = 'message' AND owner_id = ?",
    ).run(currentPlan.sourceMessageId);
    blockMessageRecall(db, currentPlan.sourceMessageId);
    db.prepare<[string, string]>(
      "UPDATE memory_job SET undone_at = ? WHERE id = ? AND undone_at IS NULL",
    ).run(now(), id);
    return true;
  })();

  const refreshed = getMemoryJobRow(db, id);
  if (!refreshed) return { outcome: "not_found" };
  return undone
    ? { outcome: "undone", job: jobView(db, refreshed) }
    : { outcome: "conflict", job: jobView(db, refreshed) };
}

function claimOldestJob(
  db: Db,
  conversationId: number,
  dependencies: MemoryJobDependencies,
): Claim | null {
  const currentTime = dependencies.clock?.() ?? new Date();
  const claimedAt = currentTime.toISOString();
  const cutoff = new Date(
    currentTime.getTime() - (dependencies.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
  ).toISOString();

  return db.transaction((): Claim | null => {
    recoverStaleClaims(db, cutoff, conversationId);

    const active = db
      .prepare<[number], { found: number }>(
        `SELECT 1 AS found FROM memory_job
         WHERE conversation_id = ? AND status = 'running' LIMIT 1`,
      )
      .get(conversationId);
    if (active) return null;

    const next = db
      .prepare<[number], MemoryJobRow>(
        `SELECT * FROM memory_job
         WHERE conversation_id = ? AND status = 'pending'
         ORDER BY created_at, source_message_id, id LIMIT 1`,
      )
      .get(conversationId);
    if (!next) return null;

    const updated = db.prepare<[string, string]>(
      `UPDATE memory_job
       SET status = 'running', started_at = ?, error_code = NULL
       WHERE id = ? AND status = 'pending'`,
    ).run(claimedAt, next.id);
    if (updated.changes !== 1) return null;
    return { ...next, status: "running", started_at: claimedAt, error_code: null };
  })();
}

function claimNextJob(
  db: Db,
  dependencies: MemoryJobDependencies,
): Claim | null {
  const currentTime = dependencies.clock?.() ?? new Date();
  const claimedAt = currentTime.toISOString();
  const cutoff = new Date(
    currentTime.getTime() - (dependencies.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
  ).toISOString();

  return db.transaction((): Claim | null => {
    recoverStaleClaims(db, cutoff);
    const next = db
      .prepare<[], MemoryJobRow>(
        `SELECT pending.*
         FROM memory_job pending
         WHERE pending.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM memory_job active
             WHERE active.conversation_id = pending.conversation_id
               AND active.status = 'running'
           )
         ORDER BY pending.created_at, pending.source_message_id, pending.id
         LIMIT 1`,
      )
      .get();
    if (!next) return null;

    const updated = db.prepare<[string, string]>(
      `UPDATE memory_job
       SET status = 'running', started_at = ?, error_code = NULL
       WHERE id = ? AND status = 'pending'`,
    ).run(claimedAt, next.id);
    if (updated.changes !== 1) return null;
    return { ...next, status: "running", started_at: claimedAt, error_code: null };
  })();
}

function recoverStaleClaims(
  db: Db,
  cutoff: string,
  conversationId?: number,
): void {
  if (conversationId === undefined) {
    db.prepare<[string]>(
      `UPDATE memory_job
       SET status = 'pending', started_at = NULL, error_code = NULL
       WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`,
    ).run(cutoff);
    return;
  }
  db.prepare<[number, string]>(
    `UPDATE memory_job
     SET status = 'pending', started_at = NULL, error_code = NULL
     WHERE conversation_id = ? AND status = 'running'
       AND started_at IS NOT NULL AND started_at < ?`,
  ).run(conversationId, cutoff);
}

async function executeClaim(
  db: Db,
  claim: Claim,
  dependencies: MemoryJobDependencies,
): Promise<void> {
  let stored = parseStoredResult(claim.result_json) ?? { version: JOB_RESULT_VERSION };
  let extractionRunId = stored.extractionRunId ?? null;

  try {
    if (!stored.extraction) {
      const run = startExtractionRun(db, claim.source_message_id);
      extractionRunId = run.id;
      const messages = messagesThroughSource(db, claim);
      const focus = messages.find((message) => message.id === claim.source_message_id);
      const extractOptions = {
        messages,
        context: extractionContext(db, 100, focus?.content ?? ""),
      };
      const extraction = await (dependencies.extractMessages ?? extract)(extractOptions);
      const nextStored: StoredJobResult = {
        version: JOB_RESULT_VERSION,
        extractionRunId,
        extraction,
      };
      if (!storeRunningResult(db, claim, nextStored)) {
        finishExtractionRun(db, extractionRunId, "failed", "lease_lost");
        return;
      }
      stored = nextStored;
    }

    if (!stored.applied) {
      if (!stored.extraction || extractionRunId === null) {
        throw new Error("Memory job extraction state is incomplete");
      }
      const completedExtractionRunId = extractionRunId;
      const messages = messagesThroughSource(db, claim);
      const before = beforeApply(db);
      const allowedSourceMessageIds = eligibleExtractionSourceMessageIds(
        messages,
        claim.source_message_id,
      );

      stored = db.transaction((): StoredJobResult => {
        assertLease(db, claim);
        const applied = applyExtraction(db, stored.extraction as Extraction, claim.source_message_id, {
          requireEvidence: true,
          forceReview: claim.remembering_mode === "confirm",
          extractionRunId: completedExtractionRunId,
          allowedSourceMessageIds,
        });
        if (claim.remembering_mode === "confirm") {
          // Ask-before-saving material cannot leak through episodic recall while its
          // candidates wait for review. Accepting a candidate later unlocks only its
          // exact evidence passage.
          blockMessageRecall(db, claim.source_message_id);
        }
        const activity = activityForApply(
          db,
          applied,
          before,
          claim.source_message_id,
        );
        const undo = buildUndoPlan(db, claim, applied, before);
        const nextStored: StoredJobResult = {
          version: JOB_RESULT_VERSION,
          extractionRunId: completedExtractionRunId,
          applied,
          activity,
          undo,
        };
        const updated = db.prepare<[string, string, string, string]>(
          `UPDATE memory_job
           SET result_json = ?, activity_json = ?
           WHERE id = ? AND status = 'running' AND started_at = ?`,
        ).run(
          JSON.stringify(nextStored),
          JSON.stringify(activity),
          claim.id,
          claim.started_at,
        );
        if (updated.changes !== 1) throw new LostLeaseError();
        const finished = finishExtractionRun(db, completedExtractionRunId, "completed");
        if (finished?.status !== "completed") {
          throw new Error("Extraction audit could not be completed");
        }
        failOtherStartedExtractionRuns(db, claim.source_message_id, completedExtractionRunId);
        return nextStored;
      })();
    }

    if (stored.applied) {
      const embeddingGuard = memoryJobEmbeddingGuard(claim);
      try {
        await (dependencies.embedApplied ?? embedAppliedMemory)(
          db,
          claim.source_message_id,
          stored.applied,
          claim.remembering_mode,
          embeddingGuard,
        );
      } catch (error) {
        // Canonical rows and their exact activity ledger were committed together
        // above. Indexing is derived, degradable state and must never relabel those
        // successful writes as a failed memory update or remove their safe undo plan.
        console.warn(
          `[zeus] memory indexing degraded (${errorCode(error)})`,
        );
      }
      // Deletion may remove this job while local model inference is awaiting. Never let
      // that stale worker complete—or perform any later unguarded phase—after its exact
      // durable lease has disappeared or been replaced.
      assertLease(db, claim);
    }

    const completed = db.prepare<[string, string, string]>(
      `UPDATE memory_job
       SET status = 'completed', completed_at = ?, error_code = NULL
       WHERE id = ? AND status = 'running' AND started_at = ?`,
    ).run(now(), claim.id, claim.started_at);
    if (completed.changes !== 1) throw new LostLeaseError();
  } catch (error) {
    if (error instanceof LostLeaseError) return;
    if (extractionRunId !== null) {
      try {
        finishExtractionRun(db, extractionRunId, "failed", errorCode(error));
      } catch {
        // The job row remains the durable source of failure status.
      }
    }
    const failed = db.prepare<[string, string, string, string]>(
      `UPDATE memory_job
       SET status = 'failed', error_code = ?, completed_at = ?
       WHERE id = ? AND status = 'running' AND started_at = ?`,
    ).run(errorCode(error), now(), claim.id, claim.started_at);
    if (failed.changes === 1) {
      try {
        blockMessageRecall(db, claim.source_message_id);
      } catch {
        // A classifier failure must not make the source cross-chat recallable.
      }
      console.warn(`[zeus] memory job failed (${errorCode(error)})`);
    }
  }
}

async function embedAppliedMemory(
  db: Db,
  sourceMessageId: number,
  applied: ApplyResult,
  mode: RememberingMode,
  guard: MemoryJobEmbeddingGuard,
): Promise<void> {
  const passages = passagesForMessage(db, sourceMessageId).filter(
    (passage) => passage.recall_status === "allowed",
  );
  const source = getMessage(db, sourceMessageId);
  await Promise.all([
    ...(mode === "automatic" && source
      ? [embedMessage(db, source.id, source.content, guard).catch(() => false)]
      : []),
    ...applied.facts.map((fact) =>
      embedFact(
        db,
        fact.id,
        factSearchText(fact.subject_name, fact.predicate, fact.object),
        guard,
      ).catch(() => false),
    ),
    ...applied.facets.map((facet) =>
      embedFacet(
        db,
        facet.id,
        facetSearchText(facet.kind, facet.statement, facet.condition_text),
        guard,
      ).catch(() => false),
    ),
    ...passages.map((passage) =>
      embedPassage(db, passage.id, passage.text, guard).catch(() => false),
    ),
  ]);
}

function memoryJobEmbeddingGuard(claim: Claim): MemoryJobEmbeddingGuard {
  return {
    jobId: claim.id,
    conversationId: claim.conversation_id,
    sourceMessageId: claim.source_message_id,
    assistantMessageId: claim.assistant_message_id,
    promptVersion: claim.prompt_version,
    jobCreatedAt: claim.created_at,
    startedAt: claim.started_at,
  };
}

function storeRunningResult(db: Db, claim: Claim, result: StoredJobResult): boolean {
  const updated = db.prepare<[string, string, string]>(
    `UPDATE memory_job SET result_json = ?
     WHERE id = ? AND status = 'running' AND started_at = ?`,
  ).run(JSON.stringify(result), claim.id, claim.started_at);
  return updated.changes === 1;
}

function assertLease(db: Db, claim: Claim): void {
  const current = db
    .prepare<[string, string], { found: number }>(
      `SELECT 1 AS found FROM memory_job
       WHERE id = ? AND status = 'running' AND started_at = ?`,
    )
    .get(claim.id, claim.started_at);
  if (!current) throw new LostLeaseError();
}

class LostLeaseError extends Error {
  constructor() {
    super("Memory job lease was replaced");
    this.name = "LostLeaseError";
  }
}

function messagesThroughSource(db: Db, job: MemoryJobRow): Message[] {
  return db
    .prepare<[number, number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at, origin, recall_state,
              cross_chat_recall_eligible
       FROM message
       WHERE conversation_id = ? AND id <= ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(job.conversation_id, job.source_message_id, 13)
    .reverse();
}

/**
 * A job may use accepted prior messages for reference resolution, but it may only
 * treat the current source and previously classified, cross-chat-eligible user
 * messages as evidence. This is the durable enforcement for Remembering Off and
 * pending Ask-before-saving material; prompt instructions alone are insufficient.
 */
function eligibleExtractionSourceMessageIds(
  messages: readonly Message[],
  focusMessageId: number,
): number[] {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        (message.id === focusMessageId ||
          (message.cross_chat_recall_eligible === 1 &&
            message.recall_state === "classified")),
    )
    .map((message) => message.id);
}

function beforeApply(db: Db): BeforeApply {
  return {
    fact: maxId(db, "fact"),
    goal: maxId(db, "goal"),
    commitment: maxId(db, "commitment"),
    project: maxId(db, "project"),
    facet: maxId(db, "understanding_facet"),
    candidate: maxId(db, "memory_candidate"),
    predicates: new Set(
      db.prepare<[], { name: string }>("SELECT name FROM predicate").all().map((row) => row.name),
    ),
  };
}

function maxId(db: Db, table: string): number {
  return db.prepare<[], { id: number }>(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get()?.id ?? 0;
}

function activityForApply(
  db: Db,
  applied: ApplyResult,
  before: BeforeApply,
  jobSourceMessageId: number,
): MemoryActivityItem[] {
  const items: MemoryActivityItem[] = [];
  for (const fact of applied.facts) {
    const replacesEarlierFact = Boolean(
      db
        .prepare<[number], { found: number }>(
          "SELECT 1 AS found FROM fact WHERE superseded_by = ? LIMIT 1",
        )
        .get(fact.id),
    );
    items.push({
      id: resourceId("fact", fact.id),
      kind: preferencePredicate(fact.predicate) ? "preference" : "detail",
      change:
        fact.id > before.fact && !replacesEarlierFact ? "saved" : "updated",
      label: factLabel(fact),
      sourceId: resourceId(
        "message",
        factActivitySourceMessageId(db, fact, jobSourceMessageId),
      ),
    });
  }
  for (const facet of applied.facets) {
    items.push({
      id: resourceId("facet", facet.id),
      kind: facet.kind === "preference" || facet.kind.includes("style") ? "preference" : "detail",
      change: facet.id > before.facet ? "saved" : "updated",
      label: facet.statement,
      sourceId: resourceId("message", facet.source_message_id),
    });
  }
  for (const goal of applied.goals) {
    items.push({
      id: resourceId("goal", goal.id),
      kind: "plan",
      change: goal.id > before.goal ? "saved" : "updated",
      label: goal.title,
      sourceId: resourceId("message", goal.source_message_id),
    });
  }
  for (const commitment of applied.commitments) {
    items.push({
      id: resourceId("commitment", commitment.id),
      kind: "plan",
      change: commitment.id > before.commitment ? "saved" : "updated",
      label: commitment.title,
      sourceId: resourceId("message", commitment.source_message_id),
    });
  }
  for (const project of applied.projects) {
    items.push({
      id: resourceId("project", project.id),
      kind: "plan",
      change: project.id > before.project ? "saved" : "updated",
      label: project.entity_name,
      sourceId: resourceId("message", project.source_message_id),
    });
  }
  for (const candidate of applied.candidates) {
    items.push(candidateActivity(candidate));
  }
  const unique = [...new Map(items.map((item) => [`${item.id}:${item.change}`, item])).values()];
  return MemoryActivityItemSchema.array().parse(unique);
}

/**
 * Point the change receipt at evidence accepted by this job whenever it exists.
 * Legacy facts can intentionally have a null canonical source; reassertion adds real
 * `fact_evidence` without rewriting that historical row, so a synthetic message id is
 * neither necessary nor permitted here.
 */
function factActivitySourceMessageId(
  db: Db,
  fact: FactView,
  jobSourceMessageId: number,
): number {
  const jobEvidence = db
    .prepare<[number, number], { source_message_id: number }>(
      `SELECT source_message_id FROM fact_evidence
       WHERE fact_id = ? AND source_message_id = ? LIMIT 1`,
    )
    .get(fact.id, jobSourceMessageId);
  if (jobEvidence) return jobEvidence.source_message_id;
  if (fact.source_message_id !== null) return fact.source_message_id;

  const acceptedEvidence = db
    .prepare<[number], { source_message_id: number }>(
      `SELECT source_message_id FROM fact_evidence
       WHERE fact_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(fact.id);
  if (acceptedEvidence) return acceptedEvidence.source_message_id;
  throw new Error(`Applied fact ${fact.id} has no accepted evidence source`);
}

function candidateActivity(candidate: CandidateView): MemoryActivityItem {
  return {
    id: resourceId("candidate", candidate.id),
    kind:
      candidate.kind === "goal" || candidate.kind === "commitment"
        ? "plan"
        : candidate.kind === "facet" || candidate.kind === "interest"
          ? "preference"
          : "detail",
    change: "needs_review",
    label: candidateLabel(candidate),
    sourceId: resourceId("message", candidate.source_message_id),
  };
}

function candidateLabel(candidate: CandidateView): string {
  const envelope = objectRecord(candidate.payload);
  const item = objectRecord(envelope.item ?? candidate.payload);
  const statement = firstText(item.statement, item.title, item.object);
  if (candidate.kind === "fact" || candidate.kind === "interest") {
    const subject = firstText(item.subject) || "You";
    const rawPredicate = firstText(item.predicate);
    const predicate = rawPredicate.replaceAll("_", " ");
    const object = firstText(item.object);
    if (subject === "self") {
      const phrase: Record<string, string> = {
        likes: "You like",
        dislikes: "You dislike",
        prefers: "You prefer",
        works_at: "You work at",
        lives_in: "You live in",
        job_title: "Your role is",
        cares_about: "You care about",
        works_on: "You work on",
      };
      if (phrase[rawPredicate]) return `${phrase[rawPredicate]} ${object}`.trim();
    }
    return [subject === "self" ? "You" : subject, predicate, object].filter(Boolean).join(" ");
  }
  return statement || "A detail from this conversation";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstText(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

function preferencePredicate(predicate: string): boolean {
  return ["likes", "dislikes", "prefers"].includes(predicate);
}

function factLabel(fact: FactView): string {
  const subject = fact.subject_slug === "self" ? "You" : fact.subject_name;
  if (fact.subject_slug === "self") {
    const phrases: Record<string, string> = {
      likes: "You like",
      dislikes: "You dislike",
      prefers: "You prefer",
      works_at: "You work at",
      lives_in: "You live in",
      job_title: "Your role is",
      cares_about: "You care about",
      works_on: "You work on",
    };
    const phrase = phrases[fact.predicate];
    if (phrase) return `${phrase} ${fact.object}`;
  }
  return `${subject}: ${fact.object}`;
}

function buildUndoPlan(
  db: Db,
  job: MemoryJobRow,
  applied: ApplyResult,
  before: BeforeApply,
): UndoPlan | null {
  if (
    applied.facts.length === 0 ||
    applied.goals.length > 0 ||
    applied.commitments.length > 0 ||
    applied.projects.length > 0 ||
    applied.facets.length > 0 ||
    applied.candidates.length > 0 ||
    applied.supersededIds.length > 0 ||
    applied.facts.some((fact) => fact.id <= before.fact)
  ) {
    return null;
  }

  const selfId = db
    .prepare<[], { id: number }>("SELECT id FROM entity WHERE slug = 'self'")
    .get()?.id;
  if (!selfId) return null;

  const facts: UndoPlan["facts"] = [];
  for (const fact of applied.facts) {
    const row = factSnapshot(db, fact.id);
    const evidence = factEvidenceSnapshot(db, fact.id);
    if (
      !row ||
      row.subject_id !== selfId ||
      row.object_entity_id !== null ||
      row.source_message_id !== job.source_message_id ||
      row.valid_to !== null ||
      row.superseded_by !== null ||
      row.assertion_count !== 1 ||
      !before.predicates.has(row.predicate) ||
      evidence.length === 0 ||
      evidence.some((item) => item.source_message_id !== job.source_message_id)
    ) {
      return null;
    }
    facts.push({ row, evidence });
  }
  const passages = passagesForMessage(db, job.source_message_id);
  if (passages.length === 0) return null;
  return {
    kind: "inserted_facts",
    sourceMessageId: job.source_message_id,
    passages,
    facts,
  };
}

function undoHasConflict(db: Db, plan: UndoPlan): boolean {
  if (
    JSON.stringify(passagesForMessage(db, plan.sourceMessageId)) !==
    JSON.stringify(plan.passages)
  ) {
    return true;
  }
  for (const expected of plan.facts) {
    const row = factSnapshot(db, expected.row.id);
    const evidence = factEvidenceSnapshot(db, expected.row.id);
    if (
      JSON.stringify(row) !== JSON.stringify(expected.row) ||
      JSON.stringify(evidence) !== JSON.stringify(expected.evidence)
    ) {
      return true;
    }
  }
  const ids = plan.facts.map((fact) => fact.row.id);
  if (ids.length === 0) return true;
  const placeholders = ids.map(() => "?").join(",");
  const checks = [
    `SELECT 1 AS found FROM response_context WHERE item_kind = 'fact' AND item_id IN (${placeholders}) LIMIT 1`,
    `SELECT 1 AS found FROM mcp_recall_audit WHERE item_kind = 'fact' AND item_id IN (${placeholders}) LIMIT 1`,
    `SELECT 1 AS found FROM work_plan_memory_source WHERE source_kind = 'fact' AND source_id IN (${placeholders}) LIMIT 1`,
    `SELECT 1 AS found FROM work_artifact_memory_source WHERE source_kind = 'fact' AND source_id IN (${placeholders}) LIMIT 1`,
    `SELECT 1 AS found FROM fact WHERE superseded_by IN (${placeholders}) AND id NOT IN (${placeholders}) LIMIT 1`,
  ];
  for (const [index, query] of checks.entries()) {
    const params = index === checks.length - 1 ? [...ids, ...ids] : ids;
    if (db.prepare<number[], { found: number }>(query).get(...params)) return true;
  }
  const passageIds = plan.passages.map((passage) => passage.id);
  const passagePlaceholders = passageIds.map(() => "?").join(",");
  const sourceChecks: Array<{ query: string; params: number[] }> = [
    {
      query: `SELECT 1 AS found FROM candidate_evidence WHERE passage_id IN (${passagePlaceholders}) LIMIT 1`,
      params: passageIds,
    },
    {
      query: `SELECT 1 AS found FROM facet_evidence WHERE passage_id IN (${passagePlaceholders}) LIMIT 1`,
      params: passageIds,
    },
    {
      query: `SELECT 1 AS found FROM fact_evidence
              WHERE passage_id IN (${passagePlaceholders})
                AND fact_id NOT IN (${placeholders}) LIMIT 1`,
      params: [...passageIds, ...ids],
    },
    {
      query: `SELECT 1 AS found FROM goal_event WHERE passage_id IN (${passagePlaceholders}) LIMIT 1`,
      params: passageIds,
    },
    {
      query: `SELECT 1 AS found FROM commitment_event WHERE passage_id IN (${passagePlaceholders}) LIMIT 1`,
      params: passageIds,
    },
    {
      query: `SELECT 1 AS found FROM project_event WHERE passage_id IN (${passagePlaceholders}) LIMIT 1`,
      params: passageIds,
    },
    {
      query: `SELECT 1 AS found FROM work_plan_memory_source_message
              WHERE source_message_id = ? LIMIT 1`,
      params: [plan.sourceMessageId],
    },
    {
      query: `SELECT 1 AS found FROM response_context
              WHERE item_kind = 'episode' AND (
                item_id IN (${passagePlaceholders}) OR
                json_extract(snapshot_json, '$.episode.message.id') = ?
              ) LIMIT 1`,
      params: [...passageIds, plan.sourceMessageId],
    },
    {
      query: `SELECT 1 AS found FROM mcp_recall_audit
              WHERE item_kind = 'episode' AND (
                item_id IN (${passagePlaceholders}) OR
                json_extract(snapshot_json, '$.source_message_id') = ? OR
                json_extract(snapshot_json, '$.episode.message.id') = ?
              ) LIMIT 1`,
      params: [...passageIds, plan.sourceMessageId, plan.sourceMessageId],
    },
  ];
  for (const check of sourceChecks) {
    if (db.prepare<number[], { found: number }>(check.query).get(...check.params)) return true;
  }
  return false;
}

function factSnapshot(db: Db, id: number): FactRowSnapshot | null {
  return db
    .prepare<[number], FactRowSnapshot>(
      `SELECT id, subject_id, predicate, object, object_entity_id, confidence,
              valid_from, valid_to, superseded_by, source_message_id,
              assertion_count, last_seen_at, created_at
       FROM fact WHERE id = ?`,
    )
    .get(id) ?? null;
}

function factEvidenceSnapshot(db: Db, factId: number): FactEvidenceSnapshot[] {
  return db
    .prepare<[number], FactEvidenceSnapshot>(
      `SELECT id, fact_id, source_message_id, passage_id, kind, confidence, created_at
       FROM fact_evidence WHERE fact_id = ? ORDER BY id`,
    )
    .all(factId);
}

function jobView(db: Db, row: MemoryJobRow): MemoryJobView {
  const parsed = MemoryActivityItemSchema.array().safeParse(parseJson(row.activity_json));
  const plan = parseStoredResult(row.result_json)?.undo ?? null;
  const canUndo =
    row.status === "completed" &&
    row.undone_at === null &&
    plan !== null &&
    !undoHasConflict(db, plan);
  return {
    id: row.id,
    status: row.status,
    items: parsed.success ? parsed.data : [],
    canUndo,
    undone: row.undone_at !== null,
    error: row.error_code === null ? null : "Memory could not be updated.",
  };
}

function getMemoryJobRow(db: Db, id: string): MemoryJobRow | null {
  return db.prepare<[string], MemoryJobRow>("SELECT * FROM memory_job WHERE id = ?").get(id) ?? null;
}

function parseStoredResult(value: string | null): StoredJobResult | null {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Partial<StoredJobResult>;
  return record.version === JOB_RESULT_VERSION ? (record as StoredJobResult) : null;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function failOtherStartedExtractionRuns(db: Db, sourceMessageId: number, keepId: number): void {
  db.prepare<[string, number, number]>(
    `UPDATE extraction_run
     SET status = 'failed', error_code = 'stale_worker', completed_at = ?
     WHERE focus_message_id = ? AND status = 'started' AND id != ?`,
  ).run(now(), sourceMessageId, keepId);
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.name || "memory_job_error" : "memory_job_error";
  return raw.replace(/[^a-z0-9_.:-]+/giu, "_").slice(0, 120);
}

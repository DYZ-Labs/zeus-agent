import { createCandidate, listCandidates } from "./candidates";
import type { CandidateView } from "./candidates";
import { now } from "./db";
import type { Db } from "./db";
import {
  acceptCandidate,
  extract,
  extractionContext,
  extractionSourceMessageIds,
  finishExtractionRun,
  startExtractionRun,
} from "./extract";
import type { ExtractionRun } from "./extract";
import type { ExtractOptions } from "./extract";
import { listFacets } from "./facets";
import {
  allowWholeMessagePassage,
  blockMessageRecall,
  ensureEvidencePassage,
  sourceLooksSensitive,
} from "./passages";
import type {
  CandidateReason,
  EvidencePassage,
  ExtractedFacet,
  Message,
  ParsedExtraction,
  SourceAssessment,
  UnderstandingFacetView,
} from "./schema";

export const BACKFILL_EXTRACTOR_VERSION = "understanding-v1";
export const BACKFILL_BATCH_SIZE = 5;

export type BackfillStatus = "preview" | "running" | "completed" | "failed" | "cancelled";

export type UnderstandingBackfillJob = {
  id: number;
  status: BackfillStatus;
  conversation_count: number;
  message_count: number;
  processed_count: number;
  last_message_id: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type BackfillBatchResult = {
  job: UnderstandingBackfillJob;
  processed: number;
  candidates: number;
};

type BackfillExtractor = (options: ExtractOptions) => Promise<ParsedExtraction>;

const SELECT_JOB = `
  SELECT id, status, conversation_count, message_count, processed_count,
         last_message_id, error_message, created_at, updated_at, completed_at
  FROM understanding_backfill_job
`;

export function getUnderstandingBackfillJob(
  db: Db,
  id: number,
): UnderstandingBackfillJob | null {
  return (
    db
      .prepare<[number], UnderstandingBackfillJob>(`${SELECT_JOB} WHERE id = ?`)
      .get(id) ?? null
  );
}

export function latestUnderstandingBackfillJob(db: Db): UnderstandingBackfillJob | null {
  return (
    db
      .prepare<[], UnderstandingBackfillJob>(`${SELECT_JOB} ORDER BY id DESC LIMIT 1`)
      .get() ?? null
  );
}

/**
 * Snapshot the currently eligible history. Starting the same extractor again does
 * not reprocess messages it already completed; new messages form a new resumable job.
 */
export function startUnderstandingBackfill(
  db: Db,
  extractorVersion = BACKFILL_EXTRACTOR_VERSION,
): UnderstandingBackfillJob {
  const active = db
    .prepare<[], UnderstandingBackfillJob>(
      `${SELECT_JOB} WHERE status IN ('preview','running') ORDER BY id DESC LIMIT 1`,
    )
    .get();
  if (active) return active;

  const eligible = db
    .prepare<[], { id: number; conversation_id: number }>(
      `SELECT m.id, m.conversation_id
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       WHERE m.role = 'user'
         AND m.origin = 'conversation'
         AND m.recall_state = 'unclassified'
         AND COALESCE(c.title, '') != 'Memory curation'
       ORDER BY m.id`,
    )
    .all();
  const timestamp = now();

  return db.transaction(() => {
    const conversations = new Set(eligible.map((message) => message.conversation_id)).size;
    const result = db
      .prepare<[number, number, string, string]>(
        `INSERT INTO understanding_backfill_job
           (status, conversation_count, message_count, processed_count,
            created_at, updated_at)
         VALUES ('preview', ?, ?, 0, ?, ?)`,
      )
      .run(conversations, eligible.length, timestamp, timestamp);
    const id = Number(result.lastInsertRowid);
    const insertItem = db.prepare<[number, number, string, string, string]>(
      `INSERT INTO understanding_backfill_item
         (job_id, message_id, extractor_version, status, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let skipped = 0;
    for (const message of eligible) {
      const previouslyCompleted = db
        .prepare<[number, string], { found: number }>(
          `SELECT 1 AS found
           FROM understanding_backfill_item
           WHERE message_id = ? AND extractor_version = ?
             AND status IN ('completed','skipped')
           LIMIT 1`,
        )
        .get(message.id, extractorVersion);
      const status = previouslyCompleted ? "skipped" : "pending";
      if (status === "skipped") skipped += 1;
      insertItem.run(id, message.id, extractorVersion, status, timestamp);
    }

    if (skipped > 0) {
      db.prepare<[number, string, number]>(
        `UPDATE understanding_backfill_job
         SET processed_count = ?, updated_at = ? WHERE id = ?`,
      ).run(skipped, timestamp, id);
    }
    finishJobIfComplete(db, id);
    const job = getUnderstandingBackfillJob(db, id);
    if (!job) throw new Error("Understanding backfill vanished immediately after insert");
    return job;
  })();
}

/** Process one deliberately short batch. Each message commits independently. */
export async function processUnderstandingBackfillBatch(
  db: Db,
  id: number,
  options: { batchSize?: number; extractor?: BackfillExtractor } = {},
): Promise<BackfillBatchResult> {
  const current = getUnderstandingBackfillJob(db, id);
  if (!current) throw new Error(`Unknown understanding backfill job ${id}`);
  if (current.status === "completed" || current.status === "cancelled") {
    return { job: current, processed: 0, candidates: 0 };
  }

  const timestamp = now();
  db.transaction(() => {
    // A process may have stopped after claiming an item. Retrying is safe because
    // candidate writes have a stable dedupe key and completion is derived from rows.
    db.prepare<[string, number]>(
      `UPDATE understanding_backfill_item
       SET status = 'pending', error_message = NULL, updated_at = ?
       WHERE job_id = ? AND status = 'processing'`,
    ).run(timestamp, id);
    db.prepare<[string, number]>(
      `UPDATE understanding_backfill_job
       SET status = 'running', error_message = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(timestamp, id);
  })();

  const batchSize = Math.max(1, Math.min(20, options.batchSize ?? BACKFILL_BATCH_SIZE));
  const items = db
    .prepare<[number, number], { message_id: number; extractor_version: string }>(
      `SELECT message_id, extractor_version
       FROM understanding_backfill_item
       WHERE job_id = ? AND status IN ('pending','failed')
       ORDER BY message_id
       LIMIT ?`,
    )
    .all(id, batchSize);
  const runExtractor = options.extractor ?? extract;
  let processed = 0;
  let candidateCount = 0;

  for (const item of items) {
    let extractionRun: ExtractionRun | null = null;
    const claimedAt = now();
    db.prepare<[string, number, number, string]>(
      `UPDATE understanding_backfill_item
       SET status = 'processing', error_message = NULL, updated_at = ?
       WHERE job_id = ? AND message_id = ? AND extractor_version = ?`,
    ).run(claimedAt, id, item.message_id, item.extractor_version);

    try {
      const messages = boundedBackfillContext(db, item.message_id);
      const extractOptions = {
        messages,
        context: extractionContext(db, 100, messages.at(-1)?.content ?? ""),
      };
      const run = startExtractionRun(db, item.message_id);
      extractionRun = run;
      const allowedSourceMessageIds = extractionSourceMessageIds(extractOptions);
      const extraction = await runExtractor(extractOptions);
      const created = db.transaction(() => {
        const count = materializeBackfillPreview(
          db,
          id,
          item.message_id,
          extraction,
          new Set(allowedSourceMessageIds),
          run.id,
        );
        db.prepare<[number, string, number, number, string]>(
          `UPDATE understanding_backfill_item
           SET status = 'completed', candidate_count = ?, error_message = NULL,
               updated_at = ?
           WHERE job_id = ? AND message_id = ? AND extractor_version = ?`,
        ).run(count, now(), id, item.message_id, item.extractor_version);
        refreshJobProgress(db, id);
        const finished = finishExtractionRun(db, run.id, "completed");
        if (finished?.status !== "completed") {
          throw new Error("Backfill extraction audit could not be completed");
        }
        return count;
      })();
      candidateCount += created;
      processed += 1;
    } catch (error) {
      const detail = safeError(error);
      if (extractionRun) {
        try {
          finishExtractionRun(db, extractionRun.id, "failed", extractionErrorCode(error));
        } catch {
          // The job remains resumable even if audit persistence is degraded.
        }
      }
      db.transaction(() => {
        db.prepare<[string, string, number, number, string]>(
          `UPDATE understanding_backfill_item
           SET status = 'failed', error_message = ?, updated_at = ?
           WHERE job_id = ? AND message_id = ? AND extractor_version = ?`,
        ).run(detail, now(), id, item.message_id, item.extractor_version);
        db.prepare<[string, string, number]>(
          `UPDATE understanding_backfill_job
           SET status = 'preview', error_message = ?, updated_at = ? WHERE id = ?`,
        ).run(detail, now(), id);
      })();
      break;
    }
  }

  refreshJobProgress(db, id);
  const job = getUnderstandingBackfillJob(db, id);
  if (!job) throw new Error("Understanding backfill disappeared while processing");
  return { job, processed, candidates: candidateCount };
}

/** Batch acceptance is deliberately limited to direct, clear, normal, text-only facets. */
export type BackfillAcceptanceResult = {
  accepted: number;
  facets: UnderstandingFacetView[];
  passages: EvidencePassage[];
};

export function acceptEligibleBackfillFacets(
  db: Db,
  jobId: number,
): BackfillAcceptanceResult {
  const candidates = listCandidates(db, {
    status: "pending",
    kind: "facet",
    backfillJobId: jobId,
    limit: 10_000,
  });
  let accepted = 0;
  const facets: UnderstandingFacetView[] = [];
  const passages: EvidencePassage[] = [];
  for (const candidate of candidates) {
    if (!batchAcceptable(candidate)) continue;
    const applied = acceptCandidate(db, candidate.id);
    if (!applied) continue;
    accepted += 1;
    facets.push(...applied.facets);
    passages.push(...candidate.evidence);
  }
  return {
    accepted,
    facets,
    passages: [...new Map(passages.map((passage) => [passage.id, passage])).values()],
  };
}

function materializeBackfillPreview(
  db: Db,
  jobId: number,
  focusMessageId: number,
  extraction: ParsedExtraction,
  allowedSourceMessageIds: ReadonlySet<number>,
  extractionRunId: number,
): number {
  if (!allowedSourceMessageIds.has(focusMessageId)) {
    throw new Error("Backfill focus was not present in the bounded model transcript");
  }
  const assessments = extraction.source_assessments.filter((assessment) =>
    allowedSourceMessageIds.has(assessment.source_message_id)
  );
  classifyFocusMessage(db, focusMessageId, assessments, extractionRunId);
  let count = 0;
  let inferredEmitted = false;
  for (const facet of extraction.facets) {
    if (facet.grounding !== "user_statement") continue;
    if (facet.explicitness === "inferred" && inferredEmitted) continue;

    const sources = materializeFacetEvidence(
      db,
      facet,
      assessments,
      allowedSourceMessageIds,
      extractionRunId,
    );
    if (sources.length === 0 || !sources.some((passage) => passage.message_id === focusMessageId)) {
      continue;
    }
    if (
      facet.explicitness === "inferred" &&
      new Set(sources.map((passage) => passage.message_id)).size < 2
    ) {
      continue;
    }

    const sourceSensitive = sources.some((passage) => passage.sensitivity !== "normal");
    const normalized: ExtractedFacet = {
      ...facet,
      sensitivity: facet.sensitivity === "sensitive" || sourceSensitive ? "sensitive" : "normal",
    };
    const reasons = backfillReasons(normalized);
    const conflictPreview = relatedFacetPreview(db, normalized);
    const payload = {
      item: normalized,
      entities: extraction.entities,
      ...(conflictPreview ? { conflict_preview: [conflictPreview] } : {}),
    };
    const candidate = createCandidate(db, {
      kind: "facet",
      payload,
      reason: reasons[0] ?? "backfill_preview",
      reasons,
      confidence: normalized.confidence,
      sourceMessageId: focusMessageId,
      passageIds: sources.map((passage) => passage.id),
      origin: "backfill",
      backfillJobId: jobId,
    });
    if (candidate.backfill_job_id === jobId && candidate.status === "pending") count += 1;
    if (facet.explicitness === "inferred") inferredEmitted = true;
  }
  return count;
}

function materializeFacetEvidence(
  db: Db,
  facet: ParsedExtraction["facets"][number],
  assessments: readonly SourceAssessment[],
  allowedSourceMessageIds: ReadonlySet<number>,
  extractionRunId: number,
): EvidencePassage[] {
  const assessmentByMessage = new Map(
    assessments.map((assessment) => [assessment.source_message_id, assessment] as const),
  );
  const passages: EvidencePassage[] = [];
  for (const evidence of facet.evidence) {
    if (!allowedSourceMessageIds.has(evidence.source_message_id)) return [];
    const source = db
      .prepare<[number], Pick<Message, "role" | "content" | "origin">>(
        "SELECT role, content, origin FROM message WHERE id = ?",
      )
      .get(evidence.source_message_id);
    if (!source || source.role !== "user" || source.origin !== "conversation") return [];
    const assessment = assessmentByMessage.get(evidence.source_message_id);
    const sensitive =
      facet.sensitivity === "sensitive" ||
      sourceLooksSensitive(source.content) ||
      assessment?.sensitivity === "sensitive" ||
      assessment?.sensitivity === "uncertain";
    try {
      passages.push(
        ensureEvidencePassage(db, {
          messageId: evidence.source_message_id,
          quote: evidence.quote,
          sensitivity: sensitive
            ? assessment?.sensitivity === "uncertain"
              ? "uncertain"
              : "sensitive"
            : "normal",
          recallStatus: sensitive || assessment === undefined ? "pending" : "allowed",
          extractionRunId,
        }),
      );
    } catch {
      // One invalid citation invalidates the whole proposal; partial evidence could
      // make an inferred pattern appear better supported than it actually is.
      return [];
    }
  }
  return [...new Map(passages.map((passage) => [passage.id, passage])).values()];
}

function classifyFocusMessage(
  db: Db,
  messageId: number,
  assessments: readonly SourceAssessment[],
  extractionRunId: number,
): void {
  const message = db
    .prepare<[number], Pick<Message, "role" | "content">>(
      "SELECT role, content FROM message WHERE id = ?",
    )
    .get(messageId);
  if (!message || message.role !== "user") return;
  const assessment = assessments.find((item) => item.source_message_id === messageId);
  if (assessment?.sensitivity === "normal" && !sourceLooksSensitive(message.content)) {
    allowWholeMessagePassage(db, messageId, extractionRunId);
    return;
  }
  blockMessageRecall(db, messageId);
  for (const quote of assessment?.sensitive_quotes ?? []) {
    try {
      ensureEvidencePassage(db, {
        messageId,
        quote,
        sensitivity: assessment?.sensitivity === "uncertain" ? "uncertain" : "sensitive",
        recallStatus: "pending",
        extractionRunId,
      });
    } catch {
      // Invalid classifier spans keep the message blocked.
    }
  }
}

function backfillReasons(facet: ExtractedFacet): CandidateReason[] {
  const reasons: CandidateReason[] = [];
  if (facet.sensitivity === "sensitive") reasons.push("sensitive");
  if (facet.ambiguity === "ambiguous") reasons.push("ambiguous");
  if (facet.explicitness === "inferred" || facet.confidence < 0.6) reasons.push("inference");
  reasons.push("backfill_preview");
  return [...new Set(reasons)];
}

function relatedFacetPreview(db: Db, facet: ExtractedFacet): string | null {
  const related = listFacets(db, { kinds: [facet.kind], limit: 100 }).find((accepted) => {
    if (accepted.scope_kind !== facet.scope.kind) return false;
    if (facet.scope.kind === "global") return true;
    if (facet.scope.kind === "domain") {
      return accepted.scope_label?.toLowerCase() === facet.scope.label.trim().toLowerCase();
    }
    if (facet.scope.kind === "goal") return accepted.scope_goal_id === facet.scope.id;
    if (facet.scope.kind === "commitment") return accepted.scope_commitment_id === facet.scope.id;
    return accepted.scope_entity_name?.toLowerCase() === facet.scope.name.trim().toLowerCase();
  });
  if (!related || related.statement.toLowerCase() === facet.statement.trim().toLowerCase()) {
    return null;
  }
  return `Related accepted understanding remains current: “${related.statement}”. Acceptance will keep both visible for conflict review.`;
}

function batchAcceptable(candidate: CandidateView): boolean {
  if (candidate.reasons.some((reason) => reason !== "backfill_preview")) return false;
  const outer = asRecord(candidate.payload);
  const item = asRecord(outer.item ?? candidate.payload);
  return (
    item.grounding === "user_statement" &&
    item.explicitness === "explicit" &&
    item.sensitivity === "normal" &&
    item.ambiguity === "clear" &&
    (item.machine_effect === null || item.machine_effect === undefined)
  );
}

function boundedBackfillContext(db: Db, focusMessageId: number): Message[] {
  const focus = db
    .prepare<[number], { conversation_id: number }>(
      "SELECT conversation_id FROM message WHERE id = ?",
    )
    .get(focusMessageId);
  if (!focus) throw new Error(`Backfill source message ${focusMessageId} no longer exists`);
  const rows = db
    .prepare<[number, number], Message>(
      `SELECT id, conversation_id, role, content, created_at, origin, recall_state
       FROM message
       WHERE conversation_id = ? AND id <= ? AND origin = 'conversation'
       ORDER BY id DESC
       LIMIT 13`,
    )
    .all(focus.conversation_id, focusMessageId)
    .reverse();

  // Leave room for the extraction context and schema within the 6,000-token budget.
  let remainingCharacters = 18_000;
  const bounded: Message[] = [];
  for (const message of [...rows].reverse()) {
    if (remainingCharacters <= 0 && message.id !== focusMessageId) continue;
    const content = message.content.slice(0, Math.max(1, remainingCharacters));
    bounded.push({ ...message, content });
    remainingCharacters -= content.length;
  }
  return bounded.reverse();
}

function refreshJobProgress(db: Db, id: number): void {
  const progress = db
    .prepare<[number], { count: number; last_message_id: number | null }>(
      `SELECT COUNT(*) AS count, MAX(message_id) AS last_message_id
       FROM understanding_backfill_item
       WHERE job_id = ? AND status IN ('completed','skipped')`,
    )
    .get(id) ?? { count: 0, last_message_id: null };
  db.prepare<[number, number | null, string, number]>(
    `UPDATE understanding_backfill_job
     SET processed_count = ?, last_message_id = ?, updated_at = ? WHERE id = ?`,
  ).run(progress.count, progress.last_message_id, now(), id);
  finishJobIfComplete(db, id);
}

function finishJobIfComplete(db: Db, id: number): void {
  const remaining = db
    .prepare<[number], { count: number }>(
      `SELECT COUNT(*) AS count FROM understanding_backfill_item
       WHERE job_id = ? AND status NOT IN ('completed','skipped')`,
    )
    .get(id)?.count ?? 0;
  if (remaining === 0) {
    const timestamp = now();
    db.prepare<[string, string, number]>(
      `UPDATE understanding_backfill_job
       SET status = 'completed', error_message = NULL, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(timestamp, timestamp, id);
  } else {
    db.prepare<[string, number]>(
      `UPDATE understanding_backfill_job
       SET status = 'preview', updated_at = ? WHERE id = ? AND status = 'running'`,
    ).run(now(), id);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 500) || "Unknown extraction failure";
}

function extractionErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "backfill_extraction_error";
}

import type { Db } from "./db";
import { now } from "./db";
import type {
  CandidateKind,
  CandidateReason,
  CandidateStatus,
  EvidencePassage,
  MemoryCandidate,
} from "./schema";
import { getPassage } from "./passages";

export type CandidateView = MemoryCandidate & {
  payload: unknown;
  reasons: CandidateReason[];
  evidence: EvidencePassage[];
  source_excerpt: string;
};

export type CreateCandidateInput = {
  kind: CandidateKind;
  payload: unknown;
  reason: CandidateReason;
  reasons?: readonly CandidateReason[];
  confidence: number;
  sourceMessageId: number;
  passageIds?: readonly number[];
  dedupeKey?: string | null;
  origin?: "live" | "backfill";
  backfillJobId?: number | null;
};

export function createCandidate(db: Db, input: CreateCandidateInput): CandidateView {
  const timestamp = now();
  const confidence = Math.min(1, Math.max(0.01, input.confidence));
  const payload = JSON.stringify(input.payload);
  const reasons = [...new Set([input.reason, ...(input.reasons ?? [])])];
  const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input.kind, input.payload);

  const duplicate = db
    .prepare<[CandidateKind, string], { id: number; status: CandidateStatus }>(
      `SELECT id, status FROM memory_candidate
       WHERE kind = ? AND dedupe_key = ?
       ORDER BY CASE status WHEN 'rejected' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
                id DESC
       LIMIT 1`,
    )
    .get(input.kind, dedupeKey);
  if (duplicate) {
    // A rejected proposal remains a durable suppression record. Accepted proposals
    // are canonical already. Neither may silently reappear in a future review queue.
    if (duplicate.status !== "pending") {
      const existing = getCandidate(db, duplicate.id);
      if (existing) return existing;
    }
    if (input.passageIds?.length && duplicate.status === "pending") {
      const insertEvidence = db.prepare<[number, number, string]>(
        `INSERT OR IGNORE INTO candidate_evidence
           (candidate_id, passage_id, created_at) VALUES (?, ?, ?)`,
      );
      for (const passageId of input.passageIds) {
        if (getPassage(db, passageId)) insertEvidence.run(duplicate.id, passageId, timestamp);
      }
    }
    if (duplicate.status === "pending") {
      const current = getCandidate(db, duplicate.id);
      if (current) {
        const combinedReasons = [...new Set([...current.reasons, ...reasons])];
        db.prepare<[string, number, number]>(
          `UPDATE memory_candidate
           SET reasons_json = ?, confidence = MAX(confidence, ?)
           WHERE id = ?`,
        ).run(JSON.stringify(combinedReasons), confidence, duplicate.id);
      }
    }
    const existing = getCandidate(db, duplicate.id);
    if (existing) return existing;
  }

  const result = db
    .prepare<[
      CandidateKind,
      string,
      CandidateReason,
      string,
      number,
      number,
      string,
      "live" | "backfill",
      number | null,
      string,
    ]>(
      `INSERT INTO memory_candidate
         (kind, payload_json, reason, reasons_json, confidence, source_message_id,
          dedupe_key, origin, backfill_job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.kind,
      payload,
      input.reason,
      JSON.stringify(reasons),
      confidence,
      input.sourceMessageId,
      dedupeKey,
      input.origin ?? "live",
      input.backfillJobId ?? null,
      timestamp,
    );

  const candidateId = Number(result.lastInsertRowid);
  if (input.passageIds?.length) {
    const insertEvidence = db.prepare<[number, number, string]>(
      `INSERT OR IGNORE INTO candidate_evidence
         (candidate_id, passage_id, created_at) VALUES (?, ?, ?)`,
    );
    for (const passageId of input.passageIds) {
      if (!getPassage(db, passageId)) {
        throw new Error(`Candidate references unknown evidence passage ${passageId}`);
      }
      insertEvidence.run(candidateId, passageId, timestamp);
    }
  }

  const candidate = getCandidate(db, candidateId);
  if (!candidate) throw new Error("Memory candidate vanished immediately after insert");
  return candidate;
}

export function getCandidate(db: Db, id: number): CandidateView | null {
  const row = db
    .prepare<[number], MemoryCandidate & { source_excerpt: string }>(
      `SELECT c.id, c.kind, c.payload_json, c.reason, c.confidence,
              c.reasons_json, c.source_message_id, c.status, c.dedupe_key,
              c.origin, c.backfill_job_id, c.resolved_at, c.created_at,
              substr(m.content, 1, 360) AS source_excerpt
       FROM memory_candidate c
       JOIN message m ON m.id = c.source_message_id
       WHERE c.id = ?`,
    )
    .get(id);
  return row ? withPayload(db, row) : null;
}

export function listCandidates(
  db: Db,
  options: {
    status?: CandidateStatus;
    kind?: CandidateKind;
    backfillJobId?: number;
    limit?: number;
  } = {},
): CandidateView[] {
  const status = options.status ?? "pending";
  const clauses = ["c.status = ?"];
  const params: Array<string | number> = [status];
  if (options.kind) {
    clauses.push("c.kind = ?");
    params.push(options.kind);
  }
  if (options.backfillJobId !== undefined) {
    clauses.push("c.backfill_job_id = ?");
    params.push(options.backfillJobId);
  }
  params.push(options.limit ?? 200);
  return db
    .prepare<Array<string | number>, MemoryCandidate & { source_excerpt: string }>(
      `SELECT c.id, c.kind, c.payload_json, c.reason, c.confidence,
              c.reasons_json, c.source_message_id, c.status, c.dedupe_key,
              c.origin, c.backfill_job_id, c.resolved_at, c.created_at,
              substr(m.content, 1, 360) AS source_excerpt
       FROM memory_candidate c
       JOIN message m ON m.id = c.source_message_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
    )
    .all(...params)
    .map((row) => withPayload(db, row));
}

export function resolveCandidate(db: Db, id: number, status: "accepted" | "rejected"): boolean {
  const result = db
    .prepare<[CandidateStatus, string, number]>(
      `UPDATE memory_candidate
       SET status = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, now(), id);
  return result.changes > 0;
}

export function recordCandidateResolution(
  db: Db,
  input: {
    candidateId: number;
    decision: "accepted" | "rejected" | "edited_accepted";
    editedPayload?: unknown;
    sourceMessageId?: number | null;
    sourceKind?: "user_action" | "message" | "system";
  },
): void {
  db.prepare<[number, string, string | null, number | null, string, string]>(
    `INSERT INTO candidate_resolution_event
       (candidate_id, decision, edited_payload_json, source_message_id,
        source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.candidateId,
    input.decision,
    input.editedPayload === undefined ? null : JSON.stringify(input.editedPayload),
    input.sourceMessageId ?? null,
    input.sourceKind ?? "user_action",
    now(),
  );
}

export function countPendingCandidates(db: Db): number {
  return (
    db
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM memory_candidate WHERE status = 'pending'",
      )
      .get()?.count ?? 0
  );
}

function withPayload(
  db: Db,
  row: MemoryCandidate & { source_excerpt: string },
): CandidateView {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    // The schema has json_valid(), but an externally modified database should still
    // degrade into a reviewable row instead of taking the whole page down.
  }
  let reasons: CandidateReason[] = [row.reason];
  try {
    const parsed = JSON.parse(row.reasons_json) as unknown;
    if (Array.isArray(parsed)) {
      reasons = parsed.filter((reason): reason is CandidateReason =>
        ["inference", "ambiguous", "sensitive", "conflict", "backfill_preview"].includes(
          String(reason),
        ),
      );
    }
  } catch {
    // Preserve the primary reason on damaged external data.
  }
  const evidence = db
    .prepare<[number], EvidencePassage>(
      `SELECT p.id, p.message_id, p.start_offset, p.end_offset, p.text,
              p.sensitivity, p.recall_status, p.extraction_run_id, p.created_at
       FROM candidate_evidence ce
       JOIN evidence_passage p ON p.id = ce.passage_id
       WHERE ce.candidate_id = ? ORDER BY p.message_id, p.start_offset`,
    )
    .all(row.id);
  return { ...row, payload, reasons, evidence };
}

function defaultDedupeKey(kind: CandidateKind, payload: unknown): string {
  const outer = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const record =
    outer.item && typeof outer.item === "object"
      ? (outer.item as Record<string, unknown>)
      : outer;
  const statement = semanticSignature(
    String(
      record.statement ??
        record.title ??
        `${record.subject ?? ""}|${record.predicate ?? ""}|${record.object ?? ""}`,
    ),
  );
  const scope =
    kind === "facet" && record.scope && typeof record.scope === "object"
      ? stableScope(record.scope as Record<string, unknown>)
      : "";
  const condition = kind === "facet"
    ? semanticSignature(String(record.condition ?? ""))
    : "";
  const structuredCondition = kind === "facet"
    ? stableJsonSignature(record.structured_condition ?? null)
    : "";
  const effect = kind === "facet" ? String(record.machine_effect ?? "none") : "";
  const operation = kind === "fact" || kind === "interest"
    ? String(record.operation ?? "assert")
    : "";
  const lifecycle = kind === "goal" || kind === "commitment"
    ? `${String(record.existing_id ?? "new")}:${String(record.status ?? "")}`
    : "";
  return `${kind}:${scope}:${condition}:${structuredCondition}:${effect}:${operation}:${lifecycle}:${statement}`;
}

function stableJsonSignature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonSignature).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonSignature(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Conservative semantic normalization for queue suppression. Sorting content words
 * catches word-order paraphrases while scope, condition, effect, operation, and
 * lifecycle state remain separate so a prior rejection cannot suppress a materially
 * different proposal.
 */
function semanticSignature(value: string): string {
  const stop = new Set(["a", "an", "and", "for", "of", "the", "to", "with"]);
  const terms = value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter((term) => !stop.has(term)))].sort().join(" ");
}

function stableScope(scope: Record<string, unknown>): string {
  const kind = String(scope.kind ?? "global").trim().toLowerCase();
  if (kind === "domain") return `domain:${String(scope.label ?? "").trim().toLowerCase()}`;
  if (kind === "entity") return `entity:${String(scope.name ?? "").trim().toLowerCase()}`;
  if (kind === "goal" || kind === "commitment") return `${kind}:${String(scope.id ?? "")}`;
  return "global";
}

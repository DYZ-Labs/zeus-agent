import type { Db } from "./db";
import { now } from "./db";
import type {
  CandidateKind,
  CandidateReason,
  CandidateStatus,
  MemoryCandidate,
} from "./schema";

export type CandidateView = MemoryCandidate & {
  payload: unknown;
  source_excerpt: string;
};

export type CreateCandidateInput = {
  kind: CandidateKind;
  payload: unknown;
  reason: CandidateReason;
  confidence: number;
  sourceMessageId: number;
};

export function createCandidate(db: Db, input: CreateCandidateInput): CandidateView {
  const timestamp = now();
  const confidence = Math.min(1, Math.max(0.01, input.confidence));
  const payload = JSON.stringify(input.payload);

  const duplicate = db
    .prepare<[CandidateKind, CandidateReason, number, string], { id: number }>(
      `SELECT id FROM memory_candidate
       WHERE kind = ? AND reason = ? AND source_message_id = ?
         AND payload_json = ? AND status = 'pending'
       LIMIT 1`,
    )
    .get(input.kind, input.reason, input.sourceMessageId, payload);
  if (duplicate) {
    const existing = getCandidate(db, duplicate.id);
    if (existing) return existing;
  }

  const result = db
    .prepare<[CandidateKind, string, CandidateReason, number, number, string]>(
      `INSERT INTO memory_candidate
         (kind, payload_json, reason, confidence, source_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.kind, payload, input.reason, confidence, input.sourceMessageId, timestamp);

  const candidate = getCandidate(db, Number(result.lastInsertRowid));
  if (!candidate) throw new Error("Memory candidate vanished immediately after insert");
  return candidate;
}

export function getCandidate(db: Db, id: number): CandidateView | null {
  const row = db
    .prepare<[number], MemoryCandidate & { source_excerpt: string }>(
      `SELECT c.id, c.kind, c.payload_json, c.reason, c.confidence,
              c.source_message_id, c.status, c.resolved_at, c.created_at,
              substr(m.content, 1, 360) AS source_excerpt
       FROM memory_candidate c
       JOIN message m ON m.id = c.source_message_id
       WHERE c.id = ?`,
    )
    .get(id);
  return row ? withPayload(row) : null;
}

export function listCandidates(
  db: Db,
  options: { status?: CandidateStatus; limit?: number } = {},
): CandidateView[] {
  const status = options.status ?? "pending";
  return db
    .prepare<[CandidateStatus, number], MemoryCandidate & { source_excerpt: string }>(
      `SELECT c.id, c.kind, c.payload_json, c.reason, c.confidence,
              c.source_message_id, c.status, c.resolved_at, c.created_at,
              substr(m.content, 1, 360) AS source_excerpt
       FROM memory_candidate c
       JOIN message m ON m.id = c.source_message_id
       WHERE c.status = ?
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ?`,
    )
    .all(status, options.limit ?? 200)
    .map(withPayload);
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
  row: MemoryCandidate & { source_excerpt: string },
): CandidateView {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    // The schema has json_valid(), but an externally modified database should still
    // degrade into a reviewable row instead of taking the whole page down.
  }
  return { ...row, payload };
}

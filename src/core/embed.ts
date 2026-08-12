import type { Db } from "./db";
import { now } from "./db";
import type { OwnerKind } from "./schema";

/**
 * Local embeddings.
 *
 * The whole point of the local-only posture is that the corpus never leaves the
 * machine, and that includes the text sent to an embedding API. So this runs a small
 * ONNX sentence-transformer in-process instead. It is slower than a hosted endpoint
 * and that is the correct trade for a file containing everything about someone.
 *
 * Semantic search is additive: if the model cannot be loaded (offline first run,
 * unsupported platform, ZEUS_EMBEDDINGS=off), every function here degrades to a no-op
 * and search falls back to FTS5 alone rather than failing.
 */

export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIM = 384;

type FeatureExtractor = (
  text: string | string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

/**
 * Immutable identity for one claimed durable memory job.
 *
 * Embedding generation awaits local model work, so an explicit source/account deletion
 * can remove the job and its canonical rows while the model is still running. Guarded
 * writes prove, in the same SQLite statement as the insert/update, that the original
 * lease and source-backed resource still exist. A reused numeric resource id alone is
 * therefore never enough to receive a stale vector.
 */
export type MemoryJobEmbeddingGuard = Readonly<{
  jobId: string;
  conversationId: number;
  sourceMessageId: number;
  assistantMessageId: number;
  promptVersion: string;
  jobCreatedAt: string;
  startedAt: string;
}>;

/** Identity captured before asynchronous model work. Unguarded/manual/reindex paths
 * still need to prove that the exact resource they embedded survived the await; a
 * numeric row id can be reused after explicit erasure. */
type ResourceEmbeddingGuard =
  | Readonly<{
      kind: "fact";
      id: number;
      createdAt: string;
      subjectId: number;
      predicate: string;
      object: string;
    }>
  | Readonly<{
      kind: "message";
      id: number;
      conversationId: number;
      createdAt: string;
      content: string;
    }>
  | Readonly<{
      kind: "passage";
      id: number;
      messageId: number;
      createdAt: string;
      text: string;
    }>
  | Readonly<{
      kind: "facet";
      id: number;
      sourceMessageId: number;
      createdAt: string;
      statement: string;
    }>;

let pipelinePromise: Promise<FeatureExtractor | null> | null = null;

export function embeddingsDisabled(): boolean {
  return process.env.ZEUS_EMBEDDINGS === "off";
}

/**
 * Load the model once per process. Returns null — permanently, for this process —
 * if it cannot be loaded, so a missing model costs one failed attempt rather than
 * one per query.
 */
async function getExtractor(): Promise<FeatureExtractor | null> {
  if (embeddingsDisabled()) return null;

  pipelinePromise ??= (async () => {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      // Keep the model cache inside the project so it is obvious and disposable.
      env.cacheDir = process.env.ZEUS_MODEL_CACHE ?? ".models";
      const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
        dtype: "fp32",
      });
      return extractor as unknown as FeatureExtractor;
    } catch (error) {
      console.warn(
        `[zeus] semantic search unavailable, falling back to full-text only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  })();

  return pipelinePromise;
}

/** Embed one string. Returns null when semantic search is unavailable. */
export async function embed(text: string): Promise<Float32Array | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const extractor = await getExtractor();
  if (!extractor) return null;

  try {
    const output = await extractor(trimmed, { pooling: "mean", normalize: true });
    return output.data instanceof Float32Array
      ? output.data
      : Float32Array.from(output.data as number[]);
  } catch {
    // Do not include the input or model exception in logs: embedding text may itself
    // be sensitive. Every retrieval caller can continue through FTS/graph paths.
    console.warn("[zeus] local embedding failed; falling back to non-semantic retrieval");
    return null;
  }
}

/** Cosine similarity of two unit-normalized vectors — a dot product, given normalize:true. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  // Copy rather than view: better-sqlite3 buffers are not guaranteed 4-byte aligned,
  // and an unaligned Float32Array constructor throws.
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function putEmbedding(
  db: Db,
  ownerKind: OwnerKind,
  ownerId: number,
  vector: Float32Array,
  guard?: MemoryJobEmbeddingGuard,
): boolean {
  if (guard) {
    const resourcePredicate = ownerKind === "fact"
      ? `EXISTS (
           SELECT 1 FROM fact resource
           JOIN fact_evidence evidence ON evidence.fact_id = resource.id
           WHERE resource.id = ?
             AND evidence.source_message_id = job.source_message_id
         )`
      : ownerKind === "message"
        ? `EXISTS (
             SELECT 1 FROM message resource
             WHERE resource.id = ?
               AND resource.id = job.source_message_id
               AND resource.conversation_id = job.conversation_id
               AND resource.role = 'user'
           )`
        : null;
    if (!resourcePredicate) return false;

    const inserted = db.prepare(
      `INSERT INTO embedding (owner_kind, owner_id, vec, dim, model, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       FROM memory_job job
       WHERE ${memoryJobLeasePredicate()}
         AND ${resourcePredicate}
       ON CONFLICT (owner_kind, owner_id)
       DO UPDATE SET vec = excluded.vec, dim = excluded.dim,
                     model = excluded.model, created_at = excluded.created_at`,
    ).run(
      ownerKind,
      ownerId,
      toBlob(vector),
      vector.length,
      EMBEDDING_MODEL,
      now(),
      ...memoryJobLeaseValues(guard),
      ownerId,
    );
    return inserted.changes > 0;
  }

  db.prepare<[OwnerKind, number, Buffer, number, string, string]>(
    `INSERT INTO embedding (owner_kind, owner_id, vec, dim, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_kind, owner_id)
     DO UPDATE SET vec = excluded.vec, dim = excluded.dim,
                   model = excluded.model, created_at = excluded.created_at`,
  ).run(ownerKind, ownerId, toBlob(vector), vector.length, EMBEDDING_MODEL, now());
  return true;
}

function putEmbeddingForResource(
  db: Db,
  guard: Extract<ResourceEmbeddingGuard, { kind: "fact" | "message" }>,
  vector: Float32Array,
): boolean {
  const predicate = guard.kind === "fact"
    ? `EXISTS (
         SELECT 1 FROM fact resource
         WHERE resource.id = ? AND resource.created_at = ?
           AND resource.subject_id = ? AND resource.predicate = ? AND resource.object = ?
       )`
    : `EXISTS (
         SELECT 1 FROM message resource
         WHERE resource.id = ? AND resource.conversation_id = ?
           AND resource.created_at = ? AND resource.content = ? AND resource.role = 'user'
       )`;
  const identity = guard.kind === "fact"
    ? [guard.id, guard.createdAt, guard.subjectId, guard.predicate, guard.object]
    : [guard.id, guard.conversationId, guard.createdAt, guard.content];
  const inserted = db.prepare(
    `INSERT INTO embedding (owner_kind, owner_id, vec, dim, model, created_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE ${predicate}
     ON CONFLICT (owner_kind, owner_id)
     DO UPDATE SET vec = excluded.vec, dim = excluded.dim,
                   model = excluded.model, created_at = excluded.created_at`,
  ).run(
    guard.kind,
    guard.id,
    toBlob(vector),
    vector.length,
    EMBEDDING_MODEL,
    now(),
    ...identity,
  );
  return inserted.changes > 0;
}

export function deleteEmbedding(db: Db, ownerKind: OwnerKind, ownerId: number): void {
  db.prepare<[OwnerKind, number]>(
    "DELETE FROM embedding WHERE owner_kind = ? AND owner_id = ?",
  ).run(ownerKind, ownerId);
}

export type StoredVector = { ownerId: number; vector: Float32Array };

export function loadVectors(db: Db, ownerKind: OwnerKind): StoredVector[] {
  return db
    .prepare<[OwnerKind, string], { owner_id: number; vec: Buffer }>(
      "SELECT owner_id, vec FROM embedding WHERE owner_kind = ? AND model = ?",
    )
    .all(ownerKind, EMBEDDING_MODEL)
    .map((row) => ({ ownerId: row.owner_id, vector: fromBlob(row.vec) }));
}

/** Only allowed claim-sized passages participate in episodic semantic recall. */
export function loadPassageVectors(db: Db): StoredVector[] {
  return db
    .prepare<[string], { passage_id: number; vec: Buffer }>(
      `SELECT pe.passage_id, pe.vec
       FROM passage_embedding pe
       JOIN evidence_passage p ON p.id = pe.passage_id
       WHERE pe.model = ? AND p.recall_status = 'allowed'
         AND NOT EXISTS (
           SELECT 1 FROM candidate_evidence ce
           JOIN memory_candidate mc ON mc.id = ce.candidate_id
           WHERE ce.passage_id = p.id AND mc.status IN ('pending','rejected')
         )`,
    )
    .all(EMBEDDING_MODEL)
    .map((row) => ({ ownerId: row.passage_id, vector: fromBlob(row.vec) }));
}

/** Closed facets remain historical data but do not enter current semantic recall. */
export function loadFacetVectors(db: Db): StoredVector[] {
  return db
    .prepare<[string], { facet_id: number; vec: Buffer }>(
      `SELECT fe.facet_id, fe.vec
       FROM facet_embedding fe
       JOIN understanding_facet f ON f.id = fe.facet_id
       WHERE fe.model = ? AND f.valid_to IS NULL`,
    )
    .all(EMBEDDING_MODEL)
    .map((row) => ({ ownerId: row.facet_id, vector: fromBlob(row.vec) }));
}

/**
 * Minimum cosine similarity for a vector hit to count as a hit at all.
 *
 * Without a floor, nearest-neighbour search always returns its top N no matter how far
 * away they are, so a question the memory knows nothing about still comes back with
 * confident-looking results. That is precisely the failure this system is built to
 * avoid — recalling noise is how a memory starts fabricating.
 *
 * Measured on bge-small-en-v1.5 against a seeded store: genuinely relevant top hits
 * score 0.59-0.69, while wholly unrelated queries top out around 0.43-0.46. 0.50 sits
 * in that gap. This number is model-specific — re-measure if EMBEDDING_MODEL changes.
 */
export const SEMANTIC_FLOOR = Number(process.env.ZEUS_SEMANTIC_FLOOR ?? 0.5);

/**
 * Brute-force nearest neighbours above the similarity floor.
 *
 * At 384 dimensions a fact vector is ~1.5 KB, so 10k facts is ~15 MB scanned in a few
 * milliseconds — no index needed at personal scale. This is the piece that would need
 * a real ANN index past roughly 50k facts.
 */
export function nearest(
  query: Float32Array,
  vectors: readonly StoredVector[],
  limit: number,
  minScore: number = SEMANTIC_FLOOR,
): { ownerId: number; score: number }[] {
  const scored = vectors
    .map((entry) => ({ ownerId: entry.ownerId, score: cosine(query, entry.vector) }))
    .filter((entry) => entry.score >= minScore);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Embed and store one fact. Silently no-ops when semantic search is unavailable. */
export async function embedFact(
  db: Db,
  factId: number,
  text: string,
  guard?: MemoryJobEmbeddingGuard,
): Promise<boolean> {
  const resource = guard ? null : factEmbeddingGuard(db, factId);
  if (!guard && !resource) return false;
  const vector = await embed(text);
  if (!vector) return false;
  return guard
    ? putEmbedding(db, "fact", factId, vector, guard)
    : putEmbeddingForResource(db, resource!, vector);
}

/** User-authored messages become episodic memory. Assistant text is never evidence. */
export async function embedMessage(
  db: Db,
  messageId: number,
  text: string,
  guard?: MemoryJobEmbeddingGuard,
): Promise<boolean> {
  const resource = guard ? null : messageEmbeddingGuard(db, messageId);
  if (!guard && !resource) return false;
  const vector = await embed(text);
  if (!vector) return false;
  return guard
    ? putEmbedding(db, "message", messageId, vector, guard)
    : putEmbeddingForResource(db, resource!, vector);
}

/** Embed an allowed immutable source passage without exposing neighbouring text. */
export async function embedPassage(
  db: Db,
  passageId: number,
  text: string,
  guard?: MemoryJobEmbeddingGuard,
): Promise<boolean> {
  const resource = guard ? null : passageEmbeddingGuard(db, passageId);
  const allowed = db
    .prepare<[number], { found: number }>(
      `SELECT 1 AS found FROM evidence_passage p
       WHERE p.id = ? AND p.recall_status = 'allowed'
         AND NOT EXISTS (
           SELECT 1 FROM candidate_evidence ce
           JOIN memory_candidate mc ON mc.id = ce.candidate_id
           WHERE ce.passage_id = p.id AND mc.status IN ('pending','rejected')
         )`,
    )
    .get(passageId);
  if (!allowed || (!guard && !resource)) return false;
  const vector = await embed(text);
  if (!vector) return false;
  if (guard) {
    const inserted = db.prepare(
      `INSERT INTO passage_embedding (passage_id, vec, dim, model, created_at)
       SELECT passage.id, ?, ?, ?, ?
       FROM memory_job job
       JOIN evidence_passage passage ON passage.id = ?
       WHERE ${memoryJobLeasePredicate()}
         AND passage.message_id = job.source_message_id
         AND passage.recall_status = 'allowed'
         AND NOT EXISTS (
           SELECT 1 FROM candidate_evidence candidate_evidence
           JOIN memory_candidate candidate
             ON candidate.id = candidate_evidence.candidate_id
           WHERE candidate_evidence.passage_id = passage.id
             AND candidate.status IN ('pending','rejected')
         )
       ON CONFLICT (passage_id) DO UPDATE SET
         vec = excluded.vec, dim = excluded.dim,
         model = excluded.model, created_at = excluded.created_at`,
    ).run(
      toBlob(vector),
      vector.length,
      EMBEDDING_MODEL,
      now(),
      passageId,
      ...memoryJobLeaseValues(guard),
    );
    return inserted.changes > 0;
  }
  const inserted = db.prepare(
    `INSERT INTO passage_embedding (passage_id, vec, dim, model, created_at)
     SELECT passage.id, ?, ?, ?, ?
     FROM evidence_passage passage
     WHERE passage.id = ? AND passage.message_id = ?
       AND passage.created_at = ? AND passage.text = ?
       AND passage.recall_status = 'allowed'
       AND NOT EXISTS (
         SELECT 1 FROM candidate_evidence candidate_evidence
         JOIN memory_candidate candidate ON candidate.id = candidate_evidence.candidate_id
         WHERE candidate_evidence.passage_id = passage.id
           AND candidate.status IN ('pending','rejected')
       )
     ON CONFLICT (passage_id) DO UPDATE SET
       vec = excluded.vec, dim = excluded.dim,
       model = excluded.model, created_at = excluded.created_at`,
  ).run(
    toBlob(vector),
    vector.length,
    EMBEDDING_MODEL,
    now(),
    resource!.id,
    resource!.messageId,
    resource!.createdAt,
    resource!.text,
  );
  return inserted.changes > 0;
}

export async function embedFacet(
  db: Db,
  facetId: number,
  text: string,
  guard?: MemoryJobEmbeddingGuard,
): Promise<boolean> {
  const resource = guard ? null : facetEmbeddingGuard(db, facetId);
  const current = db
    .prepare<[number], { found: number }>(
      "SELECT 1 AS found FROM understanding_facet WHERE id = ? AND valid_to IS NULL",
    )
    .get(facetId);
  if (!current || (!guard && !resource)) return false;
  const vector = await embed(text);
  if (!vector) return false;
  if (guard) {
    const inserted = db.prepare(
      `INSERT INTO facet_embedding (facet_id, vec, dim, model, created_at)
       SELECT facet.id, ?, ?, ?, ?
       FROM memory_job job
       JOIN understanding_facet facet ON facet.id = ?
       WHERE ${memoryJobLeasePredicate()}
         AND facet.valid_to IS NULL
         AND EXISTS (
           SELECT 1 FROM facet_evidence evidence
           JOIN evidence_passage passage ON passage.id = evidence.passage_id
           WHERE evidence.facet_id = facet.id
             AND passage.message_id = job.source_message_id
         )
       ON CONFLICT (facet_id) DO UPDATE SET
         vec = excluded.vec, dim = excluded.dim,
         model = excluded.model, created_at = excluded.created_at`,
    ).run(
      toBlob(vector),
      vector.length,
      EMBEDDING_MODEL,
      now(),
      facetId,
      ...memoryJobLeaseValues(guard),
    );
    return inserted.changes > 0;
  }
  const inserted = db.prepare(
    `INSERT INTO facet_embedding (facet_id, vec, dim, model, created_at)
     SELECT facet.id, ?, ?, ?, ?
     FROM understanding_facet facet
     WHERE facet.id = ? AND facet.source_message_id = ?
       AND facet.created_at = ? AND facet.statement = ? AND facet.valid_to IS NULL
     ON CONFLICT (facet_id) DO UPDATE SET
       vec = excluded.vec, dim = excluded.dim,
       model = excluded.model, created_at = excluded.created_at`,
  ).run(
    toBlob(vector),
    vector.length,
    EMBEDDING_MODEL,
    now(),
    resource!.id,
    resource!.sourceMessageId,
    resource!.createdAt,
    resource!.statement,
  );
  return inserted.changes > 0;
}

function factEmbeddingGuard(
  db: Db,
  id: number,
): Extract<ResourceEmbeddingGuard, { kind: "fact" }> | null {
  const row = db.prepare<
    [number],
    { created_at: string; subject_id: number; predicate: string; object: string }
  >("SELECT created_at, subject_id, predicate, object FROM fact WHERE id = ?").get(id);
  return row
    ? {
        kind: "fact",
        id,
        createdAt: row.created_at,
        subjectId: row.subject_id,
        predicate: row.predicate,
        object: row.object,
      }
    : null;
}

function messageEmbeddingGuard(
  db: Db,
  id: number,
): Extract<ResourceEmbeddingGuard, { kind: "message" }> | null {
  const row = db.prepare<
    [number],
    { conversation_id: number; created_at: string; content: string; role: string }
  >(
    "SELECT conversation_id, created_at, content, role FROM message WHERE id = ?",
  ).get(id);
  return row?.role === "user"
    ? {
        kind: "message",
        id,
        conversationId: row.conversation_id,
        createdAt: row.created_at,
        content: row.content,
      }
    : null;
}

function passageEmbeddingGuard(
  db: Db,
  id: number,
): Extract<ResourceEmbeddingGuard, { kind: "passage" }> | null {
  const row = db.prepare<
    [number],
    { message_id: number; created_at: string; text: string }
  >("SELECT message_id, created_at, text FROM evidence_passage WHERE id = ?").get(id);
  return row
    ? { kind: "passage", id, messageId: row.message_id, createdAt: row.created_at, text: row.text }
    : null;
}

function facetEmbeddingGuard(
  db: Db,
  id: number,
): Extract<ResourceEmbeddingGuard, { kind: "facet" }> | null {
  const row = db.prepare<
    [number],
    { source_message_id: number; created_at: string; statement: string }
  >(
    "SELECT source_message_id, created_at, statement FROM understanding_facet WHERE id = ?",
  ).get(id);
  return row
    ? {
        kind: "facet",
        id,
        sourceMessageId: row.source_message_id,
        createdAt: row.created_at,
        statement: row.statement,
      }
    : null;
}

function memoryJobLeasePredicate(): string {
  return `job.id = ?
          AND job.conversation_id = ?
          AND job.source_message_id = ?
          AND job.assistant_message_id = ?
          AND job.prompt_version = ?
          AND job.created_at = ?
          AND job.status = 'running'
          AND job.started_at = ?
          AND EXISTS (
            SELECT 1 FROM message source
            WHERE source.id = job.source_message_id
              AND source.conversation_id = job.conversation_id
              AND source.role = 'user'
          )
          AND EXISTS (
            SELECT 1 FROM message response
            WHERE response.id = job.assistant_message_id
              AND response.conversation_id = job.conversation_id
              AND response.role = 'assistant'
          )`;
}

function memoryJobLeaseValues(guard: MemoryJobEmbeddingGuard): readonly unknown[] {
  return [
    guard.jobId,
    guard.conversationId,
    guard.sourceMessageId,
    guard.assistantMessageId,
    guard.promptVersion,
    guard.jobCreatedAt,
    guard.startedAt,
  ];
}

/** Facts with no current-model embedding — the backlog `reindex` works through. */
export function factsMissingEmbeddings(
  db: Db,
  limit = 1000,
): { id: number; text: string }[] {
  return db
    .prepare<[string, number], { id: number; text: string }>(
      `SELECT f.id AS id,
              s.name || ' ' || replace(f.predicate, '_', ' ') || ' ' || f.object AS text
       FROM fact f
       JOIN entity s ON s.id = f.subject_id
       LEFT JOIN embedding e
         ON e.owner_kind = 'fact' AND e.owner_id = f.id AND e.model = ?
       WHERE e.owner_id IS NULL
       LIMIT ?`,
    )
    .all(EMBEDDING_MODEL, limit);
}

/** User episodes with no current-model embedding — consumed by `reindex`. */
export function messagesMissingEmbeddings(
  db: Db,
  limit = 1000,
): { id: number; text: string }[] {
  return db
    .prepare<[string, number], { id: number; text: string }>(
      `SELECT m.id, m.content AS text
       FROM message m
       LEFT JOIN embedding e
         ON e.owner_kind = 'message' AND e.owner_id = m.id AND e.model = ?
       WHERE m.role = 'user' AND e.owner_id IS NULL
       LIMIT ?`,
    )
    .all(EMBEDDING_MODEL, limit);
}

export function passagesMissingEmbeddings(
  db: Db,
  limit = 1000,
): { id: number; text: string }[] {
  return db
    .prepare<[string, number], { id: number; text: string }>(
      `SELECT p.id, p.text
       FROM evidence_passage p
       LEFT JOIN passage_embedding e
         ON e.passage_id = p.id AND e.model = ?
       WHERE p.recall_status = 'allowed' AND e.passage_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM candidate_evidence ce
           JOIN memory_candidate mc ON mc.id = ce.candidate_id
           WHERE ce.passage_id = p.id AND mc.status IN ('pending','rejected')
         )
       ORDER BY p.id LIMIT ?`,
    )
    .all(EMBEDDING_MODEL, limit);
}

export function facetsMissingEmbeddings(
  db: Db,
  limit = 1000,
): { id: number; text: string }[] {
  return db
    .prepare<[string, number], { id: number; text: string }>(
      `SELECT f.id,
              replace(f.kind, '_', ' ') || ' ' || f.statement ||
              CASE WHEN f.condition_text IS NULL THEN '' ELSE ' ' || f.condition_text END AS text
       FROM understanding_facet f
       LEFT JOIN facet_embedding e
         ON e.facet_id = f.id AND e.model = ?
       WHERE f.valid_to IS NULL AND e.facet_id IS NULL
       ORDER BY f.id LIMIT ?`,
    )
    .all(EMBEDDING_MODEL, limit);
}

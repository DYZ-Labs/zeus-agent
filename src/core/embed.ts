import { resolve } from "node:path";

import type { Db } from "./db";
import { now } from "./db";
import { errorSignature, logEvent } from "./observability";
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

export type EmbeddingStatus = "disabled" | "unloaded" | "loading" | "ready" | "unavailable";

/**
 * Loader state on globalThis rather than in module scope.
 *
 * Next.js gives `instrumentation.ts` its own module registry, so a model warmed at
 * startup would otherwise live in an instance no request handler can see: the warm-up
 * would populate the disk cache but every route would still report "unloaded" and load
 * its own copy. The same trick keeps a hot reload from leaking a second extractor.
 */
type EmbeddingRuntime = {
  pipelinePromise: Promise<FeatureExtractor | null> | null;
  state: Exclude<EmbeddingStatus, "disabled">;
  lastFailureAt: number | null;
};

const globalForEmbeddings = globalThis as typeof globalThis & {
  zeusEmbeddings?: EmbeddingRuntime;
};

function runtime(): EmbeddingRuntime {
  return (globalForEmbeddings.zeusEmbeddings ??= {
    pipelinePromise: null,
    state: "unloaded",
    lastFailureAt: null,
  });
}

/**
 * How long a failed load suppresses another attempt.
 *
 * Long enough that a missing model costs one attempt rather than one per query, short
 * enough that a transient failure — a CDN blip during boot, a volume mounted a moment
 * late — does not silently cost this process semantic search until the next deploy.
 */
export const MODEL_LOAD_RETRY_COOLDOWN_MS = 10 * 60_000;

export function embeddingsDisabled(): boolean {
  return process.env.ZEUS_EMBEDDINGS === "off";
}

/**
 * Where the model is cached, as an absolute path.
 *
 * Resolved rather than left relative: the default is interpreted against the working
 * directory, so the same deployment started from a different directory would download
 * the model again into a second copy. On a hosted deployment this should point at the
 * mounted volume, which turns a per-deploy download into a one-time one.
 */
export function modelCacheDirectory(): string {
  return resolve(process.env.ZEUS_MODEL_CACHE?.trim() || ".models");
}

/**
 * Report the model's state without loading it.
 *
 * Semantic search degrades silently by design, which is right for a chat turn and wrong
 * for an operator: a process that quietly fell back to full-text answers worse while
 * looking healthy. Health reporting needs to see that without paying to load the model.
 */
export function embeddingStatus(): EmbeddingStatus {
  return embeddingsDisabled() ? "disabled" : runtime().state;
}

/**
 * Load the model once per process, retrying only after a cooldown.
 *
 * A failed load used to disable semantic search for the life of the process, which
 * turned a momentary problem at startup into a permanently worse-answering server that
 * still looked healthy. Now a failure is remembered just long enough to stop one failed
 * load per query, and a later call gets another chance.
 */
async function getExtractor(): Promise<FeatureExtractor | null> {
  if (embeddingsDisabled()) return null;
  const current = runtime();
  if (
    current.pipelinePromise === null &&
    current.lastFailureAt !== null &&
    Date.now() - current.lastFailureAt < MODEL_LOAD_RETRY_COOLDOWN_MS
  ) {
    return null;
  }

  current.pipelinePromise ??= loadExtractor();
  return current.pipelinePromise;
}

async function loadExtractor(): Promise<FeatureExtractor | null> {
  const current = runtime();
  current.state = "loading";
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = modelCacheDirectory();
    const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "fp32",
    });
    current.state = "ready";
    current.lastFailureAt = null;
    return extractor as unknown as FeatureExtractor;
  } catch (error) {
    current.state = "unavailable";
    current.lastFailureAt = Date.now();
    // Drop the memo so the cooldown, not this promise, decides when to try again.
    current.pipelinePromise = null;
    // Retrieval quality drops without anything else changing, so it is worth an event.
    logEvent({
      event: "embeddings_unavailable",
      outcome: "degraded",
      reason: "model_load_failed",
      model: EMBEDDING_MODEL,
      ...errorSignature(error),
    });
    return null;
  }
}

/**
 * Load the model now rather than inside whichever request happens to search first.
 *
 * The first semantic search otherwise pays for a ~140MB download from a public CDN
 * while a user waits. Returns the resulting status instead of throwing: a warm-up that
 * fails must leave the caller running on full-text search, not break it.
 */
export async function warmEmbeddings(): Promise<EmbeddingStatus> {
  await getExtractor();
  return embeddingStatus();
}

/** Tests only: forget the loaded model and any cooldown. */
export function resetEmbeddingsForTest(): void {
  globalForEmbeddings.zeusEmbeddings = {
    pipelinePromise: null,
    state: "unloaded",
    lastFailureAt: null,
  };
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
  } catch (error) {
    // Never the input or the model exception text: embedding text is memory. The
    // error's class and code location are enough to tell one failure from another.
    logEvent({
      event: "embedding_failed",
      outcome: "degraded",
      reason: "inference_failed",
      ...errorSignature(error),
    });
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
): void {
  db.prepare<[OwnerKind, number, Buffer, number, string, string]>(
    `INSERT INTO embedding (owner_kind, owner_id, vec, dim, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_kind, owner_id)
     DO UPDATE SET vec = excluded.vec, dim = excluded.dim,
                   model = excluded.model, created_at = excluded.created_at`,
  ).run(ownerKind, ownerId, toBlob(vector), vector.length, EMBEDDING_MODEL, now());
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
           WHERE ce.passage_id = p.id AND mc.kind = 'facet'
             AND mc.status IN ('pending','rejected')
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
export async function embedFact(db: Db, factId: number, text: string): Promise<boolean> {
  const vector = await embed(text);
  if (!vector) return false;
  putEmbedding(db, "fact", factId, vector);
  return true;
}

/** User-authored messages become episodic memory. Assistant text is never evidence. */
export async function embedMessage(db: Db, messageId: number, text: string): Promise<boolean> {
  const role = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(messageId)?.role;
  if (role !== "user") return false;
  const vector = await embed(text);
  if (!vector) return false;
  putEmbedding(db, "message", messageId, vector);
  return true;
}

/** Embed an allowed immutable source passage without exposing neighbouring text. */
export async function embedPassage(
  db: Db,
  passageId: number,
  text: string,
): Promise<boolean> {
  const allowed = db
    .prepare<[number], { found: number }>(
      `SELECT 1 AS found FROM evidence_passage p
       WHERE p.id = ? AND p.recall_status = 'allowed'
         AND NOT EXISTS (
           SELECT 1 FROM candidate_evidence ce
           JOIN memory_candidate mc ON mc.id = ce.candidate_id
           WHERE ce.passage_id = p.id AND mc.kind = 'facet'
             AND mc.status IN ('pending','rejected')
         )`,
    )
    .get(passageId);
  if (!allowed) return false;
  const vector = await embed(text);
  if (!vector) return false;
  db.prepare<[number, Buffer, number, string, string]>(
    `INSERT INTO passage_embedding (passage_id, vec, dim, model, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (passage_id) DO UPDATE SET
       vec = excluded.vec, dim = excluded.dim,
       model = excluded.model, created_at = excluded.created_at`,
  ).run(passageId, toBlob(vector), vector.length, EMBEDDING_MODEL, now());
  return true;
}

export async function embedFacet(db: Db, facetId: number, text: string): Promise<boolean> {
  const current = db
    .prepare<[number], { found: number }>(
      "SELECT 1 AS found FROM understanding_facet WHERE id = ? AND valid_to IS NULL",
    )
    .get(facetId);
  if (!current) return false;
  const vector = await embed(text);
  if (!vector) return false;
  db.prepare<[number, Buffer, number, string, string]>(
    `INSERT INTO facet_embedding (facet_id, vec, dim, model, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (facet_id) DO UPDATE SET
       vec = excluded.vec, dim = excluded.dim,
       model = excluded.model, created_at = excluded.created_at`,
  ).run(facetId, toBlob(vector), vector.length, EMBEDDING_MODEL, now());
  return true;
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
           WHERE ce.passage_id = p.id AND mc.kind = 'facet'
             AND mc.status IN ('pending','rejected')
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

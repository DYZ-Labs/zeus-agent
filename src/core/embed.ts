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

  const output = await extractor(trimmed, { pooling: "mean", normalize: true });
  return output.data instanceof Float32Array
    ? output.data
    : Float32Array.from(output.data as number[]);
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

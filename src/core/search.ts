import type { Db } from "./db";
import { embed, loadVectors, nearest } from "./embed";
import { getFacts } from "./facts";
import type { FactView, SearchHit } from "./schema";

/**
 * Hybrid retrieval.
 *
 * Three paths, because each fails differently. Lexical search nails names and exact
 * terms but misses paraphrase. Semantic search handles "what do I like to eat" →
 * "vegetarian" but drifts on proper nouns. Graph expansion catches what neither does:
 * facts that are relevant because of who or what the question mentions, even when the
 * wording shares nothing.
 */

type Via = SearchHit["via"][number];

/** Rank-based fusion constant. 60 is the standard value from the RRF literature. */
const RRF_K = 60;

/** Per-path candidate depth before fusion. */
const CANDIDATES = 50;

export type SearchOptions = {
  limit?: number;
  /** Include facts that are no longer true. Off by default. */
  includeSuperseded?: boolean;
  /** Reuse an embedding already computed by the turn orchestrator. */
  queryVector?: Float32Array | null;
};

/**
 * Reduce text to lowercase words separated by single spaces.
 *
 * Stripping *all* punctuation is the load-bearing part. Questions end in "?" and names
 * get trailing commas, and without this both the FTS terms and the entity-alias scan
 * below silently miss ("acme?" never matches the alias "acme").
 */
function normalizeForMatch(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * FTS5 is strict about its query syntax — a stray quote or a bare `AND` is a syntax
 * error, and user questions contain both. Quote each term and OR them together so
 * arbitrary prose is always a valid query.
 */
export function toFtsQuery(raw: string): string | null {
  const terms = normalizeForMatch(raw)
    .split(" ")
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));

  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "to", "of", "in", "on", "at", "for", "with", "about", "my",
  "me", "i", "you", "it", "that", "this", "what", "who", "where", "when", "how",
  "am", "as", "by", "from", "if", "so", "up", "we", "our", "us",
]);

function lexicalCandidates(db: Db, query: string, live: string): number[] {
  const match = toFtsQuery(query);
  if (!match) return [];

  try {
    return db
      .prepare<[string, number], { id: number }>(
        `SELECT f.id AS id
         FROM fact_fts
         JOIN fact f ON f.id = fact_fts.rowid
         WHERE fact_fts MATCH ? ${live}
         ORDER BY bm25(fact_fts)
         LIMIT ?`,
      )
      .all(match, CANDIDATES)
      .map((row) => row.id);
  } catch {
    // A malformed MATCH should degrade recall, not take the whole query down.
    return [];
  }
}

async function semanticCandidates(
  db: Db,
  query: string,
  queryVector?: Float32Array | null,
): Promise<number[]> {
  const vector = queryVector === undefined ? await embed(query) : queryVector;
  if (!vector) return [];

  const vectors = loadVectors(db, "fact");
  if (vectors.length === 0) return [];

  return nearest(vector, vectors, CANDIDATES).map((hit) => hit.ownerId);
}

/**
 * Facts reachable from entities named in the query, plus one hop along the graph.
 *
 * One hop, not two: at two hops almost everything in a personal memory is connected
 * to everything else, and the expansion stops being evidence of relevance.
 */
function graphCandidates(db: Db, query: string, live: string): number[] {
  const seeds = entitiesMentioned(db, query);
  if (seeds.length === 0) return [];

  const placeholders = seeds.map(() => "?").join(",");
  const direct = db
    .prepare<number[], { id: number; neighbour: number | null }>(
      `SELECT f.id AS id, f.object_entity_id AS neighbour
       FROM fact f
       WHERE (f.subject_id IN (${placeholders}) OR f.object_entity_id IN (${placeholders}))
       ${live}
       LIMIT ?`,
    )
    .all(...seeds, ...seeds, CANDIDATES);

  const ids = direct.map((row) => row.id);

  // One hop: facts about the entities those first facts pointed at.
  const neighbours = [
    ...new Set(direct.map((row) => row.neighbour).filter((id): id is number => id !== null)),
  ].filter((id) => !seeds.includes(id));

  if (neighbours.length > 0) {
    const hopPlaceholders = neighbours.map(() => "?").join(",");
    const hop = db
      .prepare<number[], { id: number }>(
        `SELECT f.id AS id FROM fact f
         WHERE f.subject_id IN (${hopPlaceholders}) ${live}
         LIMIT ?`,
      )
      .all(...neighbours, CANDIDATES);
    ids.push(...hop.map((row) => row.id));
  }

  return ids;
}

/**
 * Find entities the query names, by scanning known aliases against the query text.
 *
 * Matching aliases against the query (rather than tokenizing the query and looking up
 * each token) is what makes multi-word names like "Sarah Chen" work.
 */
export function entitiesMentioned(db: Db, query: string): number[] {
  const folded = ` ${normalizeForMatch(query)} `;
  const rows = db
    .prepare<[], { entity_id: number; alias: string }>(
      "SELECT entity_id, alias FROM entity_alias",
    )
    .all();

  const matched = new Set<number>();
  for (const row of rows) {
    if (row.alias.length < 3) continue; // "i", "me" would match everything
    if (folded.includes(` ${normalizeForMatch(row.alias)} `)) {
      matched.add(row.entity_id);
    }
  }
  return [...matched];
}

/** Reciprocal Rank Fusion: combine ranked lists without tuning per-path weights. */
function fuse(lists: { via: Via; ids: readonly number[] }[]): Map<number, { score: number; via: Via[] }> {
  const fused = new Map<number, { score: number; via: Via[] }>();

  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const existing = fused.get(id) ?? { score: 0, via: [] };
      existing.score += 1 / (RRF_K + index + 1);
      if (!existing.via.includes(list.via)) existing.via.push(list.via);
      fused.set(id, existing);
    });
  }

  return fused;
}

/**
 * Search the memory. Returns facts ranked by fused relevance, each tagged with the
 * paths that surfaced it — which is what makes bad recall debuggable rather than
 * mysterious.
 */
export async function search(
  db: Db,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = options.limit ?? 20;
  const live = options.includeSuperseded ? "" : "AND f.valid_to IS NULL";
  const liveLexical = options.includeSuperseded ? "" : "AND f.valid_to IS NULL";

  const [lexical, semantic] = await Promise.all([
    Promise.resolve(lexicalCandidates(db, query, liveLexical)),
    semanticCandidates(db, query, options.queryVector),
  ]);
  const graph = graphCandidates(db, query, live);

  const fused = fuse([
    { via: "lexical", ids: lexical },
    { via: "semantic", ids: filterLive(db, semantic, options.includeSuperseded ?? false) },
    { via: "graph", ids: graph },
  ]);

  if (fused.size === 0) return [];

  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
  const facts = new Map(getFacts(db, ranked.map(([id]) => id)).map((fact) => [fact.id, fact]));

  return ranked
    .map(([id, entry]): SearchHit | null => {
      const fact = facts.get(id);
      if (!fact) return null;
      return { fact, score: entry.score, via: entry.via };
    })
    .filter((hit): hit is SearchHit => hit !== null);
}

/** The vector index has no notion of validity, so live-filter its results here. */
function filterLive(db: Db, ids: readonly number[], includeSuperseded: boolean): number[] {
  if (includeSuperseded || ids.length === 0) return [...ids];
  const placeholders = ids.map(() => "?").join(",");
  const alive = new Set(
    db
      .prepare<number[], { id: number }>(
        `SELECT id FROM fact WHERE id IN (${placeholders}) AND valid_to IS NULL`,
      )
      .all(...ids)
      .map((row) => row.id),
  );
  return ids.filter((id) => alive.has(id));
}

/** Everything currently known about the entities a question names. */
export function dossier(db: Db, query: string, limit = 40): FactView[] {
  const ids = graphCandidates(db, query, "AND f.valid_to IS NULL").slice(0, limit);
  return getFacts(db, ids);
}

import type { Db } from "./db";
import { embed, loadPassageVectors, nearest } from "./embed";
import type { EpisodeHit, Message } from "./schema";
import { toFtsQuery } from "./search";

const CANDIDATES = 40;
const RRF_K = 60;

/** Message text has a wider distribution than atomic facts; calibrate independently. */
export const EPISODE_SEMANTIC_FLOOR = Number(
  process.env.ZEUS_EPISODE_SEMANTIC_FLOOR ?? 0.52,
);

type EpisodeRow = Message & {
  passage_id: number;
  start_offset: number;
  end_offset: number;
  passage_text: string;
  conversation_title: string | null;
};

export type EpisodeSearchOptions = {
  limit?: number;
  excludeMessageIds?: readonly number[];
  queryVector?: Float32Array | null;
};

export async function searchEpisodes(
  db: Db,
  query: string,
  options: EpisodeSearchOptions = {},
): Promise<EpisodeHit[]> {
  const excluded = new Set(options.excludeMessageIds ?? []);
  const [lexical, semantic] = await Promise.all([
    Promise.resolve(filterExcludedPassages(db, lexicalCandidates(db, query), excluded)),
    semanticCandidates(db, query, options.queryVector).then((ids) =>
      filterExcludedPassages(db, ids, excluded),
    ),
  ]);

  const fused = new Map<number, { score: number; via: EpisodeHit["via"] }>();
  for (const [via, ids] of [
    ["lexical", lexical],
    ["semantic", semantic],
  ] as const) {
    ids.forEach((id, index) => {
      const current = fused.get(id) ?? { score: 0, via: [] };
      current.score += 1 / (RRF_K + index + 1);
      if (!current.via.includes(via)) current.via.push(via);
      fused.set(id, current);
    });
  }

  const ranked = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, options.limit ?? 5);
  if (ranked.length === 0) return [];

  const placeholders = ranked.map(() => "?").join(",");
  const rows = db
    .prepare<number[], EpisodeRow>(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
              m.origin, m.recall_state, m.cross_chat_recall_eligible,
              p.id AS passage_id,
              p.start_offset, p.end_offset, p.text AS passage_text,
              c.title AS conversation_title
       FROM evidence_passage p
       JOIN message m ON m.id = p.message_id
       JOIN conversation c ON c.id = m.conversation_id
       WHERE p.id IN (${placeholders}) AND p.recall_status = 'allowed'
         AND m.role = 'user'
         AND m.cross_chat_recall_eligible = 1
         AND NOT EXISTS (
           SELECT 1 FROM candidate_evidence ce
           JOIN memory_candidate mc ON mc.id = ce.candidate_id
           WHERE ce.passage_id = p.id AND mc.status IN ('pending','rejected')
         )
         AND COALESCE(c.title, '') != 'Memory curation'
         AND m.origin IN ('conversation','reflection','backfill')`,
    )
    .all(...ranked.map(([id]) => id));
  const byId = new Map(rows.map((row) => [row.passage_id, row]));

  return ranked.flatMap(([id, rank]) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        message: {
          id: row.id,
          conversation_id: row.conversation_id,
          role: row.role,
          // Least-disclosure projection: callers get source identity and dates, but
          // never neighbouring text outside the classified passage.
          content: row.passage_text,
          created_at: row.created_at,
          origin: row.origin,
          recall_state: row.recall_state,
          cross_chat_recall_eligible: row.cross_chat_recall_eligible,
        },
        passage_id: row.passage_id,
        start_offset: row.start_offset,
        end_offset: row.end_offset,
        conversation_title: row.conversation_title,
        excerpt: excerpt(row.passage_text),
        score: rank.score,
        via: rank.via,
      },
    ];
  });
}

function lexicalCandidates(db: Db, query: string): number[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  try {
    return db
      .prepare<[string, number], { id: number }>(
      `SELECT p.id AS id
         FROM passage_fts
         JOIN evidence_passage p ON p.id = passage_fts.rowid
         JOIN message m ON m.id = p.message_id
         JOIN conversation c ON c.id = m.conversation_id
         WHERE passage_fts MATCH ? AND p.recall_status = 'allowed' AND m.role = 'user'
           AND NOT EXISTS (
             SELECT 1 FROM candidate_evidence ce
             JOIN memory_candidate mc ON mc.id = ce.candidate_id
             WHERE ce.passage_id = p.id AND mc.status IN ('pending','rejected')
           )
           AND COALESCE(c.title, '') != 'Memory curation'
           AND m.origin IN ('conversation','reflection','backfill')
         ORDER BY bm25(passage_fts)
         LIMIT ?`,
      )
      .all(match, CANDIDATES)
      .map((row) => row.id);
  } catch {
    return [];
  }
}

function filterExcludedPassages(
  db: Db,
  passageIds: readonly number[],
  excludedMessageIds: ReadonlySet<number>,
): number[] {
  if (passageIds.length === 0 || excludedMessageIds.size === 0) return [...passageIds];
  const placeholders = passageIds.map(() => "?").join(",");
  const rows = db
    .prepare<number[], { id: number; message_id: number }>(
      `SELECT id, message_id FROM evidence_passage WHERE id IN (${placeholders})`,
    )
    .all(...passageIds);
  const allowed = new Set(
    rows.filter((row) => !excludedMessageIds.has(row.message_id)).map((row) => row.id),
  );
  return passageIds.filter((id) => allowed.has(id));
}

async function semanticCandidates(
  db: Db,
  query: string,
  queryVector?: Float32Array | null,
): Promise<number[]> {
  const vector = queryVector === undefined ? await embed(query) : queryVector;
  if (!vector) return [];
  const nearestIds = nearest(
    vector,
    loadPassageVectors(db),
    CANDIDATES * 2,
    EPISODE_SEMANTIC_FLOOR,
  ).map((hit) => hit.ownerId);
  if (nearestIds.length === 0) return [];
  return nearestIds.slice(0, CANDIDATES);
}

function excerpt(content: string, limit = 520): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

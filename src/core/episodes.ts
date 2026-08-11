import type { Db } from "./db";
import { embed, loadVectors, nearest } from "./embed";
import type { EpisodeHit, Message } from "./schema";
import { toFtsQuery } from "./search";

const CANDIDATES = 40;
const RRF_K = 60;

/** Message text has a wider distribution than atomic facts; calibrate independently. */
export const EPISODE_SEMANTIC_FLOOR = Number(
  process.env.ZEUS_EPISODE_SEMANTIC_FLOOR ?? 0.52,
);

type EpisodeRow = Message & { conversation_title: string | null };

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
    Promise.resolve(lexicalCandidates(db, query).filter((id) => !excluded.has(id))),
    semanticCandidates(db, query, options.queryVector).then((ids) =>
      ids.filter((id) => !excluded.has(id)),
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
              c.title AS conversation_title
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       WHERE m.id IN (${placeholders}) AND m.role = 'user'
         AND COALESCE(c.title, '') != 'Memory curation'
         AND NOT EXISTS (
           SELECT 1 FROM memory_candidate mc
           WHERE mc.source_message_id = m.id
             AND mc.reason = 'sensitive' AND mc.status != 'accepted'
         )`,
    )
    .all(...ranked.map(([id]) => id));
  const byId = new Map(rows.map((row) => [row.id, row]));

  return ranked.flatMap(([id, rank]) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        message: {
          id: row.id,
          conversation_id: row.conversation_id,
          role: row.role,
          content: row.content,
          created_at: row.created_at,
        },
        conversation_title: row.conversation_title,
        excerpt: excerpt(row.content),
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
        `SELECT m.id AS id
         FROM message_fts
         JOIN message m ON m.id = message_fts.rowid
         JOIN conversation c ON c.id = m.conversation_id
         WHERE message_fts MATCH ? AND m.role = 'user'
           AND COALESCE(c.title, '') != 'Memory curation'
           AND NOT EXISTS (
             SELECT 1 FROM memory_candidate mc
             WHERE mc.source_message_id = m.id
               AND mc.reason = 'sensitive' AND mc.status != 'accepted'
           )
         ORDER BY bm25(message_fts)
         LIMIT ?`,
      )
      .all(match, CANDIDATES)
      .map((row) => row.id);
  } catch {
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
  const nearestIds = nearest(
    vector,
    loadVectors(db, "message"),
    CANDIDATES * 2,
    EPISODE_SEMANTIC_FLOOR,
  ).map((hit) => hit.ownerId);
  if (nearestIds.length === 0) return [];

  const placeholders = nearestIds.map(() => "?").join(",");
  const userIds = new Set(
    db
      .prepare<number[], { id: number }>(
        `SELECT m.id FROM message m
         JOIN conversation c ON c.id = m.conversation_id
         WHERE m.id IN (${placeholders}) AND m.role = 'user'
           AND COALESCE(c.title, '') != 'Memory curation'
           AND NOT EXISTS (
             SELECT 1 FROM memory_candidate mc
             WHERE mc.source_message_id = m.id
               AND mc.reason = 'sensitive' AND mc.status != 'accepted'
           )`,
      )
      .all(...nearestIds)
      .map((row) => row.id),
  );
  return nearestIds.filter((id) => userIds.has(id)).slice(0, CANDIDATES);
}

function excerpt(content: string, limit = 520): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

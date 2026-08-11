import type { Db } from "./db";
import { now } from "./db";
import { searchEpisodes } from "./episodes";
import { embed } from "./embed";
import { selfEntity } from "./entities";
import { evidenceForFact, factsForEntity } from "./facts";
import { getCommitment, getGoal, listCommitments, listGoals } from "./intentions";
import type {
  CommitmentView,
  EpisodeHit,
  FactView,
  FollowThroughRecommendation,
  Goal,
  RecallItem,
  SearchHit,
} from "./schema";
import { search } from "./search";
import { recommendNextAction } from "./stewardship";

export type MemoryContext = {
  text: string;
  hits: SearchHit[];
  episodes: EpisodeHit[];
  core: FactView[];
  goals: Goal[];
  commitments: CommitmentView[];
  recommendation: FollowThroughRecommendation | null;
  /** Compatibility alias for callers that only need the selected commitment. */
  nudge: CommitmentView | null;
  items: RecallItem[];
  /** Shared query embedding; the turn stores it as the current user episode. */
  queryVector: Float32Array | null;
};

function formatFact(fact: FactView): string {
  const subject = fact.subject_slug === "self" ? "You" : fact.subject_name;
  const predicate = fact.predicate.replace(/_/gu, " ");
  const learned = fact.created_at.slice(0, 10);
  const applies = fact.valid_from.slice(0, 10);
  const timing = applies === learned ? `learned ${learned}` : `effective ${applies}, learned ${learned}`;
  const closed = fact.valid_to ? `, no longer true as of ${fact.valid_to.slice(0, 10)}` : "";
  const confidence = fact.confidence >= 0.9 ? "" : `, confidence ${fact.confidence.toFixed(2)}`;
  return `- [fact:${fact.id}] ${escapeMemory(subject)} ${escapeMemory(predicate)}: ${escapeMemory(fact.object)} (${timing}${closed}${confidence})`;
}

export function coreFacts(db: Db, limit = 12): FactView[] {
  const me = selfEntity(db);
  const priority = new Set([
    "works_at",
    "job_title",
    "lives_in",
    "timezone",
    "birthday",
    "goal",
    "prefers",
    "cares_about",
  ]);
  return factsForEntity(db, me.id, { limit: 200 })
    .sort((a, b) => {
      const predicate = Number(priority.has(b.predicate)) - Number(priority.has(a.predicate));
      return predicate || b.confidence - a.confidence || b.last_seen_at.localeCompare(a.last_seen_at);
    })
    .slice(0, limit);
}

export type BuildContextOptions = {
  limit?: number;
  coreLimit?: number;
  episodeLimit?: number;
  excludeMessageIds?: readonly number[];
  queryVector?: Float32Array | null;
};

export async function buildContext(
  db: Db,
  query: string,
  options: BuildContextOptions = {},
): Promise<MemoryContext> {
  const queryVector =
    options.queryVector === undefined ? await embed(query) : options.queryVector;
  const [queryHits, queryEpisodes] = await Promise.all([
    search(db, query, {
      limit: options.limit ?? 16,
      includeSuperseded: asksAboutHistory(query),
      queryVector,
    }),
    searchEpisodes(db, query, {
      limit: options.episodeLimit ?? 4,
      excludeMessageIds: options.excludeMessageIds,
      queryVector,
    }),
  ]);
  const core = coreFacts(db, options.coreLimit ?? 12);
  const goals = listGoals(db, { limit: 8 });
  const commitments = listCommitments(db, { limit: 10 });
  const recommendation = recommendNextAction(db, query);
  const followThroughQuery = recommendation
    ? `${recommendation.commitment_title} ${recommendation.goal_title ?? ""}`
    : null;
  const [followThroughHits, followThroughEpisodes] = followThroughQuery
    ? await Promise.all([
        search(db, followThroughQuery, { limit: 6, queryVector: null }),
        searchEpisodes(db, followThroughQuery, {
          limit: 2,
          excludeMessageIds: options.excludeMessageIds,
          queryVector: null,
        }),
      ])
    : [[], []];
  const hits = [
    ...new Map(
      [...queryHits, ...followThroughHits].map((hit) => [hit.fact.id, hit]),
    ).values(),
  ];
  const episodes = [
    ...new Map(
      [...queryEpisodes, ...followThroughEpisodes].map((episode) => [
        episode.message.id,
        episode,
      ]),
    ).values(),
  ];
  const nudge = recommendation ? getCommitment(db, recommendation.commitment_id) : null;
  const recommendedGoal = recommendation?.goal_id ? getGoal(db, recommendation.goal_id) : null;
  const tracedGoals =
    recommendedGoal && !goals.some((goal) => goal.id === recommendedGoal.id)
      ? [...goals, recommendedGoal]
      : goals;
  const tracedCommitments =
    nudge && !commitments.some((item) => item.id === nudge.id)
      ? [...commitments, nudge]
      : commitments;

  const coreIds = new Set(core.map((fact) => fact.id));
  const retrieved = hits.filter((hit) => !coreIds.has(hit.fact.id));
  const sections: string[] = [];

  if (core.length > 0) {
    sections.push(
      `CANONICAL FACTS ABOUT THE USER — What you know about the user:\n${core.map(formatFact).join("\n")}`,
    );
  }
  if (retrieved.length > 0) {
    sections.push(
      `CANONICAL FACTS RELEVANT TO THIS QUESTION${recommendation ? " OR FOLLOW-THROUGH" : ""}:\n${retrieved.map((hit) => formatFact(hit.fact)).join("\n")}`,
    );
  }
  if (episodes.length > 0) {
    sections.push(
      `DATED EPISODES — these are user-authored recollections, not guaranteed current facts:\n${episodes
        .map(
          (episode) =>
            `- [episode:${episode.message.id}] On ${episode.message.created_at.slice(0, 10)}, the user said: “${escapeMemory(episode.excerpt)}”`,
        )
        .join("\n")}`,
    );
  }
  if (goals.length > 0) {
    sections.push(
      `ACTIVE GOALS:\n${goals
        .map(
          (goal) =>
            `- [goal:${goal.id}] ${escapeMemory(goal.title)} — ${goal.status}, ${goal.priority} priority${goal.target_at ? `, target ${goal.target_at.slice(0, 10)}` : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (commitments.length > 0) {
    sections.push(
      `OPEN COMMITMENTS:\n${commitments
        .map(
          (item) =>
            `- [commitment:${item.id}] ${escapeMemory(item.title)} — ${item.status}, owner ${escapeMemory(item.owner_name)}${item.due_at ? `, due ${item.due_at.slice(0, 10)}` : ""}`,
        )
        .join("\n")}`,
    );
  }
  if (recommendation) {
    sections.push(
      `FOLLOW-THROUGH OPPORTUNITY — a system proposal, not a fact about the user:\n- [commitment:${recommendation.commitment_id}] ${escapeMemory(recommendation.commitment_title)}${recommendation.due_at ? `, due ${recommendation.due_at.slice(0, 10)}` : ""}\n- WHY NOW: ${escapeMemory(recommendation.why)}\n- USEFUL NEXT ACTION: ${escapeMemory(recommendation.suggested_action)}\nFirst answer the user's request. Offer this next step only if it helps rather than derails them. You may draft, research, or plan in the conversation; sending, scheduling, purchasing, reminding, or coordinating externally always requires explicit confirmation.`,
    );
  }

  const facts = [...core, ...retrieved.map((hit) => hit.fact)];
  const uniqueFacts = [...new Map(facts.map((fact) => [fact.id, fact])).values()];
  const items: RecallItem[] = [
    ...uniqueFacts.map((fact): RecallItem => ({
      kind: "fact",
      fact,
      evidence: evidenceForFact(db, fact.id),
    })),
    ...episodes.map((episode): RecallItem => ({ kind: "episode", episode })),
    ...tracedGoals.map((goal): RecallItem => ({ kind: "goal", goal })),
    ...tracedCommitments.map(
      (commitment): RecallItem => ({ kind: "commitment", commitment }),
    ),
  ];

  return {
    text:
      sections.length > 0
        ? sections.join("\n\n")
        : "Zeus found nothing relevant in accepted memory for this question.",
    hits,
    episodes,
    core,
    goals: tracedGoals,
    commitments: tracedCommitments,
    recommendation,
    nudge,
    items,
    queryVector,
  };
}

export function renderMemoryBlock(context: MemoryContext): string {
  return `<memory>\n${context.text}\n</memory>`;
}

/** Persist exactly what the model saw for a response, for later provenance inspection. */
export function recordResponseContext(
  db: Db,
  assistantMessageId: number,
  items: readonly RecallItem[],
): void {
  const insert = db.prepare<[number, string, number, number, string, string]>(
    `INSERT OR IGNORE INTO response_context
       (assistant_message_id, item_kind, item_id, rank, created_at, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    items.forEach((item, rank) => {
      const id =
        item.kind === "fact"
          ? item.fact.id
          : item.kind === "episode"
            ? item.episode.message.id
            : item.kind === "goal"
              ? item.goal.id
              : item.commitment.id;
      insert.run(assistantMessageId, item.kind, id, rank, now(), JSON.stringify(item));
    });
  })();
}

function escapeMemory(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function asksAboutHistory(query: string): boolean {
  return /\b(before|formerly|history|historical|past|previous|previously|prior|used to|no longer|back when)\b/iu.test(
    query,
  );
}

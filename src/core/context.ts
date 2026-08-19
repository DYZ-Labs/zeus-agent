import type { Db } from "./db";
import { now } from "./db";
import { buildEvaluationContextForTrigger } from "./ambient";
import { searchEpisodes } from "./episodes";
import { embed } from "./embed";
import { selfEntity } from "./entities";
import {
  evidenceForFacet,
  interactionFacets,
  listFacets,
  searchFacets,
  type FacetSearchHit,
} from "./facets";
import { evidenceForFact, factsForEntity } from "./facts";
import { getCommitment, getGoal, listCommitments, listGoals } from "./intentions";
import { computePersonalizationProfile } from "./personalization";
import { listProjects } from "./projects";
import type {
  CommitmentView,
  CommitmentEvent,
  ContextIntent,
  ContextPlan,
  ContextSelection,
  EpisodeHit,
  FactView,
  FollowThroughRecommendation,
  Goal,
  GoalEvent,
  ProjectView,
  ProjectEvent,
  RecallItem,
  SearchHit,
  EvaluationContext,
  UnderstandingFacetView,
} from "./schema";
import { entitiesMentioned, search } from "./search";
import {
  evaluateOpportunity,
  getStewardshipSetting,
  isExplicitTrigger,
  recommendationForOpportunity,
  structuredFacetConditionMatches,
} from "./stewardship";
import { StructuredFacetCondition as StructuredFacetConditionSchema } from "./schema";

const DEFAULT_MEMORY_BUDGET = 3_000;
const MAX_MEMORY_BUDGET = 3_000;
const DEFAULT_INTERACTION_BUDGET = 400;
const MAX_INTERACTION_BUDGET = 400;

type SelectionReason = ContextSelection["reason"];
type RetrievalPath = ContextSelection["via"][number];

export type FieldProvenanceSource = {
  event_id: number | null;
  source_message_id: number | null;
  passage_id?: number | null;
  source_kind: "message" | "user_action" | "system";
  recorded_at: string;
};

export type IntentFieldProvenance =
  | {
      kind: "goal";
      fields: Record<
        "title" | "status" | "priority" | "target_at" | "project_id" | "confidence",
        FieldProvenanceSource
      >;
    }
  | {
      kind: "commitment";
      fields: Record<
        | "title"
        | "owner_entity_id"
        | "linked_goal_id"
        | "project_id"
        | "status"
        | "due_at"
        | "snoozed_until"
        | "confidence",
        FieldProvenanceSource
      >;
    }
  | {
      kind: "project";
      fields: Record<
        "entity_id" | "status" | "progress_summary" | "progress_percent" | "blocked_at" | "confidence",
        FieldProvenanceSource
      >;
    };

type PlannedCandidate = ContextSelection & {
  formatted: string;
  interaction: boolean;
};

export type MemoryContext = {
  text: string;
  hits: SearchHit[];
  episodes: EpisodeHit[];
  /** Compatibility field: facts actually selected by the planner, never an unconditional profile. */
  core: FactView[];
  goals: Goal[];
  commitments: CommitmentView[];
  projects: ProjectView[];
  facets: UnderstandingFacetView[];
  recommendation: FollowThroughRecommendation | null;
  /**
   * Durable recommendation-cycle id shared by every delivery channel.
   *
   * Null when the turn never evaluated one: mode `off` and nothing explicitly requested.
   * There is no recommendation to deliver, so there is nothing to record a delivery against.
   */
  opportunityId: number | null;
  /** Compatibility alias for callers that only need the selected commitment. */
  nudge: CommitmentView | null;
  items: RecallItem[];
  plan: ContextPlan;
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

function formatEpisode(episode: EpisodeHit): string {
  const passage = episode.passage_id === null ? `legacy-message:${episode.message.id}` : String(episode.passage_id);
  const offsets = episode.start_offset === null || episode.end_offset === null
    ? ""
    : `, offsets ${episode.start_offset}-${episode.end_offset}`;
  return `- [episode:${passage}] On ${episode.message.created_at.slice(0, 10)} (source message ${episode.message.id}${offsets}), the user said: “${escapeMemory(episode.excerpt)}”`;
}

function formatGoal(goal: Goal): string {
  return `- [goal:${goal.id}] ${escapeMemory(goal.title)} — ${goal.status}, ${goal.priority} priority${goal.target_at ? `, target ${goal.target_at.slice(0, 10)}` : ""}`;
}

function formatCommitment(item: CommitmentView): string {
  return `- [commitment:${item.id}] ${escapeMemory(item.title)} — ${item.status}, owner ${escapeMemory(item.owner_name)}${item.due_at ? `, due ${item.due_at.slice(0, 10)}` : ""}`;
}

function formatProject(project: ProjectView): string {
  const progress = project.progress_percent === null
    ? ""
    : `, ${Math.round(project.progress_percent * 100)}% complete`;
  const blocked = project.blocked_at ? ", blocked" : "";
  const summary = project.progress_summary ? ` — ${escapeMemory(project.progress_summary)}` : "";
  return `- [project:${project.id}] ${escapeMemory(project.entity_name)} — ${project.status}${progress}${blocked}${summary}`;
}

function formatFacet(facet: UnderstandingFacetView): string {
  const kind = facet.kind.replace(/_/gu, " ");
  const scope = facetScopeLabel(facet);
  const condition = facet.condition_text
    ? `; applies when ${escapeMemory(facet.condition_text)}`
    : "";
  const structuredCondition = facet.condition_json
    ? `; typed condition ${escapeMemory(facet.condition_json)}`
    : "";
  const confidence = facet.confidence >= 0.9 ? "" : `; confidence ${facet.confidence.toFixed(2)}`;
  return `- [facet:${facet.id}] ${escapeMemory(kind)} (${escapeMemory(scope)}): ${escapeMemory(facet.statement)}${condition}${structuredCondition}${confidence}`;
}

/** Retained as a curation/read helper; buildContext deliberately does not inject it. */
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
  /** Compatibility option. This now caps selected facts rather than injecting core facts. */
  coreLimit?: number;
  episodeLimit?: number;
  excludeMessageIds?: readonly number[];
  queryVector?: Float32Array | null;
  /** Stored user query that owns the chat recommendation-cycle trace, when applicable. */
  querySourceMessageId?: number | null;
  memoryBudgetTokens?: number;
  interactionBudgetTokens?: number;
  /**
   * The turn's own evaluation context.
   *
   * Supplied by the caller so a single turn resolves "now" once. The fallback reads the
   * ambient setting, whose timezone defaults to UTC — fine for a background trigger that has
   * no other source, wrong for a chat turn whose browser reported a real zone, and silently
   * wrong in a way that lands on facet conditions and relative dates alike.
   */
  evaluationContext?: EvaluationContext;
};

export function inferContextIntent(query: string): ContextIntent {
  if (asksAboutHistory(query)) return "historical";
  if (/\b(decid(?:e|ing)|choice|choose|which option|trade[ -]?offs?|compare|versus|\bvs\b)\b/iu.test(query)) {
    return "decision";
  }
  if (/\b(follow[ -]?through|next action|what(?:'s| is) next|commitments?|to[ -]?do|deadlines?|due|on track|priorities|goals?)\b/iu.test(query)) {
    return "follow_through";
  }
  if (/\b(should i|what should|how (?:can|should) i|advice|advise|recommend|help me|plan for)\b/iu.test(query)) {
    return "advisory";
  }
  if (/\b(relationship|friend|partner|spouse|parent|child|sibling|manager|coworker|colleague|client|team|who (?:is|are)|with [\p{Lu}])\b/u.test(query)) {
    return "relational";
  }
  return "factual";
}

export async function buildContext(
  db: Db,
  query: string,
  options: BuildContextOptions = {},
): Promise<MemoryContext> {
  const intent = inferContextIntent(query);
  const budgetTokens = boundedBudget(options.memoryBudgetTokens, DEFAULT_MEMORY_BUDGET, MAX_MEMORY_BUDGET);
  const interactionBudget = boundedBudget(
    options.interactionBudgetTokens,
    DEFAULT_INTERACTION_BUDGET,
    MAX_INTERACTION_BUDGET,
  );
  const queryVector = options.queryVector === undefined ? await embed(query) : options.queryVector;
  const personalization = computePersonalizationProfile(db);
  const evaluationContext =
    options.evaluationContext ?? buildEvaluationContextForTrigger(db, "chat");
  // In mode `off` an unrequested turn does not open a recommendation cycle at all.
  // `evaluateRecommendations` would already return nothing, so this changes no answer — it
  // stops the row. A cycle is a durable record that Zeus considered interrupting, and
  // writing one per ordinary turn under a mode that forbids interrupting is a ledger of a
  // decision never taken. Explicit triggers keep evaluating, which is what preserves
  // "what should I do next" as the mode default moves to `off`.
  const cycle =
    getStewardshipSetting(db).mode !== "off" ||
    isExplicitTrigger(evaluationContext.trigger, query)
      ? evaluateOpportunity(
          db,
          evaluationContext,
          query,
          { sourceMessageId: options.querySourceMessageId ?? null },
        )
      : null;
  const recommendation = cycle ? recommendationForOpportunity(db, cycle.id) : null;
  const followThroughQuery = recommendation
    ? `${recommendation.commitment_title} ${recommendation.goal_title ?? ""}`.trim()
    : null;

  const [queryHits, queryEpisodes, queryFacetHits, followThroughHits, followThroughEpisodes] =
    await Promise.all([
      search(db, query, {
        limit: Math.max(options.limit ?? 16, options.coreLimit ?? 0),
        includeSuperseded: intent === "historical",
        queryVector,
      }),
      searchEpisodes(db, query, {
        limit: options.episodeLimit ?? 6,
        excludeMessageIds: options.excludeMessageIds,
        queryVector,
      }),
      searchFacets(db, query, { limit: 20, queryVector }),
      followThroughQuery
        ? search(db, followThroughQuery, { limit: 6, queryVector: null })
        : Promise.resolve([]),
      followThroughQuery
        ? searchEpisodes(db, followThroughQuery, {
            limit: 2,
            excludeMessageIds: options.excludeMessageIds,
            queryVector: null,
          })
        : Promise.resolve([]),
    ]);

  const followThroughFacetHits = followThroughQuery
    ? await searchFacets(db, followThroughQuery, { limit: 8, queryVector: null })
    : [];
  const allGoals = listGoals(db, { includeClosed: intent === "historical", limit: 200 });
  const allCommitments = listCommitments(db, {
    includeClosed: intent === "historical",
    limit: 300,
  });
  const allProjects = listProjects(db, {
    includeClosed: intent === "historical",
    limit: 200,
  });
  const recommendedCommitment = recommendation
    ? getCommitment(db, recommendation.commitment_id)
    : null;
  const recommendedGoal = recommendation?.goal_id ? getGoal(db, recommendation.goal_id) : null;
  const entityIds = new Set(entitiesMentioned(db, `${query} ${followThroughQuery ?? ""}`));
  const relevantGoalIds = new Set<number>();
  const relevantCommitmentIds = new Set<number>();
  const relevantProjectIds = new Set<number>();
  const candidates = new Map<string, PlannedCandidate>();

  const addCandidate = (candidate: PlannedCandidate): void => {
    const key = recallKey(candidate.item);
    const previous = candidates.get(key);
    if (!previous) {
      candidates.set(key, candidate);
      return;
    }
    const interaction = previous.interaction || candidate.interaction;
    const reason = interaction ? "interaction_contract" : higherPriorityReason(previous.reason, candidate.reason);
    candidates.set(key, {
      ...(candidate.score > previous.score ? candidate : previous),
      reason,
      interaction,
      via: [...new Set([...previous.via, ...candidate.via])],
    });
  };

  for (const hit of dedupeFactHits(queryHits, followThroughHits)) {
    const item: RecallItem = {
      kind: "fact",
      fact: hit.fact,
      evidence: evidenceForFact(db, hit.fact.id),
    };
    const fromFollowThrough = !queryHits.some((queryHit) => queryHit.fact.id === hit.fact.id);
    addCandidate(
      candidateFor(item, formatFact(hit.fact), {
        reason: intent === "historical" && hit.fact.valid_to !== null
          ? "historical"
          : fromFollowThrough
            ? "follow_through"
            : "query_relevant",
        score: scoreFact(hit, intent, fromFollowThrough),
        via: hit.via,
      }),
    );
  }

  for (const episode of dedupeEpisodes(queryEpisodes, followThroughEpisodes)) {
    const fromFollowThrough = !queryEpisodes.some(
      (queryEpisode) => episodeIdentity(queryEpisode) === episodeIdentity(episode),
    );
    const item: RecallItem = { kind: "episode", episode };
    addCandidate(
      candidateFor(item, formatEpisode(episode), {
        reason: intent === "historical"
          ? "historical"
          : fromFollowThrough
            ? "follow_through"
            : "query_relevant",
        score: 46 + episode.score * 100 + (intent === "historical" ? 14 : 0),
        via: episode.via,
      }),
    );
  }

  const genericGoalRequest = /\b(goals?|priorities)\b/iu.test(query);
  const genericCommitmentRequest = /\b(commitments?|tasks?|to[ -]?do|open loops?|deadlines?)\b/iu.test(query);
  for (const goal of allGoals) {
    const overlap = tokenOverlap(query, goal.title);
    const related = recommendation?.goal_id === goal.id;
    if (!(overlap > 0 || genericGoalRequest || related)) continue;
    relevantGoalIds.add(goal.id);
    if (goal.project_id !== null) relevantProjectIds.add(goal.project_id);
    const item: RecallItem = { kind: "goal", goal };
    addCandidate(
      candidateFor(item, formatGoal(goal), {
        reason: related ? "follow_through" : "open_loop",
        score: related ? 96 : 52 + overlap * 10 + priorityBonus(goal.priority),
        via: related ? ["policy"] : ["lexical"],
      }),
    );
  }
  for (const commitment of allCommitments) {
    const overlap = tokenOverlap(query, `${commitment.title} ${commitment.goal_title ?? ""}`);
    const related = recommendation?.commitment_id === commitment.id;
    const relationalOwner = intent === "relational" && entityIds.has(commitment.owner_entity_id);
    if (!(overlap > 0 || genericCommitmentRequest || related || relationalOwner)) continue;
    relevantCommitmentIds.add(commitment.id);
    if (commitment.linked_goal_id !== null) relevantGoalIds.add(commitment.linked_goal_id);
    if (commitment.project_id !== null) relevantProjectIds.add(commitment.project_id);
    const item: RecallItem = { kind: "commitment", commitment };
    addCandidate(
      candidateFor(item, formatCommitment(commitment), {
        reason: related ? "follow_through" : "open_loop",
        score: related ? 98 : 54 + overlap * 10,
        via: related ? ["policy"] : relationalOwner ? ["graph"] : ["lexical"],
      }),
    );
  }
  if (recommendedGoal && !relevantGoalIds.has(recommendedGoal.id)) {
    relevantGoalIds.add(recommendedGoal.id);
    if (recommendedGoal.project_id !== null) relevantProjectIds.add(recommendedGoal.project_id);
    const item: RecallItem = { kind: "goal", goal: recommendedGoal };
    addCandidate(
      candidateFor(item, formatGoal(recommendedGoal), {
        reason: "follow_through",
        score: 96,
        via: ["policy"],
      }),
    );
  }
  if (recommendedCommitment && !relevantCommitmentIds.has(recommendedCommitment.id)) {
    relevantCommitmentIds.add(recommendedCommitment.id);
    if (recommendedCommitment.project_id !== null) {
      relevantProjectIds.add(recommendedCommitment.project_id);
    }
    const item: RecallItem = { kind: "commitment", commitment: recommendedCommitment };
    addCandidate(
      candidateFor(item, formatCommitment(recommendedCommitment), {
        reason: "follow_through",
        score: 98,
        via: ["policy"],
      }),
    );
  }

  const genericProjectRequest = /\b(projects?|initiatives?|workstreams?)\b/iu.test(query);
  for (const project of allProjects) {
    const overlap = tokenOverlap(query, `${project.entity_name} ${project.progress_summary ?? ""}`);
    const entityRelated = entityIds.has(project.entity_id);
    const linked = relevantProjectIds.has(project.id);
    if (!(genericProjectRequest || overlap > 0 || entityRelated || linked)) continue;
    relevantProjectIds.add(project.id);
    const item: RecallItem = { kind: "project", project };
    addCandidate(
      candidateFor(item, formatProject(project), {
        reason: linked ? "open_loop" : "query_relevant",
        score: linked ? 74 : 58 + overlap * 10 + (project.blocked_at ? 8 : 0),
        via: linked ? ["graph"] : entityRelated ? ["graph"] : ["lexical"],
      }),
    );
  }

  // Project relevance is a graph edge in both directions. A query may name only the
  // project while its source-backed goal and commitment use entirely different words;
  // bring that lifecycle cluster together rather than recalling an isolated label.
  for (const goal of allGoals) {
    if (goal.project_id === null || !relevantProjectIds.has(goal.project_id)) continue;
    relevantGoalIds.add(goal.id);
    const item: RecallItem = { kind: "goal", goal };
    addCandidate(
      candidateFor(item, formatGoal(goal), {
        reason: "open_loop",
        score: 72 + priorityBonus(goal.priority),
        via: ["graph"],
      }),
    );
  }
  for (const commitment of allCommitments) {
    if (commitment.project_id === null || !relevantProjectIds.has(commitment.project_id)) continue;
    relevantCommitmentIds.add(commitment.id);
    if (commitment.linked_goal_id !== null) relevantGoalIds.add(commitment.linked_goal_id);
    const item: RecallItem = { kind: "commitment", commitment };
    addCandidate(
      candidateFor(item, formatCommitment(commitment), {
        reason: "open_loop",
        score: 74,
        via: ["graph"],
      }),
    );
  }

  const facetHits = dedupeFacetHits(queryFacetHits, followThroughFacetHits);
  for (const hit of facetHits) {
    if (!facetScopeApplies(hit.facet, query, entityIds, relevantGoalIds, relevantCommitmentIds)) {
      continue;
    }
    if (!facetConditionApplies(
      hit.facet,
      `${query} ${followThroughQuery ?? ""}`,
      evaluationContext,
    )) continue;
    const evidence = evidenceForFacet(db, hit.facet.id);
    if (evidence.length === 0) continue;
    const fromFollowThrough = !queryFacetHits.some((entry) => entry.facet.id === hit.facet.id);
    const item: RecallItem = { kind: "facet", facet: hit.facet, evidence };
    addCandidate(
      candidateFor(item, formatFacet(hit.facet), {
        reason: fromFollowThrough ? "follow_through" : "query_relevant",
        score: scoreFacet(hit, intent, fromFollowThrough),
        via: hit.via,
      }),
    );
  }

  // Values and decision rules are intentionally eligible for advice even when the
  // user's wording does not repeat their original phrasing. This never runs for a
  // factual request, which prevents an unrelated personality profile from leaking in.
  if (intent === "advisory" || intent === "decision") {
    for (const facet of listFacets(db, {
      kinds: ["value", "decision_criterion", "constraint", "motivation", "preference"],
      limit: 12,
    })) {
      if (facet.scope_kind !== "global") continue;
      if (!facetConditionApplies(facet, query, evaluationContext)) continue;
      const evidence = evidenceForFacet(db, facet.id);
      if (evidence.length === 0) continue;
      const item: RecallItem = { kind: "facet", facet, evidence };
      addCandidate(
        candidateFor(item, formatFacet(facet), {
          reason: "query_relevant",
          score: 48 + importanceBonus(facet.importance) + facet.confidence * 8,
          via: ["policy"],
        }),
      );
    }
  }

  for (const hit of interactionFacets(db, 20)) {
    const facet = hit.facet;
    const domainApplies = facet.scope_kind === "global" ||
      (facet.scope_kind === "domain" && tokenOverlap(query, facet.scope_label ?? "") > 0);
    if (!domainApplies || !facetConditionApplies(facet, query, evaluationContext)) continue;
    const evidence = evidenceForFacet(db, facet.id);
    if (evidence.length === 0) continue;
    const item: RecallItem = { kind: "facet", facet, evidence };
    addCandidate(
      candidateFor(item, formatFacet(facet), {
        reason: "interaction_contract",
        score: 110 + importanceBonus(facet.importance) + facet.confidence * 5,
        via: ["core"],
        interaction: true,
      }),
    );
  }

  const recommendationText = recommendation ? formatRecommendation(recommendation) : null;
  const reservedTokens = 90 + (recommendationText ? estimateTokens(recommendationText) : 0);
  const selectionBudget = Math.max(0, budgetTokens - reservedTokens);
  const rankedCandidates = [...candidates.values()].sort(compareCandidates);
  const interactionCandidates = rankedCandidates.filter((candidate) => candidate.interaction);
  const regularCandidates = rankedCandidates.filter((candidate) => !candidate.interaction);
  const selected: PlannedCandidate[] = [];
  let selectedTokens = 0;
  let interactionTokens = 0;

  for (const candidate of interactionCandidates) {
    if (interactionTokens + candidate.estimated_tokens > interactionBudget) continue;
    if (selectedTokens + candidate.estimated_tokens > selectionBudget) continue;
    selected.push(candidate);
    selectedTokens += candidate.estimated_tokens;
    interactionTokens += candidate.estimated_tokens;
  }
  for (const candidate of regularCandidates) {
    if (selectedTokens + candidate.estimated_tokens > selectionBudget) continue;
    selected.push(candidate);
    selectedTokens += candidate.estimated_tokens;
  }

  let text = renderSelections(selected, recommendationText, personalization.conflicts);
  while (estimateTokens(text) > budgetTokens && selected.length > 0) {
    const removableIndex = findLowestPriorityRemovable(selected);
    selected.splice(removableIndex, 1);
    text = renderSelections(selected, recommendationText, personalization.conflicts);
  }

  const promptOrdered = orderSelectionsForRender(selected);
  const selections: ContextSelection[] = promptOrdered.map(({ formatted: _formatted, interaction: _interaction, ...selection }) => selection);
  const selectedItems = selections.map((selection) => selection.item);
  const selectedFacts = selectedItems.flatMap((item) => (item.kind === "fact" ? [item.fact] : []));
  const selectedFactIds = new Set(selectedFacts.map((fact) => fact.id));
  const selectedEpisodes = selectedItems.flatMap((item) => (item.kind === "episode" ? [item.episode] : []));
  const selectedGoals = selectedItems.flatMap((item) => (item.kind === "goal" ? [item.goal] : []));
  const selectedCommitments = selectedItems.flatMap(
    (item) => (item.kind === "commitment" ? [item.commitment] : []),
  );
  const selectedProjects = selectedItems.flatMap(
    (item) => (item.kind === "project" ? [item.project] : []),
  );
  const selectedFacets = selectedItems.flatMap((item) => (item.kind === "facet" ? [item.facet] : []));
  const plan: ContextPlan = {
    intent,
    budget_tokens: budgetTokens,
    estimated_tokens: estimateTokens(text),
    selections,
  };

  return {
    text,
    hits: dedupeFactHits(queryHits, followThroughHits).filter((hit) => selectedFactIds.has(hit.fact.id)),
    episodes: selectedEpisodes,
    core: selectedFacts,
    goals: selectedGoals,
    commitments: selectedCommitments,
    projects: selectedProjects,
    facets: selectedFacets,
    recommendation,
    opportunityId: cycle?.id ?? null,
    nudge: selectedCommitments.find((item) => item.id === recommendation?.commitment_id) ?? null,
    items: selectedItems,
    plan,
    queryVector,
  };
}

export function renderMemoryBlock(context: MemoryContext): string {
  return `<memory intent="${context.plan.intent}" estimated_tokens="${context.plan.estimated_tokens}">\n${context.text}\n</memory>`;
}

/** Persist exactly what the model saw for a response, for later provenance inspection. */
export function recordResponseContext(
  db: Db,
  assistantMessageId: number,
  planOrItems: ContextPlan | readonly RecallItem[],
): void {
  const selections: ContextSelection[] = isContextPlan(planOrItems)
    ? planOrItems.selections
    : planOrItems.map((item) => ({
        item,
        reason: "query_relevant",
        score: 0,
        via: [],
        estimated_tokens: estimateTokens(formatRecallItem(item)),
      }));
  const insert = db.prepare<[
    number,
    string,
    number,
    number,
    SelectionReason,
    number,
    string,
    string,
    string,
  ]>(
    `INSERT OR IGNORE INTO response_context
       (assistant_message_id, item_kind, item_id, rank, selection_reason,
        selection_score, retrieval_json, created_at, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    selections.forEach((selection, rank) => {
      insert.run(
        assistantMessageId,
        selection.item.kind,
        recallId(selection.item),
        rank,
        selection.reason,
        selection.score,
        JSON.stringify({
          via: selection.via,
          estimated_tokens: selection.estimated_tokens,
          field_provenance: intentFieldProvenance(db, selection.item),
        }),
        now(),
        JSON.stringify(selection.item),
      );
    });
  })();
}

/**
 * Resolve current intention fields to the event that actually changed each one.
 * Reassertions and status-only events do not steal provenance from unchanged fields.
 */
export function intentFieldProvenance(
  db: Db,
  item: RecallItem,
): IntentFieldProvenance | null {
  if (item.kind === "goal") return goalFieldProvenance(db, item.goal);
  if (item.kind === "commitment") {
    return commitmentFieldProvenance(db, item.commitment);
  }
  if (item.kind === "project") return projectFieldProvenance(db, item.project);
  return null;
}

function goalFieldProvenance(db: Db, goal: Goal): IntentFieldProvenance {
  const events = db
    .prepare<[number], GoalEvent>(
      `SELECT id, goal_id, event_type, from_status, to_status, detail_json,
              source_message_id, passage_id, source_kind, created_at
       FROM goal_event WHERE goal_id = ? ORDER BY id`,
    )
    .all(goal.id);
  const created = events.find((event) => event.event_type === "created");
  const base = eventSource(created, goal.source_message_id, goal.created_at);
  const fields: Extract<IntentFieldProvenance, { kind: "goal" }>["fields"] = {
    title: base,
    status: base,
    priority: base,
    target_at: base,
    project_id: base,
    confidence: base,
  };

  for (const event of events) {
    if (event.event_type === "created") continue;
    const source = eventSource(event, event.source_message_id, event.created_at);
    if (event.from_status !== event.to_status && event.to_status !== null) {
      fields.status = source;
    }
    applyChangedFieldSources(
      fields,
      ["title", "priority", "target_at", "project_id", "confidence"],
      event.detail_json,
      source,
    );
  }
  return { kind: "goal", fields };
}

function commitmentFieldProvenance(
  db: Db,
  commitment: CommitmentView,
): IntentFieldProvenance {
  const events = db
    .prepare<[number], CommitmentEvent>(
      `SELECT id, commitment_id, event_type, from_status, to_status, detail_json,
              source_message_id, passage_id, source_kind, created_at
       FROM commitment_event WHERE commitment_id = ? ORDER BY id`,
    )
    .all(commitment.id);
  const created = events.find((event) => event.event_type === "created");
  const base = eventSource(created, commitment.source_message_id, commitment.created_at);
  const fields: Extract<IntentFieldProvenance, { kind: "commitment" }>["fields"] = {
    title: base,
    owner_entity_id: base,
    linked_goal_id: base,
    project_id: base,
    status: base,
    due_at: base,
    snoozed_until: base,
    confidence: base,
  };

  for (const event of events) {
    if (event.event_type === "created" || event.event_type === "surfaced") continue;
    const source = eventSource(event, event.source_message_id, event.created_at);
    if (event.from_status !== event.to_status && event.to_status !== null) {
      fields.status = source;
    }
    applyChangedFieldSources(
      fields,
      [
        "title",
        "owner_entity_id",
        "linked_goal_id",
        "project_id",
        "due_at",
        "snoozed_until",
        "confidence",
      ],
      event.detail_json,
      source,
    );
  }
  return { kind: "commitment", fields };
}

function projectFieldProvenance(db: Db, project: ProjectView): IntentFieldProvenance {
  const events = db
    .prepare<[number], ProjectEvent>(
      `SELECT id, project_id, event_type, from_status, to_status, detail_json,
              source_message_id, passage_id, source_kind, created_at
       FROM project_event WHERE project_id = ? ORDER BY id`,
    )
    .all(project.id);
  const created = events.find((event) => event.event_type === "created");
  const base = eventSource(created, project.source_message_id, project.created_at);
  const fields: Extract<IntentFieldProvenance, { kind: "project" }> ["fields"] = {
    entity_id: base,
    status: base,
    progress_summary: base,
    progress_percent: base,
    blocked_at: base,
    confidence: base,
  };
  for (const event of events) {
    if (event.event_type === "created") continue;
    const source = eventSource(event, event.source_message_id, event.created_at);
    if (event.from_status !== event.to_status && event.to_status !== null) fields.status = source;
    if (event.event_type === "progress") {
      const changes = parseEventChanges(event.detail_json);
      if (Object.hasOwn(changes, "summary")) fields.progress_summary = source;
      if (Object.hasOwn(changes, "percent")) fields.progress_percent = source;
    } else {
      applyChangedFieldSources(
        fields,
        ["progress_summary", "progress_percent", "blocked_at", "confidence"],
        event.detail_json,
        source,
      );
    }
    if (event.event_type === "blocked" || event.event_type === "unblocked") {
      fields.blocked_at = source;
    }
  }
  return { kind: "project", fields };
}

function applyChangedFieldSources<K extends string>(
  fields: Record<K, FieldProvenanceSource>,
  names: readonly K[],
  detailJson: string | null,
  source: FieldProvenanceSource,
): void {
  const changes = parseEventChanges(detailJson);
  for (const name of names) {
    if (Object.hasOwn(changes, name)) fields[name] = source;
  }
}

function parseEventChanges(detailJson: string | null): Record<string, unknown> {
  if (!detailJson) return {};
  try {
    const parsed = JSON.parse(detailJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    if (typeof record.changes === "object" && record.changes !== null) {
      return record.changes as Record<string, unknown>;
    }
    if (
      typeof record.before !== "object" ||
      record.before === null ||
      typeof record.after !== "object" ||
      record.after === null
    ) {
      return {};
    }
    const before = record.before as Record<string, unknown>;
    const after = record.after as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(after).filter(
        ([name, value]) =>
          !Object.hasOwn(before, name) || !sameFieldValue(before[name], value),
      ),
    );
  } catch {
    return {};
  }
}

function sameFieldValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function eventSource(
  event: GoalEvent | CommitmentEvent | ProjectEvent | undefined,
  fallbackMessageId: number | null,
  fallbackDate: string,
): FieldProvenanceSource {
  return {
    event_id: event?.id ?? null,
    source_message_id: event ? event.source_message_id : fallbackMessageId,
    passage_id: event?.passage_id ?? null,
    source_kind: event?.source_kind ?? "message",
    recorded_at: event?.created_at ?? fallbackDate,
  };
}

function isContextPlan(value: ContextPlan | readonly RecallItem[]): value is ContextPlan {
  return !Array.isArray(value);
}

function candidateFor(
  item: RecallItem,
  formatted: string,
  input: {
    reason: SelectionReason;
    score: number;
    via: readonly RetrievalPath[];
    interaction?: boolean;
  },
): PlannedCandidate {
  return {
    item,
    reason: input.reason,
    score: Number(input.score.toFixed(6)),
    via: [...input.via],
    estimated_tokens: estimateTokens(formatted),
    formatted,
    interaction: input.interaction ?? false,
  };
}

function scoreFact(hit: SearchHit, intent: ContextIntent, followThrough: boolean): number {
  const historical = hit.fact.valid_to !== null;
  return 58 + hit.score * 100 + hit.fact.confidence * 8 +
    (historical && intent === "historical" ? 15 : 0) +
    (!historical ? 4 : 0) +
    (followThrough ? 8 : 0) +
    hit.via.length * 2;
}

function scoreFacet(hit: FacetSearchHit, intent: ContextIntent, followThrough: boolean): number {
  const judgmentKinds = new Set([
    "value",
    "decision_criterion",
    "constraint",
    "motivation",
    "preference",
    "relationship_dynamic",
    "capacity_pattern",
  ]);
  return 62 + hit.score * 100 + hit.facet.confidence * 8 +
    importanceBonus(hit.facet.importance) +
    ((intent === "advisory" || intent === "decision") && judgmentKinds.has(hit.facet.kind) ? 18 : 0) +
    (followThrough ? 8 : 0);
}

function renderSelections(
  selections: readonly PlannedCandidate[],
  recommendationText: string | null,
  personalizationConflicts: ReturnType<typeof computePersonalizationProfile>["conflicts"] = [],
): string {
  const sections: string[] = [];
  const interaction = selections.filter((selection) => selection.reason === "interaction_contract");
  const facts = selections.filter((selection) => selection.item.kind === "fact");
  const facets = selections.filter(
    (selection) => selection.item.kind === "facet" && selection.reason !== "interaction_contract",
  );
  const episodes = selections.filter((selection) => selection.item.kind === "episode");
  const goals = selections.filter((selection) => selection.item.kind === "goal");
  const commitments = selections.filter((selection) => selection.item.kind === "commitment");
  const projects = selections.filter((selection) => selection.item.kind === "project");

  if (interaction.length > 0) {
    sections.push(
      `ACCEPTED INTERACTION PREFERENCES AND BOUNDARIES — apply only when relevant:\n${interaction.map((item) => item.formatted).join("\n")}`,
    );
  }
  if (facts.length > 0) {
    sections.push(
      `CANONICAL FACTS RELEVANT TO THIS REQUEST:\n${facts.map((item) => item.formatted).join("\n")}`,
    );
  }
  if (facets.length > 0) {
    sections.push(
      `ACCEPTED UNDERSTANDING FACETS RELEVANT TO THIS REQUEST:\n${facets.map((item) => item.formatted).join("\n")}\nUse these to frame tradeoffs. If accepted facets, goals, or constraints conflict, surface the conflict instead of silently deciding for the user.`,
    );
  }
  const selectedKeys = new Set(selections.map((selection) => recallKey(selection.item)));
  const activeConflicts = personalizationConflicts.filter((conflict) =>
    conflict.item_ids.every((id) => selectedKeys.has(id)),
  );
  if (activeConflicts.length > 0) {
    sections.push(
      `PERSONALIZATION CONFLICTS — accepted preferences that Zeus must surface rather than silently resolve:\n${activeConflicts
        .map((conflict) => `- ${conflict.item_ids.join(" vs ")} (${conflict.reasons.join(", ")})`)
        .join("\n")}`,
    );
  }
  if (episodes.length > 0) {
    sections.push(
      `DATED EVIDENCE PASSAGES — exact user-authored recollections, not guaranteed current facts:\n${episodes.map((item) => item.formatted).join("\n")}`,
    );
  }
  if (goals.length > 0) {
    sections.push(`RELEVANT GOALS:\n${goals.map((item) => item.formatted).join("\n")}`);
  }
  if (commitments.length > 0) {
    sections.push(
      `RELEVANT OPEN LOOPS:\n${commitments.map((item) => item.formatted).join("\n")}`,
    );
  }
  if (projects.length > 0) {
    sections.push(
      `RELEVANT PROJECTS:\n${projects.map((item) => item.formatted).join("\n")}`,
    );
  }
  if (recommendationText) sections.push(recommendationText);
  return sections.length > 0
    ? sections.join("\n\n")
    : "Zeus found nothing relevant in accepted memory for this request.";
}

function orderSelectionsForRender(
  selections: readonly PlannedCandidate[],
): PlannedCandidate[] {
  const sectionRank = (selection: PlannedCandidate): number => {
    if (selection.reason === "interaction_contract") return 0;
    if (selection.item.kind === "fact") return 1;
    if (selection.item.kind === "facet") return 2;
    if (selection.item.kind === "episode") return 3;
    if (selection.item.kind === "project") return 4;
    if (selection.item.kind === "goal") return 5;
    return 6;
  };
  return [...selections].sort(
    (a, b) => sectionRank(a) - sectionRank(b) || b.score - a.score ||
      recallKey(a.item).localeCompare(recallKey(b.item)),
  );
}

function formatRecommendation(recommendation: FollowThroughRecommendation): string {
  return `FOLLOW-THROUGH OPPORTUNITY — a system proposal, not a fact about the user:\n- [commitment:${recommendation.commitment_id}] ${escapeMemory(recommendation.commitment_title)}${recommendation.due_at ? `, due ${recommendation.due_at.slice(0, 10)}` : ""}\n- WHY NOW: ${escapeMemory(recommendation.why)}\n- USEFUL NEXT ACTION: ${escapeMemory(recommendation.suggested_action)}\nFirst answer the user's request. Offer this next step only if it helps rather than derails them. You may draft, research, or plan in the conversation; sending, scheduling, purchasing, reminding, or coordinating externally always requires explicit confirmation.`;
}

function formatRecallItem(item: RecallItem): string {
  if (item.kind === "fact") return formatFact(item.fact);
  if (item.kind === "episode") return formatEpisode(item.episode);
  if (item.kind === "goal") return formatGoal(item.goal);
  if (item.kind === "commitment") return formatCommitment(item.commitment);
  if (item.kind === "project") return formatProject(item.project);
  return formatFacet(item.facet);
}

function facetScopeLabel(facet: UnderstandingFacetView): string {
  if (facet.scope_kind === "global") return "global";
  if (facet.scope_kind === "domain") return `domain: ${facet.scope_label ?? "unspecified"}`;
  if (facet.scope_kind === "entity") return `person or entity: ${facet.scope_entity_name ?? "unknown"}`;
  if (facet.scope_kind === "goal") return `goal: ${facet.scope_goal_title ?? "unknown"}`;
  return `commitment: ${facet.scope_commitment_title ?? "unknown"}`;
}

function facetScopeApplies(
  facet: UnderstandingFacetView,
  query: string,
  entityIds: ReadonlySet<number>,
  goalIds: ReadonlySet<number>,
  commitmentIds: ReadonlySet<number>,
): boolean {
  if (facet.scope_kind === "global") return true;
  if (facet.scope_kind === "domain") return tokenOverlap(query, facet.scope_label ?? "") > 0;
  if (facet.scope_kind === "entity") {
    return facet.scope_entity_id !== null && entityIds.has(facet.scope_entity_id);
  }
  if (facet.scope_kind === "goal") {
    return facet.scope_goal_id !== null && goalIds.has(facet.scope_goal_id);
  }
  return facet.scope_commitment_id !== null && commitmentIds.has(facet.scope_commitment_id);
}

function facetConditionApplies(
  facet: UnderstandingFacetView,
  query: string,
  context: EvaluationContext,
): boolean {
  if (facet.condition_json !== null) {
    try {
      const condition = StructuredFacetConditionSchema.safeParse(JSON.parse(facet.condition_json));
      return condition.success && structuredFacetConditionMatches(condition.data, context);
    } catch {
      return false;
    }
  }
  return facet.condition_text === null || tokenOverlap(query, facet.condition_text) > 0;
}

function dedupeFactHits(
  primary: readonly SearchHit[],
  secondary: readonly SearchHit[],
): SearchHit[] {
  const byId = new Map<number, SearchHit>();
  for (const hit of [...primary, ...secondary]) {
    const existing = byId.get(hit.fact.id);
    if (!existing) {
      byId.set(hit.fact.id, { ...hit, via: [...hit.via] });
      continue;
    }
    existing.score = Math.max(existing.score, hit.score);
    existing.via = [...new Set([...existing.via, ...hit.via])];
  }
  return [...byId.values()];
}

function dedupeFacetHits(
  primary: readonly FacetSearchHit[],
  secondary: readonly FacetSearchHit[],
): FacetSearchHit[] {
  const byId = new Map<number, FacetSearchHit>();
  for (const hit of [...primary, ...secondary]) {
    const existing = byId.get(hit.facet.id);
    if (!existing || hit.score > existing.score) byId.set(hit.facet.id, hit);
  }
  return [...byId.values()];
}

function dedupeEpisodes(
  primary: readonly EpisodeHit[],
  secondary: readonly EpisodeHit[],
): EpisodeHit[] {
  const byPassage = new Map<string, EpisodeHit>();
  for (const episode of [...primary, ...secondary]) {
    const identity = episodeIdentity(episode);
    const existing = byPassage.get(identity);
    if (!existing || episode.score > existing.score) byPassage.set(identity, episode);
  }
  return [...byPassage.values()];
}

function episodeIdentity(episode: EpisodeHit): string {
  return episode.passage_id === null
    ? `legacy-message:${episode.message.id}`
    : `passage:${episode.passage_id}`;
}

function compareCandidates(a: PlannedCandidate, b: PlannedCandidate): number {
  return Number(b.interaction) - Number(a.interaction) || b.score - a.score ||
    recallKey(a.item).localeCompare(recallKey(b.item));
}

function findLowestPriorityRemovable(selected: readonly PlannedCandidate[]): number {
  let lowestIndex = selected.length - 1;
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const lowest = selected[lowestIndex];
    if (candidate && lowest && candidate.score < lowest.score) lowestIndex = index;
  }
  return lowestIndex;
}

function recallId(item: RecallItem): number {
  if (item.kind === "fact") return item.fact.id;
  if (item.kind === "episode") {
    if (item.episode.passage_id === null) {
      throw new Error("Cannot trace an episode without an evidence passage id");
    }
    return item.episode.passage_id;
  }
  if (item.kind === "goal") return item.goal.id;
  if (item.kind === "commitment") return item.commitment.id;
  if (item.kind === "project") return item.project.id;
  return item.facet.id;
}

function recallKey(item: RecallItem): string {
  return `${item.kind}:${recallId(item)}`;
}

function higherPriorityReason(a: SelectionReason, b: SelectionReason): SelectionReason {
  const priority: Record<SelectionReason, number> = {
    interaction_contract: 5,
    follow_through: 4,
    historical: 3,
    open_loop: 2,
    query_relevant: 1,
  };
  return priority[a] >= priority[b] ? a : b;
}

function boundedBudget(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function priorityBonus(priority: Goal["priority"]): number {
  return priority === "high" ? 8 : priority === "low" ? -3 : 2;
}

function importanceBonus(importance: UnderstandingFacetView["importance"]): number {
  return importance === "high" ? 10 : importance === "low" ? -3 : 3;
}

function tokenOverlap(left: string, right: string): number {
  const leftTerms = meaningfulTerms(left);
  const rightTerms = meaningfulTerms(right);
  let overlap = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) overlap += 1;
  return overlap;
}

function meaningfulTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/u)
      .filter((term) => term.length > 2 && !CONTEXT_STOPWORDS.has(term)),
  );
}

const CONTEXT_STOPWORDS = new Set([
  "the", "and", "but", "for", "with", "about", "from", "into", "that", "this",
  "what", "when", "where", "which", "would", "could", "should", "have", "has",
  "had", "how", "why", "who", "your", "you", "their", "they", "them", "our",
  "are", "was", "were", "been", "being", "can", "will", "just", "not", "all",
  "want", "need", "help", "please", "tell", "make", "user",
]);

function escapeMemory(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function asksAboutHistory(query: string): boolean {
  return /\b(before|formerly|history|historical|past|previous|previously|prior|used to|no longer|back when)\b/iu.test(
    query,
  );
}

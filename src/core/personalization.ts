import { getMessage } from "./conversations";
import type { Db } from "./db";
import { now } from "./db";
import type {
  BehavioralPolicyReviewStatus,
  BehavioralPolicySuggestion,
  BehavioralPolicySuggestionEvent,
  BehavioralPolicySuggestionView,
  FacetImportance,
  FacetKind,
  FacetMachineEffect,
  FacetScopeKind,
  FollowThroughActionKind,
} from "./schema";

/**
 * Personalization is a read model over canonical, source-backed memory. It does not
 * learn from behavior and it never writes facts or facets. Behavioral feedback has a
 * separate read model below so an observed click cannot quietly become a claim about
 * the user.
 */

export type PersonalizationCategory =
  | "like"
  | "dislike"
  | "preference"
  | "routine"
  | "working_style"
  | "communication_style"
  | "boundary"
  | "constraint";

export type PersonalizationSourceKind = "fact" | "facet";

export type PersonalizationProvenance = {
  source_kind: PersonalizationSourceKind;
  source_id: number;
  source_message_id: number;
  evidence_ids: number[];
  passage_ids: number[];
};

export type PersonalizationScope = {
  kind: FacetScopeKind;
  label: string | null;
  entity_id: number | null;
  goal_id: number | null;
  commitment_id: number | null;
};

export type PersonalizationProfileItem = {
  id: `${PersonalizationSourceKind}:${number}`;
  category: PersonalizationCategory;
  statement: string;
  scope: PersonalizationScope;
  condition_text: string | null;
  condition_json: string | null;
  confidence: number;
  importance: FacetImportance;
  provenance: PersonalizationProvenance;
};

export type ApprovedMachineEffect = {
  facet_id: number;
  effect: FacetMachineEffect;
  statement: string;
  scope: PersonalizationScope;
  condition_text: string | null;
  condition_json: string | null;
  provenance: PersonalizationProvenance;
};

export type PersonalizationConflictReason =
  | "opposing_like_and_dislike"
  | "negated_claims"
  | "opposing_terms";

export type PersonalizationConflict = {
  item_ids: PersonalizationProfileItem["id"][];
  reasons: PersonalizationConflictReason[];
};

export type PersonalizationProfile = {
  items: PersonalizationProfileItem[];
  conflicts: PersonalizationConflict[];
  /** Deliberately separate from descriptive items: these are deterministic policy. */
  approved_machine_effects: ApprovedMachineEffect[];
};

type FactProfileRow = {
  id: number;
  predicate: string;
  object: string;
  confidence: number;
  source_message_id: number;
};

type FacetProfileRow = {
  id: number;
  kind: FacetKind;
  statement: string;
  scope_kind: FacetScopeKind;
  scope_label: string | null;
  scope_entity_id: number | null;
  scope_goal_id: number | null;
  scope_commitment_id: number | null;
  condition_text: string | null;
  condition_json: string | null;
  importance: FacetImportance;
  confidence: number;
  machine_effect: FacetMachineEffect | null;
  source_message_id: number;
};

type EvidenceRow = {
  id: number;
  passage_id: number | null;
};

const FACT_CATEGORY = new Map<string, PersonalizationCategory>([
  ["likes", "like"],
  ["enjoys", "like"],
  ["dislikes", "dislike"],
  ["avoids", "dislike"],
  ["prefers", "preference"],
  ["preference", "preference"],
  ["routine", "routine"],
  ["routines", "routine"],
  ["working_style", "working_style"],
  ["work_style", "working_style"],
  ["communication_style", "communication_style"],
  ["boundary", "boundary"],
  ["boundaries", "boundary"],
  ["constraint", "constraint"],
  ["constraints", "constraint"],
]);

const FACET_CATEGORY = new Map<FacetKind, PersonalizationCategory>([
  ["preference", "preference"],
  ["routine", "routine"],
  ["working_style", "working_style"],
  ["communication_style", "communication_style"],
  ["boundary", "boundary"],
  ["constraint", "constraint"],
]);

const GLOBAL_SCOPE: PersonalizationScope = {
  kind: "global",
  label: null,
  entity_id: null,
  goal_id: null,
  commitment_id: null,
};

/**
 * Compute the current personalization profile from accepted memory only.
 *
 * Legacy facts without a user source and facets without claim-level evidence are
 * excluded. Pending/rejected candidates and behavioral feedback are never queried.
 */
export function computePersonalizationProfile(db: Db): PersonalizationProfile {
  const items: PersonalizationProfileItem[] = [];
  const machineEffects: ApprovedMachineEffect[] = [];

  const facts = db
    .prepare<[], FactProfileRow>(
      `SELECT f.id, f.predicate, f.object, f.confidence, f.source_message_id
       FROM fact f
       JOIN entity subject ON subject.id = f.subject_id AND subject.slug = 'self'
       JOIN message source ON source.id = f.source_message_id AND source.role = 'user'
       WHERE f.valid_to IS NULL
         AND EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = f.id)
       ORDER BY f.id`,
    )
    .all();

  for (const fact of facts) {
    const category = FACT_CATEGORY.get(normalizePredicate(fact.predicate));
    if (!category) continue;
    const provenance = factProvenance(db, fact);
    items.push({
      id: `fact:${fact.id}`,
      category,
      statement: fact.object,
      scope: GLOBAL_SCOPE,
      condition_text: null,
      condition_json: null,
      confidence: fact.confidence,
      importance: "normal",
      provenance,
    });
  }

  const facets = db
    .prepare<[], FacetProfileRow>(
      `SELECT f.id, f.kind, f.statement, f.scope_kind, f.scope_label,
              f.scope_entity_id, f.scope_goal_id, f.scope_commitment_id,
              f.condition_text, f.condition_json, f.importance, f.confidence,
              f.machine_effect, f.source_message_id
       FROM understanding_facet f
       JOIN message source ON source.id = f.source_message_id AND source.role = 'user'
       WHERE f.valid_to IS NULL
         AND EXISTS (SELECT 1 FROM facet_evidence fe WHERE fe.facet_id = f.id)
       ORDER BY f.id`,
    )
    .all();

  for (const facet of facets) {
    const scope = facetScope(facet);
    const provenance = facetProvenance(db, facet);
    const category = FACET_CATEGORY.get(facet.kind);
    if (category) {
      items.push({
        id: `facet:${facet.id}`,
        category,
        statement: facet.statement,
        scope,
        condition_text: facet.condition_text,
        condition_json: facet.condition_json,
        confidence: facet.confidence,
        importance: facet.importance,
        provenance,
      });
    }
    if (facet.machine_effect !== null) {
      machineEffects.push({
        facet_id: facet.id,
        effect: facet.machine_effect,
        statement: facet.statement,
        scope,
        condition_text: facet.condition_text,
        condition_json: facet.condition_json,
        provenance,
      });
    }
  }

  items.sort(compareProfileItems);
  return {
    items,
    conflicts: findPersonalizationConflicts(items),
    approved_machine_effects: machineEffects,
  };
}

function factProvenance(db: Db, fact: FactProfileRow): PersonalizationProvenance {
  const evidence = db
    .prepare<[number], EvidenceRow>(
      `SELECT id, passage_id FROM fact_evidence WHERE fact_id = ? ORDER BY id`,
    )
    .all(fact.id);
  return {
    source_kind: "fact",
    source_id: fact.id,
    source_message_id: fact.source_message_id,
    evidence_ids: evidence.map((row) => row.id),
    passage_ids: evidence.flatMap((row) => (row.passage_id === null ? [] : [row.passage_id])),
  };
}

function facetProvenance(db: Db, facet: FacetProfileRow): PersonalizationProvenance {
  const evidence = db
    .prepare<[number], EvidenceRow>(
      `SELECT id, passage_id FROM facet_evidence WHERE facet_id = ? ORDER BY id`,
    )
    .all(facet.id);
  return {
    source_kind: "facet",
    source_id: facet.id,
    source_message_id: facet.source_message_id,
    evidence_ids: evidence.map((row) => row.id),
    passage_ids: evidence.flatMap((row) => (row.passage_id === null ? [] : [row.passage_id])),
  };
}

function facetScope(facet: FacetProfileRow): PersonalizationScope {
  return {
    kind: facet.scope_kind,
    label: facet.scope_label,
    entity_id: facet.scope_entity_id,
    goal_id: facet.scope_goal_id,
    commitment_id: facet.scope_commitment_id,
  };
}

function compareProfileItems(
  left: PersonalizationProfileItem,
  right: PersonalizationProfileItem,
): number {
  const category = left.category.localeCompare(right.category);
  if (category !== 0) return category;
  const source = left.provenance.source_kind.localeCompare(right.provenance.source_kind);
  return source !== 0
    ? source
    : left.provenance.source_id - right.provenance.source_id;
}

function normalizePredicate(predicate: string): string {
  return predicate.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

// ---------------------------------------------------------------------------
// Conservative conflict surfacing
// ---------------------------------------------------------------------------

type ConflictEdge = {
  left: PersonalizationProfileItem["id"];
  right: PersonalizationProfileItem["id"];
  reason: PersonalizationConflictReason;
};

const NEGATIONS = new Set(["avoid", "avoids", "cannot", "dont", "never", "no", "not"]);

const FILLER_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "for",
  "i",
  "is",
  "it",
  "like",
  "likes",
  "me",
  "my",
  "of",
  "prefer",
  "prefers",
  "that",
  "the",
  "to",
  "user",
  "want",
  "wants",
]);

const OPPOSING_TERM_GROUPS: ReadonlyArray<readonly [Set<string>, Set<string>]> = [
  [new Set(["brief", "concise", "short"]), new Set(["detailed", "long", "verbose"])],
  [new Set(["early", "morning"]), new Set(["evening", "late", "night"])],
  [new Set(["async", "asynchronous"]), new Set(["sync", "synchronous"])],
  [new Set(["home", "remote"]), new Set(["inperson", "office", "onsite"])],
];

/** Surface only explicit, easily explainable contradictions; never choose a winner. */
export function findPersonalizationConflicts(
  items: readonly PersonalizationProfileItem[],
): PersonalizationConflict[] {
  const edges: ConflictEdge[] = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    const left = items[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const right = items[rightIndex]!;
      if (!sameContext(left, right)) continue;
      const reason = conflictReason(left, right);
      if (reason) edges.push({ left: left.id, right: right.id, reason });
    }
  }
  return connectedConflicts(edges);
}

function conflictReason(
  left: PersonalizationProfileItem,
  right: PersonalizationProfileItem,
): PersonalizationConflictReason | null {
  const leftTerms = meaningfulTerms(left.statement);
  const rightTerms = meaningfulTerms(right.statement);
  if (
    ((left.category === "like" && right.category === "dislike") ||
      (left.category === "dislike" && right.category === "like")) &&
    normalizedTermKey(leftTerms) === normalizedTermKey(rightTerms)
  ) {
    return "opposing_like_and_dislike";
  }

  const leftNegated = hasNegation(left.statement);
  const rightNegated = hasNegation(right.statement);
  if (leftNegated !== rightNegated && termSimilarity(leftTerms, rightTerms) >= 0.6) {
    return "negated_claims";
  }

  const opposition = opposingTerms(leftTerms, rightTerms);
  if (opposition && sharedAnchorCount(leftTerms, rightTerms, opposition) > 0) {
    return "opposing_terms";
  }
  return null;
}

function sameContext(
  left: PersonalizationProfileItem,
  right: PersonalizationProfileItem,
): boolean {
  return (
    JSON.stringify(left.scope) === JSON.stringify(right.scope) &&
    normalizeText(left.condition_text ?? "") === normalizeText(right.condition_text ?? "") &&
    (left.condition_json ?? "") === (right.condition_json ?? "")
  );
}

function hasNegation(statement: string): boolean {
  return tokenize(statement).some((term) => NEGATIONS.has(term));
}

function meaningfulTerms(statement: string): Set<string> {
  return new Set(
    tokenize(statement)
      .map(canonicalTerm)
      .filter((term) => !FILLER_TERMS.has(term) && !NEGATIONS.has(term)),
  );
}

function tokenize(statement: string): string[] {
  return normalizeText(statement).match(/[a-z0-9]+/gu) ?? [];
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[’']/gu, "");
}

function canonicalTerm(term: string): string {
  if (term === "answers" || term === "answer" || term === "responses") return "response";
  if (term === "meetings") return "meeting";
  return term;
}

function normalizedTermKey(terms: ReadonlySet<string>): string {
  return [...terms].sort().join(" ");
}

function termSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / union.size;
}

function opposingTerms(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): Set<string> | null {
  for (const [first, second] of OPPOSING_TERM_GROUPS) {
    const leftFirst = intersects(left, first);
    const leftSecond = intersects(left, second);
    const rightFirst = intersects(right, first);
    const rightSecond = intersects(right, second);
    if ((leftFirst && rightSecond) || (leftSecond && rightFirst)) {
      return new Set([...first, ...second]);
    }
  }
  return null;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const term of left) if (right.has(term)) return true;
  return false;
}

function sharedAnchorCount(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): number {
  let count = 0;
  for (const term of left) {
    if (right.has(term) && !excluded.has(term)) count += 1;
  }
  return count;
}

function connectedConflicts(edges: readonly ConflictEdge[]): PersonalizationConflict[] {
  const remaining = new Set(edges.flatMap((edge) => [edge.left, edge.right]));
  const conflicts: PersonalizationConflict[] = [];
  while (remaining.size > 0) {
    const first = [...remaining].sort()[0]!;
    const members = new Set<PersonalizationProfileItem["id"]>([first]);
    const reasons = new Set<PersonalizationConflictReason>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (!members.has(edge.left) && !members.has(edge.right)) continue;
        reasons.add(edge.reason);
        if (!members.has(edge.left)) {
          members.add(edge.left);
          changed = true;
        }
        if (!members.has(edge.right)) {
          members.add(edge.right);
          changed = true;
        }
      }
    }
    for (const member of members) remaining.delete(member);
    conflicts.push({
      item_ids: [...members].sort(),
      reasons: [...reasons].sort(),
    });
  }
  return conflicts.sort((left, right) => left.item_ids[0]!.localeCompare(right.item_ids[0]!));
}

// ---------------------------------------------------------------------------
// Non-canonical behavioral signals
// ---------------------------------------------------------------------------

export type BehavioralEventType = "dismissed" | "snoozed" | "completed" | "regretted";

export type ExplicitBehavioralEvent = {
  id: number;
  commitment_id: number;
  event_type: BehavioralEventType;
  action_kind: FollowThroughActionKind;
  reason: string;
  source_message_id: number | null;
  source_kind: "message" | "user_action";
  user_reason: string | null;
  created_at: string;
};

export type BehavioralPattern = {
  key: string;
  event_type: BehavioralEventType;
  action_kind: FollowThroughActionKind;
  count: number;
  event_ids: number[];
  commitment_ids: number[];
  latest_at: string;
};

export type BehavioralReviewSuggestion = {
  key: string;
  kind: "temporary_suppression" | "confirm_routine";
  summary: string;
  event_ids: number[];
  /** A suggestion can maintain or reduce interruptions, never broaden delivery. */
  allowed_interruption_change: "none" | "suppress_only";
  canonical: false;
};

export type BehavioralSignalSummary = {
  events: ExplicitBehavioralEvent[];
  repeated_patterns: BehavioralPattern[];
  review_suggestions: BehavioralReviewSuggestion[];
};

type BehavioralEventRow = Omit<ExplicitBehavioralEvent, "user_reason"> & {
  detail_json: string | null;
};

export type BehavioralSignalOptions = {
  /** Defaults to three explicit decisions; two is the minimum supported threshold. */
  repeatThreshold?: number;
  limit?: number;
};

/**
 * Aggregate only explicit user-control/progress events. `surfaced` and silence are
 * intentionally absent, and this function performs no writes.
 */
export function aggregateBehavioralSignals(
  db: Db,
  options: BehavioralSignalOptions = {},
): BehavioralSignalSummary {
  const threshold = normalizedBehaviorThreshold(options.repeatThreshold);
  const limit = Math.max(1, Math.min(2_000, Math.floor(options.limit ?? 500)));
  const rows = db
    .prepare<[number], BehavioralEventRow>(
      `SELECT id, commitment_id, event_type, action_kind, reason, detail_json,
              source_message_id, source_kind, created_at
       FROM follow_through_event
       WHERE event_type IN ('dismissed','snoozed','completed','regretted')
         AND source_kind IN ('message','user_action')
         AND COALESCE(json_extract(detail_json, '$.decision.feedback_only'), 0) <> 1
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit);
  const events = rows.map(toBehavioralEvent);
  const groups = new Map<string, ExplicitBehavioralEvent[]>();
  for (const event of events) {
    const key = `${event.event_type}:${event.action_kind}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }

  const repeatedPatterns: BehavioralPattern[] = [];
  for (const [key, group] of groups) {
    if (group.length < threshold) continue;
    const first = group[0]!;
    repeatedPatterns.push({
      key,
      event_type: first.event_type,
      action_kind: first.action_kind,
      count: group.length,
      event_ids: group.map((event) => event.id).sort((left, right) => left - right),
      commitment_ids: [...new Set(group.map((event) => event.commitment_id))].sort(
        (left, right) => left - right,
      ),
      latest_at: group.map((event) => event.created_at).sort().at(-1)!,
    });
  }
  repeatedPatterns.sort((left, right) => left.key.localeCompare(right.key));

  return {
    events,
    repeated_patterns: repeatedPatterns,
    review_suggestions: repeatedPatterns.map(reviewSuggestion),
  };
}

function toBehavioralEvent(row: BehavioralEventRow): ExplicitBehavioralEvent {
  let userReason: string | null = null;
  if (row.detail_json !== null) {
    try {
      const detail: unknown = JSON.parse(row.detail_json);
      const decision = isRecord(detail) && isRecord(detail.decision)
        ? detail.decision
        : null;
      const authoredReason = isRecord(detail) && typeof detail.user_reason === "string"
        ? detail.user_reason
        : decision && typeof decision.user_reason === "string"
          ? decision.user_reason
          : null;
      if (authoredReason !== null) {
        userReason = authoredReason.trim() || null;
      }
    } catch {
      // A malformed historical detail is not evidence. Keep the explicit event itself.
    }
  }
  return {
    id: row.id,
    commitment_id: row.commitment_id,
    event_type: row.event_type,
    action_kind: row.action_kind,
    reason: row.reason,
    source_message_id: row.source_message_id,
    source_kind: row.source_kind,
    user_reason: userReason,
    created_at: row.created_at,
  };
}

function reviewSuggestion(pattern: BehavioralPattern): BehavioralReviewSuggestion {
  const suppression =
    pattern.event_type === "dismissed" ||
    pattern.event_type === "snoozed" ||
    pattern.event_type === "regretted";
  return {
    key: `review:${pattern.key}`,
    kind: suppression ? "temporary_suppression" : "confirm_routine",
    summary: suppression
      ? `Ask whether to temporarily suppress ${pattern.action_kind} follow-through suggestions.`
      : `Ask whether completed ${pattern.action_kind} work reflects a routine worth recording.`,
    event_ids: pattern.event_ids,
    allowed_interruption_change: suppression ? "suppress_only" : "none",
    canonical: false,
  };
}

// ---------------------------------------------------------------------------
// Persisted, reviewable behavioral-policy suggestions
// ---------------------------------------------------------------------------

const SELECT_BEHAVIORAL_POLICY_SUGGESTION = `
  SELECT id, pattern_key, event_type, action_kind, kind, summary,
         allowed_interruption_change, minimum_evidence_count, created_at
  FROM behavioral_policy_suggestion
`;

export type BehavioralPolicySuggestionListOptions = {
  status?: BehavioralPolicyReviewStatus;
  limit?: number;
};

/** Read a persisted proposal with its exact feedback-event evidence and review log. */
export function getBehavioralPolicySuggestion(
  db: Db,
  id: number,
): BehavioralPolicySuggestionView | null {
  const suggestion = db
    .prepare<[number], BehavioralPolicySuggestion>(
      `${SELECT_BEHAVIORAL_POLICY_SUGGESTION} WHERE id = ?`,
    )
    .get(id);
  return suggestion ? behavioralPolicySuggestionView(db, suggestion) : null;
}

export function listBehavioralPolicySuggestions(
  db: Db,
  options: BehavioralPolicySuggestionListOptions = {},
): BehavioralPolicySuggestionView[] {
  const limit = Math.max(1, Math.min(100_000, Math.floor(options.limit ?? 500)));
  const suggestions = db
    .prepare<[], BehavioralPolicySuggestion>(
      `${SELECT_BEHAVIORAL_POLICY_SUGGESTION} ORDER BY id DESC`,
    )
    .all()
    .map((suggestion) => behavioralPolicySuggestionView(db, suggestion));
  return suggestions
    .filter((suggestion) => options.status === undefined || suggestion.status === options.status)
    .slice(0, limit);
}

/**
 * Persist repeated explicit feedback as non-canonical review proposals. Reruns are
 * idempotent: only previously unseen follow-through event IDs are appended as evidence.
 * No fact, facet, active policy, delivery setting, or interruption budget is changed.
 */
export function materializeBehavioralPolicySuggestions(
  db: Db,
  options: BehavioralSignalOptions = {},
): BehavioralPolicySuggestionView[] {
  const minimumEvidenceCount = normalizedBehaviorThreshold(options.repeatThreshold);
  const signals = aggregateBehavioralSignals(db, {
    ...options,
    repeatThreshold: minimumEvidenceCount,
  });
  return db.transaction(() => {
    const persisted: BehavioralPolicySuggestionView[] = [];
    for (const pattern of signals.repeated_patterns) {
      const proposal = reviewSuggestion(pattern);
      const timestamp = now();
      const inserted = db
        .prepare<[
          string,
          BehavioralEventType,
          FollowThroughActionKind,
          BehavioralReviewSuggestion["kind"],
          string,
          BehavioralReviewSuggestion["allowed_interruption_change"],
          number,
          string,
        ]>(
          `INSERT OR IGNORE INTO behavioral_policy_suggestion
             (pattern_key, event_type, action_kind, kind, summary,
              allowed_interruption_change, minimum_evidence_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          proposal.key,
          pattern.event_type,
          pattern.action_kind,
          proposal.kind,
          proposal.summary,
          proposal.allowed_interruption_change,
          minimumEvidenceCount,
          timestamp,
        );
      const suggestion = db
        .prepare<[string], BehavioralPolicySuggestion>(
          `${SELECT_BEHAVIORAL_POLICY_SUGGESTION} WHERE pattern_key = ?`,
        )
        .get(proposal.key);
      if (!suggestion) {
        throw new Error("Behavioral policy suggestion vanished during materialization");
      }

      const evidenceAdded: number[] = [];
      const addEvidence = db.prepare<[number, number, string]>(
        `INSERT OR IGNORE INTO behavioral_policy_suggestion_evidence
           (suggestion_id, follow_through_event_id, created_at)
         VALUES (?, ?, ?)`,
      );
      for (const eventId of proposal.event_ids) {
        if (addEvidence.run(suggestion.id, eventId, timestamp).changes > 0) {
          evidenceAdded.push(eventId);
        }
      }
      if (inserted.changes > 0 || evidenceAdded.length > 0) {
        insertBehavioralPolicySuggestionEvent(db, {
          suggestionId: suggestion.id,
          eventType: "materialized",
          detail: {
            evidence_event_ids_added: evidenceAdded,
            evidence_count: proposal.event_ids.length,
            minimum_evidence_count: suggestion.minimum_evidence_count,
          },
          sourceMessageId: null,
          sourceKind: "system",
        });
      }
      persisted.push(behavioralPolicySuggestionView(db, suggestion));
    }
    return persisted;
  })();
}

export type BehavioralPolicyReviewDecision = "accepted_for_review" | "dismissed";

/**
 * Append an explicit review decision. "Accepted for review" deliberately does not
 * activate a policy: any canonical routine or machine effect still requires the normal
 * evidence/acceptance boundary, and interruption settings are untouched.
 */
export function reviewBehavioralPolicySuggestion(
  db: Db,
  input: {
    suggestionId: number;
    decision: BehavioralPolicyReviewDecision;
    sourceMessageId: number;
    userReason?: string | null;
  },
): BehavioralPolicySuggestionView | null {
  const suggestion = getBehavioralPolicySuggestion(db, input.suggestionId);
  if (!suggestion) return null;
  const source = getMessage(db, input.sourceMessageId);
  if (!source || source.role !== "user") {
    throw new Error("Behavioral policy review requires a stored user message");
  }
  const userReason = input.userReason?.replace(/\s+/gu, " ").trim() || null;
  const sourceKind = source.origin === "user_action" ? "user_action" : "message";

  const existing = db
    .prepare<
      [number, BehavioralPolicyReviewDecision, number],
      { id: number }
    >(
      `SELECT id FROM behavioral_policy_suggestion_event
       WHERE suggestion_id = ? AND event_type = ? AND source_message_id = ?
       LIMIT 1`,
    )
    .get(input.suggestionId, input.decision, input.sourceMessageId);
  if (!existing) {
    insertBehavioralPolicySuggestionEvent(db, {
      suggestionId: input.suggestionId,
      eventType: input.decision,
      detail: userReason === null ? null : { user_reason: userReason },
      sourceMessageId: input.sourceMessageId,
      sourceKind,
    });
  }
  return getBehavioralPolicySuggestion(db, input.suggestionId);
}

export function acceptBehavioralPolicySuggestionForReview(
  db: Db,
  suggestionId: number,
  sourceMessageId: number,
  userReason: string | null = null,
): BehavioralPolicySuggestionView | null {
  return reviewBehavioralPolicySuggestion(db, {
    suggestionId,
    decision: "accepted_for_review",
    sourceMessageId,
    userReason,
  });
}

export function dismissBehavioralPolicySuggestion(
  db: Db,
  suggestionId: number,
  sourceMessageId: number,
  userReason: string | null = null,
): BehavioralPolicySuggestionView | null {
  return reviewBehavioralPolicySuggestion(db, {
    suggestionId,
    decision: "dismissed",
    sourceMessageId,
    userReason,
  });
}

/** Remove suggestions whose explicit event evidence was deleted below its threshold. */
export function pruneBehavioralPolicySuggestions(db: Db): number {
  return db
    .prepare(
      `DELETE FROM behavioral_policy_suggestion
       WHERE (
         SELECT COUNT(*) FROM behavioral_policy_suggestion_evidence evidence
         WHERE evidence.suggestion_id = behavioral_policy_suggestion.id
       ) < minimum_evidence_count`,
    )
    .run().changes;
}

function behavioralPolicySuggestionView(
  db: Db,
  suggestion: BehavioralPolicySuggestion,
): BehavioralPolicySuggestionView {
  const evidenceEventIds = db
    .prepare<[number], { follow_through_event_id: number }>(
      `SELECT follow_through_event_id
       FROM behavioral_policy_suggestion_evidence
       WHERE suggestion_id = ? ORDER BY follow_through_event_id`,
    )
    .all(suggestion.id)
    .map((row) => row.follow_through_event_id);
  const events = db
    .prepare<[number], BehavioralPolicySuggestionEvent>(
      `SELECT id, suggestion_id, event_type, detail_json, source_message_id,
              source_kind, created_at
       FROM behavioral_policy_suggestion_event
       WHERE suggestion_id = ? ORDER BY id`,
    )
    .all(suggestion.id);
  let status: BehavioralPolicyReviewStatus = "pending";
  for (const event of [...events].reverse()) {
    if (event.event_type === "accepted_for_review" || event.event_type === "dismissed") {
      status = event.event_type;
      break;
    }
  }
  return {
    ...suggestion,
    status,
    evidence_event_ids: evidenceEventIds,
    events,
  };
}

function insertBehavioralPolicySuggestionEvent(
  db: Db,
  input:
    | {
        suggestionId: number;
        eventType: "materialized";
        detail: unknown;
        sourceMessageId: null;
        sourceKind: "system";
      }
    | {
        suggestionId: number;
        eventType: BehavioralPolicyReviewDecision;
        detail: unknown;
        sourceMessageId: number;
        sourceKind: "message" | "user_action";
      },
): void {
  db.prepare<[
    number,
    "materialized" | BehavioralPolicyReviewDecision,
    string | null,
    number | null,
    "system" | "message" | "user_action",
    string,
  ]>(
    `INSERT INTO behavioral_policy_suggestion_event
       (suggestion_id, event_type, detail_json, source_message_id, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.suggestionId,
    input.eventType,
    input.detail === null ? null : JSON.stringify(input.detail),
    input.sourceMessageId,
    input.sourceKind,
    now(),
  );
}

function normalizedBehaviorThreshold(value: number | undefined): number {
  return Math.max(2, Math.floor(value ?? 3));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

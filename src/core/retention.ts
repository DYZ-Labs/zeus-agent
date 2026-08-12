import type { Db } from "./db";
import { now, purgeManagedMigrationBackups } from "./db";
import {
  DeletionImpact as DeletionImpactSchema,
  type DeletionImpact,
} from "./contracts";
import { forgetFact, recomputeFactEvidenceAggregates } from "./facts";
import { pruneBehavioralPolicySuggestions } from "./personalization";
import { invalidateWorkPlansForSourceLink } from "./work-plans";

export type ConversationDependencies = {
  messages: number;
  factsOnlyHere: number;
  factsWithOtherEvidence: number;
  candidates: number;
  goals: number;
  commitments: number;
  projects: number;
  workPlans: number;
  followThroughEvents: number;
  behavioralPolicySuggestions: number;
  passages: number;
  facetsOnlyHere: number;
  facetsWithOtherEvidence: number;
  backfillItems: number;
};

export function conversationDependencies(db: Db, conversationId: number): ConversationDependencies {
  const messageIds = idsForConversation(db, conversationId);
  if (messageIds.length === 0) {
    return {
      messages: 0,
      factsOnlyHere: 0,
      factsWithOtherEvidence: 0,
      candidates: 0,
      goals: 0,
      commitments: 0,
      projects: 0,
      workPlans: 0,
      followThroughEvents: 0,
      behavioralPolicySuggestions: 0,
      passages: 0,
      facetsOnlyHere: 0,
      facetsWithOtherEvidence: 0,
      backfillItems: 0,
    };
  }
  const placeholders = messageIds.map(() => "?").join(",");
  const factIds = db
    .prepare<number[], { id: number }>(
      `SELECT DISTINCT f.id
       FROM fact f
       LEFT JOIN fact_evidence e ON e.fact_id = f.id
       WHERE f.source_message_id IN (${placeholders})
          OR e.source_message_id IN (${placeholders})`,
    )
    .all(...messageIds, ...messageIds)
    .map((row) => row.id);

  let factsOnlyHere = 0;
  let factsWithOtherEvidence = 0;
  for (const factId of factIds) {
    const outside = db
      .prepare<[number, ...number[]], { count: number }>(
        `SELECT COUNT(*) AS count FROM fact_evidence
         WHERE fact_id = ? AND source_message_id NOT IN (${placeholders})`,
      )
      .get(factId, ...messageIds)?.count ?? 0;
    if (outside > 0) factsWithOtherEvidence += 1;
    else factsOnlyHere += 1;
  }

  const intentionCount = (
    table: "goal" | "commitment",
    eventTable: "goal_event" | "commitment_event",
    foreignKey: "goal_id" | "commitment_id",
  ): number =>
    db
      .prepare<number[], { count: number }>(
        `SELECT COUNT(DISTINCT t.id) AS count
         FROM ${table} t
         LEFT JOIN ${eventTable} ev ON ev.${foreignKey} = t.id
         WHERE t.source_message_id IN (${placeholders})
            OR ev.source_message_id IN (${placeholders})`,
      )
      .get(...messageIds, ...messageIds)?.count ?? 0;

  const facetIds = db
    .prepare<number[], { id: number }>(
      `SELECT DISTINCT f.id
       FROM understanding_facet f
       LEFT JOIN facet_evidence fe ON fe.facet_id = f.id
       LEFT JOIN evidence_passage p ON p.id = fe.passage_id
       LEFT JOIN facet_event ev ON ev.facet_id = f.id
       WHERE f.source_message_id IN (${placeholders})
          OR p.message_id IN (${placeholders})
          OR ev.source_message_id IN (${placeholders})`,
    )
    .all(...messageIds, ...messageIds, ...messageIds)
    .map((row) => row.id);
  let facetsOnlyHere = 0;
  let facetsWithOtherEvidence = 0;
  for (const facetId of facetIds) {
    const outside = db
      .prepare<[number, ...number[]], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM facet_evidence fe
         JOIN evidence_passage p ON p.id = fe.passage_id
         WHERE fe.facet_id = ? AND p.message_id NOT IN (${placeholders})`,
      )
      .get(facetId, ...messageIds)?.count ?? 0;
    if (outside > 0) facetsWithOtherEvidence += 1;
    else facetsOnlyHere += 1;
  }

  return {
    messages: messageIds.length,
    factsOnlyHere,
    factsWithOtherEvidence,
    candidates:
      db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(DISTINCT c.id) AS count
           FROM memory_candidate c
           LEFT JOIN candidate_evidence ce ON ce.candidate_id = c.id
           LEFT JOIN evidence_passage p ON p.id = ce.passage_id
           WHERE c.source_message_id IN (${placeholders})
              OR p.message_id IN (${placeholders})`,
        )
        .get(...messageIds, ...messageIds)?.count ?? 0,
    goals: intentionCount("goal", "goal_event", "goal_id"),
    commitments: intentionCount("commitment", "commitment_event", "commitment_id"),
    projects: hasTable(db, "project")
      ? db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(DISTINCT p.id) AS count
           FROM project p
           LEFT JOIN project_event ev ON ev.project_id = p.id
           LEFT JOIN evidence_passage ep ON ep.id = ev.passage_id
           WHERE p.source_message_id IN (${placeholders})
              OR ev.source_message_id IN (${placeholders})
              OR ep.message_id IN (${placeholders})`,
        )
        .get(...messageIds, ...messageIds, ...messageIds)?.count ?? 0
      : 0,
    workPlans: hasTable(db, "work_plan")
      ? db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(DISTINCT p.id) AS count
           FROM work_plan p
           LEFT JOIN work_authorization a ON a.work_plan_id = p.id
           LEFT JOIN work_artifact artifact ON artifact.work_plan_id = p.id
           LEFT JOIN work_artifact_source artifact_source
             ON artifact_source.work_artifact_id = artifact.id
           LEFT JOIN work_plan_memory_source_message generation_source
             ON generation_source.work_plan_id = p.id
           WHERE p.source_message_id IN (${placeholders})
              OR a.source_message_id IN (${placeholders})
              OR artifact_source.source_message_id IN (${placeholders})
              OR generation_source.source_message_id IN (${placeholders})`,
        )
        .get(...messageIds, ...messageIds, ...messageIds, ...messageIds)?.count ?? 0
      : 0,
    followThroughEvents:
      db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(*) AS count FROM follow_through_event
           WHERE source_message_id IN (${placeholders})
              OR response_message_id IN (${placeholders})`,
        )
        .get(...messageIds, ...messageIds)?.count ?? 0,
    behavioralPolicySuggestions: hasTable(db, "behavioral_policy_suggestion")
      ? db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(DISTINCT suggestion.id) AS count
           FROM behavioral_policy_suggestion suggestion
           LEFT JOIN behavioral_policy_suggestion_evidence evidence
             ON evidence.suggestion_id = suggestion.id
           LEFT JOIN follow_through_event feedback
             ON feedback.id = evidence.follow_through_event_id
           LEFT JOIN behavioral_policy_suggestion_event review
             ON review.suggestion_id = suggestion.id
           WHERE feedback.source_message_id IN (${placeholders})
              OR feedback.response_message_id IN (${placeholders})
              OR review.source_message_id IN (${placeholders})`,
        )
        .get(...messageIds, ...messageIds, ...messageIds)?.count ?? 0
      : 0,
    passages:
      db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(*) AS count FROM evidence_passage
           WHERE message_id IN (${placeholders})`,
        )
        .get(...messageIds)?.count ?? 0,
    facetsOnlyHere,
    facetsWithOtherEvidence,
    backfillItems:
      db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(*) AS count FROM understanding_backfill_item
           WHERE message_id IN (${placeholders})`,
        )
        .get(...messageIds)?.count ?? 0,
  };
}

/** Consumer-facing summary for the mandatory deletion preview. This deliberately
 * collapses the detailed retention model into plain categories while the deletion
 * implementation continues to use the complete dependency graph above. */
export function conversationDeletionImpact(db: Db, conversationId: number): DeletionImpact {
  const dependencies = conversationDependencies(db, conversationId);
  const messageIds = idsForConversation(db, conversationId);
  const sourceAuditRecords = countSourceAuditRecords(db, messageIds);

  return DeletionImpactSchema.parse({
    messages: dependencies.messages,
    removedMemories: dependencies.factsOnlyHere + dependencies.facetsOnlyHere,
    retainedSharedMemories:
      dependencies.factsWithOtherEvidence + dependencies.facetsWithOtherEvidence,
    affectedPlans:
      dependencies.goals + dependencies.commitments + dependencies.projects +
      dependencies.workPlans,
    affectedAuditRecords:
      dependencies.candidates + dependencies.followThroughEvents +
      dependencies.behavioralPolicySuggestions + dependencies.passages +
      dependencies.backfillItems + sourceAuditRecords,
  });
}

function countSourceAuditRecords(db: Db, messageIds: readonly number[]): number {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => "?").join(",");
  const count = (sql: string, values: readonly number[] = messageIds): number =>
    db.prepare<number[], { count: number }>(sql).get(...values)?.count ?? 0;

  let total = 0;
  total += count(
    `SELECT COUNT(*) AS count FROM extraction_run
     WHERE focus_message_id IN (${placeholders})`,
  );
  total += count(
    `SELECT COUNT(*) AS count FROM candidate_resolution_event
     WHERE source_message_id IN (${placeholders})`,
  );
  total += count(
    responseContextDeletionCountSql(placeholders),
    responseContextDeletionCountValues(messageIds),
  );
  total += count(
    `SELECT COUNT(*) AS count FROM mcp_mutation_event
     WHERE source_message_id IN (${placeholders})`,
  );
  total += count(
    `SELECT COUNT(*) AS count FROM memory_job
     WHERE source_message_id IN (${placeholders})
        OR assistant_message_id IN (${placeholders})`,
    [...messageIds, ...messageIds],
  );
  total += count(
    `SELECT COUNT(*) AS count FROM entity_evidence
     WHERE source_message_id IN (${placeholders})`,
  );
  total += count(
    `SELECT COUNT(*) AS count FROM entity_alias_evidence
     WHERE source_message_id IN (${placeholders})`,
  );
  total += count(
    `SELECT COUNT(*) AS count FROM recommendation_cycle
     WHERE source_message_id IN (${placeholders})`,
  );
  total += count(
    `SELECT COUNT(*) AS count FROM opportunity_delivery
     WHERE response_message_id IN (${placeholders})`,
  );
  total += count(
    `SELECT COUNT(*) AS count FROM fact_evidence
     WHERE source_message_id IN (${placeholders})`,
  );
  total += count(
    `SELECT COUNT(*) AS count FROM facet_event
     WHERE source_message_id IN (${placeholders})`,
  );
  for (const table of ["goal_event", "commitment_event", "project_event"] as const) {
    total += count(
      `SELECT COUNT(*) AS count FROM ${table}
       WHERE source_message_id IN (${placeholders})`,
    );
  }
  total += countMcpRecallRecords(db, messageIds);
  return total;
}

function responseContextDeletionCountSql(placeholders: string): string {
  return `SELECT COUNT(*) AS count FROM response_context context
    WHERE context.assistant_message_id IN (${placeholders})
       OR (context.item_kind = 'episode' AND (
         json_extract(context.snapshot_json, '$.episode.message.id') IN (${placeholders})
         OR context.item_id IN (${placeholders})
       ))
       OR (context.item_kind = 'fact' AND context.item_id IN (
         SELECT DISTINCT fact.id FROM fact
         LEFT JOIN fact_evidence evidence ON evidence.fact_id = fact.id
         WHERE fact.source_message_id IN (${placeholders})
            OR evidence.source_message_id IN (${placeholders})
       ))
       OR (context.item_kind = 'facet' AND context.item_id IN (
         SELECT DISTINCT facet.id FROM understanding_facet facet
         LEFT JOIN facet_evidence evidence ON evidence.facet_id = facet.id
         LEFT JOIN evidence_passage passage ON passage.id = evidence.passage_id
         LEFT JOIN facet_event event ON event.facet_id = facet.id
         WHERE facet.source_message_id IN (${placeholders})
            OR passage.message_id IN (${placeholders})
            OR event.source_message_id IN (${placeholders})
       ))
       OR (context.item_kind = 'goal' AND context.item_id IN (
         SELECT DISTINCT goal.id FROM goal
         LEFT JOIN goal_event event ON event.goal_id = goal.id
         WHERE goal.source_message_id IN (${placeholders})
            OR event.source_message_id IN (${placeholders})
       ))
       OR (context.item_kind = 'commitment' AND context.item_id IN (
         SELECT DISTINCT commitment.id FROM commitment
         LEFT JOIN commitment_event event ON event.commitment_id = commitment.id
         WHERE commitment.source_message_id IN (${placeholders})
            OR event.source_message_id IN (${placeholders})
       ))
       OR (context.item_kind = 'project' AND context.item_id IN (
         SELECT DISTINCT project.id FROM project
         LEFT JOIN project_event event ON event.project_id = project.id
         LEFT JOIN evidence_passage passage ON passage.id = event.passage_id
         WHERE project.source_message_id IN (${placeholders})
            OR event.source_message_id IN (${placeholders})
            OR passage.message_id IN (${placeholders})
       ))`;
}

function responseContextDeletionCountValues(messageIds: readonly number[]): number[] {
  // Keep this exact order/count aligned with responseContextDeletionCountSql.
  return Array.from({ length: 15 }, () => [...messageIds]).flat();
}

/** Count immutable MCP receipts that the evidence-aware deletion path invalidates.
 * These rows have polymorphic item ids rather than message foreign keys, so relying
 * on cascades would make the preview under-report what permanent deletion removes. */
function countMcpRecallRecords(db: Db, messageIds: readonly number[]): number {
  if (messageIds.length === 0) return 0;
  const placeholders = messageIds.map(() => "?").join(",");
  const values: number[] = [];
  const withMessages = (sql: string, repetitions = 1): string => {
    for (let index = 0; index < repetitions; index += 1) values.push(...messageIds);
    return sql.replaceAll("$MESSAGES", placeholders);
  };
  const clauses = [
    withMessages(
      `(item_kind = 'episode' AND (
         json_extract(snapshot_json, '$.source_message_id') IN ($MESSAGES)
         OR json_extract(snapshot_json, '$.message.id') IN ($MESSAGES)
         OR json_extract(snapshot_json, '$.episode.message.id') IN ($MESSAGES)
         OR item_id IN ($MESSAGES)
       ))`,
      4,
    ),
    withMessages(
      `(item_kind = 'fact' AND item_id IN (
         SELECT DISTINCT f.id FROM fact f
         LEFT JOIN fact_evidence evidence ON evidence.fact_id = f.id
         WHERE f.source_message_id IN ($MESSAGES)
            OR evidence.source_message_id IN ($MESSAGES)
       ))`,
      2,
    ),
    withMessages(
      `(item_kind = 'candidate' AND item_id IN (
         SELECT DISTINCT candidate.id FROM memory_candidate candidate
         LEFT JOIN candidate_evidence evidence ON evidence.candidate_id = candidate.id
         LEFT JOIN evidence_passage passage ON passage.id = evidence.passage_id
         WHERE candidate.source_message_id IN ($MESSAGES)
            OR passage.message_id IN ($MESSAGES)
       ))`,
      2,
    ),
    withMessages(
      `(item_kind = 'facet' AND item_id IN (
         SELECT DISTINCT facet.id FROM understanding_facet facet
         LEFT JOIN facet_evidence evidence ON evidence.facet_id = facet.id
         LEFT JOIN evidence_passage passage ON passage.id = evidence.passage_id
         LEFT JOIN facet_event event ON event.facet_id = facet.id
         WHERE facet.source_message_id IN ($MESSAGES)
            OR passage.message_id IN ($MESSAGES)
            OR event.source_message_id IN ($MESSAGES)
       ))`,
      3,
    ),
    withMessages(
      `(item_kind = 'goal' AND item_id IN (
         SELECT DISTINCT goal.id FROM goal
         LEFT JOIN goal_event event ON event.goal_id = goal.id
         WHERE goal.source_message_id IN ($MESSAGES)
            OR event.source_message_id IN ($MESSAGES)
       ))`,
      2,
    ),
    withMessages(
      `(item_kind = 'commitment' AND item_id IN (
         SELECT DISTINCT commitment.id FROM commitment
         LEFT JOIN commitment_event event ON event.commitment_id = commitment.id
         WHERE commitment.source_message_id IN ($MESSAGES)
            OR event.source_message_id IN ($MESSAGES)
       ))`,
      2,
    ),
  ];
  if (hasTable(db, "project")) {
    clauses.push(
      withMessages(
        `(item_kind = 'project' AND item_id IN (
           SELECT DISTINCT project.id FROM project
           LEFT JOIN project_event event ON event.project_id = project.id
           LEFT JOIN evidence_passage passage ON passage.id = event.passage_id
           WHERE project.source_message_id IN ($MESSAGES)
              OR event.source_message_id IN ($MESSAGES)
              OR passage.message_id IN ($MESSAGES)
         ))`,
        3,
      ),
    );
  }
  return db
    .prepare<number[], { count: number }>(
      `SELECT COUNT(DISTINCT id) AS count FROM mcp_recall_audit
       WHERE ${clauses.join(" OR ")}`,
    )
    .get(...values)?.count ?? 0;
}

/**
 * Explicit source deletion. Multiply evidenced facts survive with a real remaining
 * source; memories supported only by the deleted conversation are removed with it.
 */
function deleteConversationRowsWithMemory(
  db: Db,
  conversationId: number,
): ConversationDependencies {
  const dependencies = conversationDependencies(db, conversationId);
  const messageIds = idsForConversation(db, conversationId);

  db.transaction(() => {
    if (messageIds.length === 0) {
      db.prepare<[number]>("DELETE FROM conversation WHERE id = ?").run(conversationId);
      return;
    }
    const placeholders = messageIds.map(() => "?").join(",");
    const passageIds = db
      .prepare<number[], { id: number }>(
        `SELECT id FROM evidence_passage WHERE message_id IN (${placeholders})`,
      )
      .all(...messageIds)
      .map((row) => row.id);
    const sourceEntityIds = db
      .prepare<number[], { id: number }>(
        `SELECT DISTINCT entity_id AS id FROM entity_evidence
         WHERE source_message_id IN (${placeholders})
         UNION
         SELECT DISTINCT entity_id AS id FROM entity_alias_evidence
         WHERE source_message_id IN (${placeholders})`,
      )
      .all(...messageIds, ...messageIds)
      .map((row) => row.id);
    const sourceCandidateIds = db
      .prepare<number[], { id: number }>(
        `SELECT DISTINCT c.id
         FROM memory_candidate c
         LEFT JOIN candidate_evidence ce ON ce.candidate_id = c.id
         LEFT JOIN evidence_passage p ON p.id = ce.passage_id
         WHERE c.source_message_id IN (${placeholders})
            OR p.message_id IN (${placeholders})`,
      )
      .all(...messageIds, ...messageIds)
      .map((row) => row.id);
    const affectedBackfillJobIds = db
      .prepare<number[], { id: number }>(
        `SELECT DISTINCT job_id AS id FROM understanding_backfill_item
         WHERE message_id IN (${placeholders})`,
      )
      .all(...messageIds)
      .map((row) => row.id);

    // These audit rows use SET NULL for historical compatibility, but their mutable
    // JSON/error fields may repeat source text. Explicit erasure removes the whole
    // source-linked row instead of keeping an unattributed copy.
    db.prepare<number[]>(
      `DELETE FROM candidate_resolution_event
       WHERE source_message_id IN (${placeholders})`,
    ).run(...messageIds);
    db.prepare<number[]>(
      `DELETE FROM extraction_run
       WHERE focus_message_id IN (${placeholders})`,
    ).run(...messageIds);

    // Suggestions and feedback tied to a deleted source/response are audit data, not
    // canonical memory. Remove them rather than retain a rationale the user deleted.
    db.prepare<number[]>(
      `DELETE FROM follow_through_event
       WHERE source_message_id IN (${placeholders})
          OR response_message_id IN (${placeholders})`,
    ).run(...messageIds, ...messageIds);
    if (hasTable(db, "recommendation_cycle")) {
      db.prepare<number[]>(
        `DELETE FROM recommendation_cycle
         WHERE source_message_id IN (${placeholders})
            OR id IN (
              SELECT opportunity_id FROM opportunity_delivery
              WHERE response_message_id IN (${placeholders})
            )`,
      ).run(...messageIds, ...messageIds);
    }
    db.prepare<[string, ...number[]]>(
      `UPDATE stewardship_setting
       SET mode = 'balanced', source_message_id = NULL, updated_at = ?
       WHERE source_message_id IN (${placeholders})`,
    ).run(now(), ...messageIds);
    if (hasTable(db, "ambient_setting")) {
      const reset = db.prepare<[string, ...number[]]>(
        `UPDATE ambient_setting
         SET enabled = 0,
             timezone = 'UTC',
             quiet_start = '22:00',
             quiet_end = '08:00',
             daily_limit = 1,
             channels_json = '["macos"]',
             location_consent = 0,
             source_message_id = NULL,
             updated_at = ?
         WHERE source_message_id IN (${placeholders})`,
      ).run(now(), ...messageIds);
      if (reset.changes > 0 && hasTable(db, "coarse_location")) {
        db.prepare("DELETE FROM coarse_location WHERE id = 1").run();
      }
    }
    if (sourceCandidateIds.length > 0) {
      const candidatePlaceholders = sourceCandidateIds.map(() => "?").join(",");
      db.prepare<number[]>(
        `DELETE FROM mcp_recall_audit
         WHERE item_kind = 'candidate' AND item_id IN (${candidatePlaceholders})`,
      ).run(...sourceCandidateIds);
    }

    deleteSourceBackedWorkPlans(db, messageIds, placeholders);

    rehomeOrDeleteIntent(db, "commitment", "commitment_event", messageIds, placeholders);
    rehomeOrDeleteIntent(db, "goal", "goal_event", messageIds, placeholders);
    deleteOrRehomeProjects(db, messageIds, passageIds, placeholders);
    if (hasTable(db, "behavioral_policy_suggestion")) {
      pruneBehavioralPolicySuggestions(db);
    }

    const affectedFacts = db
      .prepare<
        number[],
        {
          id: number;
          source_message_id: number | null;
          subject_id: number;
          predicate: string;
          valid_to: string | null;
          superseded_by: number | null;
        }
      >(
        `SELECT DISTINCT f.id, f.source_message_id, f.subject_id, f.predicate,
                         f.valid_to, f.superseded_by
         FROM fact f
         LEFT JOIN fact_evidence e ON e.fact_id = f.id
         WHERE f.source_message_id IN (${placeholders})
            OR e.source_message_id IN (${placeholders})`,
      )
      .all(...messageIds, ...messageIds);

    if (affectedFacts.length > 0) {
      const factPlaceholders = affectedFacts.map(() => "?").join(",");
      db.prepare<number[]>(
        `DELETE FROM response_context
         WHERE item_kind = 'fact' AND item_id IN (${factPlaceholders})`,
      ).run(...affectedFacts.map((fact) => fact.id));
      // MCP snapshots include the evidence array as it existed at recall time. Even
      // when the canonical fact survives on another source, retaining this row would
      // preserve a quote/id from the explicitly deleted conversation.
      db.prepare<number[]>(
        `DELETE FROM mcp_recall_audit
         WHERE item_kind = 'fact' AND item_id IN (${factPlaceholders})`,
      ).run(...affectedFacts.map((fact) => fact.id));
    }

    for (const fact of affectedFacts) {
      let survivesDeletion = true;
      const remaining = db
        .prepare<[number, ...number[]], { source_message_id: number }>(
          `SELECT source_message_id FROM fact_evidence
           WHERE fact_id = ? AND source_message_id NOT IN (${placeholders})
           ORDER BY id LIMIT 1`,
        )
        .get(fact.id, ...messageIds);
      if (fact.source_message_id !== null && messageIds.includes(fact.source_message_id)) {
        if (remaining) {
          db.prepare<[number, number]>(
            "UPDATE fact SET source_message_id = ? WHERE id = ?",
          ).run(remaining.source_message_id, fact.id);
        } else {
          const predecessors = db
            .prepare<[number], { id: number; subject_id: number; predicate: string }>(
              "SELECT id, subject_id, predicate FROM fact WHERE superseded_by = ?",
            )
            .all(fact.id);
          forgetFact(db, fact.id);
          db.prepare<[number]>(
            "DELETE FROM mcp_recall_audit WHERE item_kind = 'fact' AND item_id = ?",
          ).run(fact.id);
          survivesDeletion = false;
          for (const predecessor of predecessors) {
            const hasCurrent = db
              .prepare<[number, string], { found: number }>(
                `SELECT 1 AS found FROM fact
                 WHERE subject_id = ? AND predicate = ? AND valid_to IS NULL
                 LIMIT 1`,
              )
              .get(predecessor.subject_id, predecessor.predicate);
            if (!hasCurrent) {
              db.prepare<[number]>(
                "UPDATE fact SET valid_to = NULL, superseded_by = NULL WHERE id = ?",
              ).run(predecessor.id);
            }
          }
        }
      }

      // The source and the action that closed a fact can live in the same
      // conversation while an independent reassertion lives elsewhere. Rehoming
      // preserves the fact; removing the sole correction must also restore its
      // live state. Keep this check outside the source branch so both cases work.
      if (survivesDeletion) {
        reopenAfterSoleCorrectionDeletion(db, fact, messageIds, placeholders);
        db.prepare<[number, ...number[]]>(
          `DELETE FROM fact_evidence
           WHERE fact_id = ? AND source_message_id IN (${placeholders})`,
        ).run(fact.id, ...messageIds);
        recomputeFactEvidenceAggregates(db, fact.id);
      }
    }

    deleteOrRehomeFacets(db, messageIds, passageIds, placeholders);
    removeAliasesSupportedOnlyHere(db, messageIds, placeholders);

    deleteEpisodeResponseTraces(db, messageIds, passageIds);
    deleteEpisodeMcpTraces(db, messageIds, passageIds);

    if (passageIds.length > 0) {
      const passagePlaceholders = passageIds.map(() => "?").join(",");
      db.prepare<number[]>(
        `DELETE FROM passage_fts WHERE rowid IN (${passagePlaceholders})`,
      ).run(...passageIds);
      db.prepare<number[]>(
        `DELETE FROM passage_embedding WHERE passage_id IN (${passagePlaceholders})`,
      ).run(...passageIds);
    }

    db.prepare<number[]>(
      `DELETE FROM embedding WHERE owner_kind = 'message' AND owner_id IN (${placeholders})`,
    ).run(...messageIds);
    db.prepare<number[]>(
      `DELETE FROM message_fts WHERE rowid IN (${placeholders})`,
    ).run(...messageIds);
    db.prepare<[number]>("DELETE FROM conversation WHERE id = ?").run(conversationId);
    refreshBackfillCountsAfterDeletion(db, affectedBackfillJobIds);
    pruneDeletedSourceEntities(db, sourceEntityIds);
  })();

  return dependencies;
}

/**
 * Explicitly erase one source and then compact/checkpoint the on-disk store. Row
 * deletion alone is insufficient: SQLite may otherwise retain the old message in
 * free pages or the WAL after the action reports success.
 */
export function deleteConversationWithMemory(
  db: Db,
  conversationId: number,
): ConversationDependencies {
  const dependencies = deleteConversationWithMemoryIf(db, conversationId, () => true);
  if (!dependencies) throw new Error("Conversation deletion precondition unexpectedly failed");
  return dependencies;
}

/** Reserve the SQLite writer before rechecking a destructive-action token and keep
 * that reservation through deletion. This closes the preview/delete race across the
 * web process, MCP process, and local worker without weakening the second confirm. */
export function deleteConversationWithMemoryIf(
  db: Db,
  conversationId: number,
  precondition: () => boolean,
): ConversationDependencies | null {
  const dependencies = db.transaction(() => {
    if (!precondition()) return null;
    return deleteConversationRowsWithMemory(db, conversationId);
  }).immediate();
  if (!dependencies) return null;
  finalizeExplicitErasure(db);
  return dependencies;
}

function finalizeExplicitErasure(db: Db): void {
  const databases = db.pragma("database_list") as Array<{ name: string; file: string }>;
  const main = databases.find((row) => row.name === "main");
  if (typeof main?.file !== "string" || !main.file) return;
  if (db.inTransaction) {
    throw new Error("Cannot finalize source erasure while a database transaction is active");
  }

  rebuildFullTextIndexes(db);
  checkpointAndVerifyTruncated(db);
  db.exec("VACUUM");
  checkpointAndVerifyTruncated(db);
  const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error("Source erasure left invalid database references");
  }
  const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Source erasure failed SQLite integrity verification");
  }
  // Pre-migration snapshots are Zeus-managed copies of the same personal store.
  // Once the live database is verified, retaining an older copy would make source
  // deletion misleading. The helper removes only exact, validated sibling backups.
  purgeManagedMigrationBackups(main.file);
}

function rebuildFullTextIndexes(db: Db): void {
  // FTS5 segments are append-oriented. Rebuilding after the logical transaction
  // guarantees a deleted term is absent from every surviving segment before VACUUM.
  for (const table of ["fact_fts", "message_fts", "passage_fts", "facet_fts"] as const) {
    db.exec(`INSERT INTO ${table} (${table}) VALUES ('rebuild')`);
  }
}

function checkpointAndVerifyTruncated(db: Db): void {
  const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
    busy?: number;
    log?: number;
    checkpointed?: number;
  }>;
  const status = result[0];
  if (!status || status.busy !== 0 || status.log !== 0) {
    throw new Error("Could not truncate the SQLite WAL while finalizing source erasure");
  }
}

/**
 * A work plan and every authorization are exact hashes over explicit user instructions.
 * They cannot be rehomed to a different message without falsifying that authorization.
 * Explicit source deletion therefore removes the complete local plan/run/artifact/receipt
 * subtree before deleting the source message; no external state exists to undo.
 */
function deleteSourceBackedWorkPlans(
  db: Db,
  messageIds: number[],
  placeholders: string,
): void {
  if (!hasTable(db, "work_plan")) return;
  const ids = db
    .prepare<number[], { id: number }>(
      `SELECT DISTINCT p.id
       FROM work_plan p
       LEFT JOIN work_authorization a ON a.work_plan_id = p.id
       LEFT JOIN work_artifact artifact ON artifact.work_plan_id = p.id
       LEFT JOIN work_artifact_source artifact_source
         ON artifact_source.work_artifact_id = artifact.id
       LEFT JOIN work_plan_memory_source_message generation_source
         ON generation_source.work_plan_id = p.id
       WHERE p.source_message_id IN (${placeholders})
          OR a.source_message_id IN (${placeholders})
          OR artifact_source.source_message_id IN (${placeholders})
          OR generation_source.source_message_id IN (${placeholders})`,
    )
    .all(...messageIds, ...messageIds, ...messageIds, ...messageIds)
    .map((row) => row.id);
  if (ids.length === 0) return;
  const idPlaceholders = ids.map(() => "?").join(",");
  db.prepare<number[]>(`DELETE FROM work_plan WHERE id IN (${idPlaceholders})`).run(...ids);
}

/**
 * Message ids and passage ids are independent sequences and can collide. Normal
 * traces always have a snapshot, so key deletion by its immutable source message.
 * Snapshot-less rows use metadata to distinguish the known legacy and claim-level
 * layouts; ambiguous transition rows are removed if either deleted id matches.
 */
function deleteEpisodeResponseTraces(
  db: Db,
  messageIds: readonly number[],
  passageIds: readonly number[],
): void {
  const messagePlaceholders = messageIds.map(() => "?").join(",");
  const transitionIds = [...messageIds, ...passageIds];
  const transitionClause = transitionIds.length > 0
    ? ` OR (snapshot_json IS NULL AND selection_reason IS NOT NULL
             AND item_id IN (${transitionIds.map(() => "?").join(",")}))`
    : "";
  db.prepare<number[]>(
    `DELETE FROM response_context
     WHERE item_kind = 'episode' AND (
       (snapshot_json IS NOT NULL
         AND json_extract(snapshot_json, '$.episode.message.id')
             IN (${messagePlaceholders}))
       OR (snapshot_json IS NULL AND selection_reason IS NULL
             AND item_id IN (${messagePlaceholders}))
       ${transitionClause}
     )`,
  ).run(...messageIds, ...messageIds, ...transitionIds);
}

function deleteEpisodeMcpTraces(
  db: Db,
  messageIds: readonly number[],
  passageIds: readonly number[],
): void {
  const messagePlaceholders = messageIds.map(() => "?").join(",");
  const passageClause = passageIds.length > 0
    ? ` OR json_extract(snapshot_json, '$.passage_id')
              IN (${passageIds.map(() => "?").join(",")})
         OR json_extract(snapshot_json, '$.episode.passage_id')
              IN (${passageIds.map(() => "?").join(",")})`
    : "";
  const unknownIds = [...messageIds, ...passageIds];
  const unknownClause = unknownIds.length > 0
    ? ` OR (
           json_extract(snapshot_json, '$.source_message_id') IS NULL
           AND json_extract(snapshot_json, '$.message.id') IS NULL
           AND json_extract(snapshot_json, '$.episode.message.id') IS NULL
           AND json_extract(snapshot_json, '$.passage_id') IS NULL
           AND json_extract(snapshot_json, '$.episode.passage_id') IS NULL
           AND item_id IN (${unknownIds.map(() => "?").join(",")})
         )`
    : "";
  db.prepare<number[]>(
    `DELETE FROM mcp_recall_audit
     WHERE item_kind = 'episode' AND (
       json_extract(snapshot_json, '$.source_message_id')
         IN (${messagePlaceholders})
       OR json_extract(snapshot_json, '$.message.id')
         IN (${messagePlaceholders})
       OR json_extract(snapshot_json, '$.episode.message.id')
         IN (${messagePlaceholders})
       ${passageClause}
       ${unknownClause}
     )`,
  ).run(
    ...messageIds,
    ...messageIds,
    ...messageIds,
    ...passageIds,
    ...passageIds,
    ...unknownIds,
  );
}

function deleteOrRehomeFacets(
  db: Db,
  messageIds: number[],
  passageIds: number[],
  messagePlaceholders: string,
): void {
  const affected = db
    .prepare<number[], { id: number; source_message_id: number }>(
      `SELECT DISTINCT f.id, f.source_message_id
       FROM understanding_facet f
       LEFT JOIN facet_evidence fe ON fe.facet_id = f.id
       LEFT JOIN evidence_passage p ON p.id = fe.passage_id
       LEFT JOIN facet_event ev ON ev.facet_id = f.id
       WHERE f.source_message_id IN (${messagePlaceholders})
          OR p.message_id IN (${messagePlaceholders})
          OR ev.source_message_id IN (${messagePlaceholders})`,
    )
    .all(...messageIds, ...messageIds, ...messageIds);

  if (affected.length > 0) {
    const facetPlaceholders = affected.map(() => "?").join(",");
    db.prepare<number[]>(
      `DELETE FROM response_context
       WHERE item_kind = 'facet' AND item_id IN (${facetPlaceholders})`,
    ).run(...affected.map((facet) => facet.id));
    db.prepare<number[]>(
      `DELETE FROM mcp_recall_audit
       WHERE item_kind = 'facet' AND item_id IN (${facetPlaceholders})`,
    ).run(...affected.map((facet) => facet.id));
  }

  for (const facet of affected) {
    db.prepare<[number, ...number[]]>(
      `DELETE FROM facet_event
       WHERE facet_id = ? AND source_message_id IN (${messagePlaceholders})`,
    ).run(facet.id, ...messageIds);
    const replacement = db
      .prepare<[number, ...number[]], { message_id: number }>(
        `SELECT p.message_id
         FROM facet_evidence fe
         JOIN evidence_passage p ON p.id = fe.passage_id
         WHERE fe.facet_id = ? AND p.message_id NOT IN (${messagePlaceholders})
         ORDER BY fe.id LIMIT 1`,
      )
      .get(facet.id, ...messageIds);

    if (!replacement) {
      const predecessor = db
        .prepare<[number], { id: number }>(
          `SELECT id FROM understanding_facet
           WHERE superseded_by = ?
           ORDER BY valid_from DESC, id DESC LIMIT 1`,
        )
        .get(facet.id);
      deleteFacetCompletely(db, facet.id);
      if (predecessor) reviveFacetIfUncontested(db, predecessor.id);
      continue;
    }

    if (messageIds.includes(facet.source_message_id)) {
      db.prepare<[number, string, number]>(
        `UPDATE understanding_facet
         SET source_message_id = ?, updated_at = ? WHERE id = ?`,
      ).run(replacement.message_id, now(), facet.id);
    }
    if (passageIds.length > 0) {
      const passagePlaceholders = passageIds.map(() => "?").join(",");
      db.prepare<[number, ...number[]]>(
        `DELETE FROM facet_evidence
         WHERE facet_id = ? AND passage_id IN (${passagePlaceholders})`,
      ).run(facet.id, ...passageIds);
    }
    const aggregate = db
      .prepare<[number], { confidence: number | null }>(
        "SELECT MAX(confidence) AS confidence FROM facet_evidence WHERE facet_id = ?",
      )
      .get(facet.id);
    if (aggregate?.confidence !== null && aggregate?.confidence !== undefined) {
      db.prepare<[number, string, number]>(
        "UPDATE understanding_facet SET confidence = ?, updated_at = ? WHERE id = ?",
      ).run(aggregate.confidence, now(), facet.id);
    }
    const current = getFacetRetentionState(db, facet.id);
    if (current?.valid_to !== null && current?.superseded_by === null) {
      const survivingClose = db
        .prepare<[number], { found: number }>(
          "SELECT 1 AS found FROM facet_event WHERE facet_id = ? AND event_type = 'closed' LIMIT 1",
        )
        .get(facet.id);
      if (!survivingClose) {
        db.prepare<[string, number]>(
          `UPDATE understanding_facet
           SET valid_to = NULL, updated_at = ? WHERE id = ?`,
        ).run(now(), facet.id);
      }
    }
  }
}

function getFacetRetentionState(
  db: Db,
  facetId: number,
): { valid_to: string | null; superseded_by: number | null } | null {
  return db
    .prepare<[number], { valid_to: string | null; superseded_by: number | null }>(
      "SELECT valid_to, superseded_by FROM understanding_facet WHERE id = ?",
    )
    .get(facetId) ?? null;
}

function deleteFacetCompletely(db: Db, facetId: number): void {
  db.prepare<[number]>("DELETE FROM facet_fts WHERE rowid = ?").run(facetId);
  db.prepare<[number]>("DELETE FROM facet_embedding WHERE facet_id = ?").run(facetId);
  db.prepare<[number]>(
    "DELETE FROM response_context WHERE item_kind = 'facet' AND item_id = ?",
  ).run(facetId);
  db.prepare<[number]>(
    "DELETE FROM mcp_recall_audit WHERE item_kind = 'facet' AND item_id = ?",
  ).run(facetId);
  db.prepare<[number]>("DELETE FROM understanding_facet WHERE id = ?").run(facetId);
}

function reviveFacetIfUncontested(db: Db, facetId: number): void {
  const facet = db
    .prepare<
      [number],
      {
        kind: string;
        scope_kind: string;
        scope_label: string | null;
        scope_entity_id: number | null;
        scope_goal_id: number | null;
        scope_commitment_id: number | null;
      }
    >(
      `SELECT kind, scope_kind, scope_label, scope_entity_id,
              scope_goal_id, scope_commitment_id
       FROM understanding_facet WHERE id = ?`,
    )
    .get(facetId);
  if (!facet) return;
  const competing = db
    .prepare<
      [string, string, string | null, number | null, number | null, number | null, number],
      { found: number }
    >(
      `SELECT 1 AS found FROM understanding_facet
       WHERE kind = ? AND scope_kind = ? AND scope_label IS ?
         AND scope_entity_id IS ? AND scope_goal_id IS ? AND scope_commitment_id IS ?
         AND valid_to IS NULL AND id != ? LIMIT 1`,
    )
    .get(
      facet.kind,
      facet.scope_kind,
      facet.scope_label,
      facet.scope_entity_id,
      facet.scope_goal_id,
      facet.scope_commitment_id,
      facetId,
    );
  if (!competing) {
    db.prepare<[string, number]>(
      "UPDATE understanding_facet SET valid_to = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?",
    ).run(now(), facetId);
  }
}

function removeAliasesSupportedOnlyHere(
  db: Db,
  messageIds: number[],
  placeholders: string,
): void {
  const aliases = db
    .prepare<
      number[],
      { entity_id: number; alias: string }
    >(
      `SELECT DISTINCT entity_id, alias FROM entity_alias_evidence
       WHERE source_message_id IN (${placeholders})`,
    )
    .all(...messageIds);
  for (const alias of aliases) {
    const survives = db
      .prepare<[number, string, ...number[]], { found: number }>(
        `SELECT 1 AS found FROM entity_alias_evidence
         WHERE entity_id = ? AND alias = ?
           AND source_message_id NOT IN (${placeholders}) LIMIT 1`,
      )
      .get(alias.entity_id, alias.alias, ...messageIds);
    if (!survives) {
      db.prepare<[number, string]>(
        "DELETE FROM entity_alias WHERE entity_id = ? AND alias = ?",
      ).run(alias.entity_id, alias.alias);
    }
  }
}

function pruneDeletedSourceEntities(db: Db, sourceEntityIds: readonly number[]): void {
  if (sourceEntityIds.length === 0) return;
  const placeholders = sourceEntityIds.map(() => "?").join(",");
  const projectGuard = hasTable(db, "project")
    ? "AND NOT EXISTS (SELECT 1 FROM project p WHERE p.entity_id = e.id)"
    : "";
  const candidates = db
    .prepare<number[], { id: number }>(
      `SELECT e.id FROM entity e
       WHERE e.id IN (${placeholders}) AND e.slug != 'self'
         AND NOT EXISTS (SELECT 1 FROM entity_evidence ee WHERE ee.entity_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM fact f WHERE f.subject_id = e.id OR f.object_entity_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM commitment c WHERE c.owner_entity_id = e.id)
         ${projectGuard}
         AND NOT EXISTS (SELECT 1 FROM understanding_facet f WHERE f.scope_entity_id = e.id)`,
    )
    .all(...sourceEntityIds);
  for (const entity of candidates) {
    db.prepare<[number]>("DELETE FROM entity WHERE id = ?").run(entity.id);
  }
}

function refreshBackfillCountsAfterDeletion(db: Db, jobIds: readonly number[]): void {
  for (const jobId of jobIds) {
    const aggregate = db
      .prepare<
        [number],
        {
          conversation_count: number;
          message_count: number;
          processed_count: number;
          last_message_id: number | null;
        }
      >(
        `SELECT COUNT(DISTINCT m.conversation_id) AS conversation_count,
                COUNT(*) AS message_count,
                COALESCE(SUM(CASE WHEN i.status IN ('completed','skipped') THEN 1 ELSE 0 END), 0)
                  AS processed_count,
                MAX(CASE WHEN i.status IN ('completed','skipped') THEN i.message_id END)
                  AS last_message_id
         FROM understanding_backfill_item i
         JOIN message m ON m.id = i.message_id
         WHERE i.job_id = ?`,
      )
      .get(jobId);
    if (!aggregate) continue;
    db.prepare<[number, number, number, number | null, string, number]>(
      `UPDATE understanding_backfill_job
       SET conversation_count = ?, message_count = ?, processed_count = ?,
           last_message_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      aggregate.conversation_count,
      aggregate.message_count,
      aggregate.processed_count,
      aggregate.last_message_id,
      now(),
      jobId,
    );
  }
}

/** Explicitly delete every stored conversation using the same evidence-aware policy. */
export function deleteAllConversationsWithMemory(db: Db): number {
  const conversationIds = db
    .prepare<[], { id: number }>("SELECT id FROM conversation ORDER BY id")
    .all()
    .map((row) => row.id);

  db.transaction(() => {
    for (const conversationId of conversationIds) {
      deleteConversationRowsWithMemory(db, conversationId);
    }
  })();

  finalizeExplicitErasure(db);

  return conversationIds.length;
}

/**
 * Permanently reset the personal store while preserving only the schema, built-in
 * predicate registry, and (when present) the account binding. Unlike source-only
 * deletion, this also removes source-less legacy rows, derived audit state, custom
 * predicates, personalization, location, and experimental work artifacts.
 */
export function clearZeusData(db: Db): number {
  const conversationIds = db
    .prepare<[], { id: number }>("SELECT id FROM conversation ORDER BY id")
    .all()
    .map((row) => row.id);

  db.transaction(() => {
    for (const conversationId of conversationIds) {
      deleteConversationRowsWithMemory(db, conversationId);
    }

    // Explicitly clear source-less and legacy records. Most source-backed rows have
    // already gone through the evidence-aware path above; these statements make the
    // reset complete even for records created by older releases or interrupted jobs.
    db.exec(`
      DELETE FROM behavioral_policy_suggestion;
      DELETE FROM ambient_delivery_attempt;
      DELETE FROM opportunity_delivery;
      DELETE FROM follow_through_event;
      DELETE FROM recommendation_cycle;
      DELETE FROM work_plan;
      DELETE FROM response_context;
      DELETE FROM mcp_recall_audit;
      DELETE FROM mcp_mutation_event;
      DELETE FROM memory_job;
      DELETE FROM understanding_backfill_job;
      DELETE FROM memory_candidate;
      DELETE FROM understanding_facet;
      DELETE FROM commitment;
      DELETE FROM goal;
      DELETE FROM project;
      DELETE FROM fact;
      DELETE FROM evidence_passage;
      DELETE FROM extraction_run;
      DELETE FROM coarse_location;
      DELETE FROM embedding;
      DELETE FROM passage_embedding;
      DELETE FROM facet_embedding;
      DELETE FROM fact_fts;
      DELETE FROM message_fts;
      DELETE FROM passage_fts;
      DELETE FROM facet_fts;
      DELETE FROM entity_evidence;
      DELETE FROM entity_alias_evidence;
    `);

    const self = db
      .prepare<[], { id: number }>("SELECT id FROM entity WHERE slug = 'self'")
      .get();
    if (!self) throw new Error("The Zeus self entity is missing");
    const timestamp = now();
    db.prepare<[string, number]>(
      `UPDATE entity
       SET name = 'You', summary = 'The user Zeus exists to know.',
           updated_at = ?
       WHERE id = ?`,
    ).run(timestamp, self.id);
    db.prepare<[number]>("DELETE FROM entity_alias WHERE entity_id = ?").run(self.id);
    const insertAlias = db.prepare<[number, string, string]>(
      "INSERT INTO entity_alias (entity_id, alias, created_at) VALUES (?, ?, ?)",
    );
    for (const alias of ["me", "i", "myself"] as const) {
      insertAlias.run(self.id, alias, timestamp);
    }
    db.prepare<[number]>("DELETE FROM entity WHERE id != ?").run(self.id);

    const builtInPredicates = [
      "works_at", "job_title", "lives_in", "birthday", "timezone",
      "relationship_to_user", "status", "likes", "dislikes", "knows",
      "works_on", "cares_about", "goal", "prefers", "note",
    ] as const;
    const predicatePlaceholders = builtInPredicates.map(() => "?").join(",");
    db.prepare<string[]>(
      `DELETE FROM predicate WHERE name NOT IN (${predicatePlaceholders})`,
    ).run(...builtInPredicates);

    db.prepare<[string]>(
      `UPDATE stewardship_setting
       SET mode = 'balanced', source_message_id = NULL, updated_at = ?
       WHERE id = 1`,
    ).run(timestamp);
    db.prepare<[string]>(
      `UPDATE ambient_setting
       SET enabled = 0, timezone = 'UTC', quiet_start = '22:00', quiet_end = '08:00',
           daily_limit = 1, channels_json = '["macos"]', location_consent = 0,
           source_message_id = NULL, updated_at = ?
       WHERE id = 1`,
    ).run(timestamp);
    db.prepare<[string]>(
      `UPDATE experience_setting
       SET remembering_mode = 'automatic', onboarding_status = 'welcome',
           labs_enabled = 0, updated_at = ?
       WHERE id = 1`,
    ).run(timestamp);
  })();

  finalizeExplicitErasure(db);
  return conversationIds.length;
}

function reopenAfterSoleCorrectionDeletion(
  db: Db,
  fact: {
    id: number;
    subject_id: number;
    predicate: string;
    valid_to: string | null;
    superseded_by: number | null;
  },
  messageIds: number[],
  placeholders: string,
): void {
  if (fact.valid_to === null || fact.superseded_by !== null) return;

  const deletingCorrection = db
    .prepare<[number, ...number[]], { count: number }>(
      `SELECT COUNT(*) AS count FROM fact_evidence
       WHERE fact_id = ? AND kind = 'correction'
         AND source_message_id IN (${placeholders})`,
    )
    .get(fact.id, ...messageIds)?.count ?? 0;
  const remainingCorrection = db
    .prepare<[number, ...number[]], { count: number }>(
      `SELECT COUNT(*) AS count FROM fact_evidence
       WHERE fact_id = ? AND kind = 'correction'
         AND source_message_id NOT IN (${placeholders})`,
    )
    .get(fact.id, ...messageIds)?.count ?? 0;
  if (deletingCorrection === 0 || remainingCorrection > 0) return;

  const hasCurrent = db
    .prepare<[number, string], { found: number }>(
      `SELECT 1 AS found FROM fact
       WHERE subject_id = ? AND predicate = ? AND valid_to IS NULL
       LIMIT 1`,
    )
    .get(fact.subject_id, fact.predicate);
  if (!hasCurrent) {
    db.prepare<[number]>(
      "UPDATE fact SET valid_to = NULL, superseded_by = NULL WHERE id = ?",
    ).run(fact.id);
  }
}

function rehomeOrDeleteIntent(
  db: Db,
  table: "goal" | "commitment",
  eventTable: "goal_event" | "commitment_event",
  messageIds: number[],
  placeholders: string,
): void {
  const rows = db
    .prepare<number[], { id: number; source_message_id: number }>(
      `SELECT DISTINCT t.id, t.source_message_id
       FROM ${table} t
       LEFT JOIN ${eventTable} ev ON ev.${table === "goal" ? "goal_id" : "commitment_id"} = t.id
       WHERE t.source_message_id IN (${placeholders})
          OR ev.source_message_id IN (${placeholders})`,
    )
    .all(...messageIds, ...messageIds);
  const foreignKey = table === "goal" ? "goal_id" : "commitment_id";

  for (const row of rows) {
    db.prepare<[string, number]>(
      "DELETE FROM response_context WHERE item_kind = ? AND item_id = ?",
    ).run(table, row.id);
    db.prepare<[string, number]>(
      "DELETE FROM mcp_recall_audit WHERE item_kind = ? AND item_id = ?",
    ).run(table, row.id);
    if (table === "commitment" && hasTable(db, "recommendation_cycle")) {
      db.prepare<[number]>(
        "DELETE FROM recommendation_cycle WHERE selected_commitment_id = ?",
      ).run(row.id);
    }
    if (table === "goal" && hasTable(db, "recommendation_cycle")) {
      db.prepare<[number]>(
        `DELETE FROM recommendation_cycle
         WHERE selected_commitment_id IN (
           SELECT id FROM commitment WHERE linked_goal_id = ?
         )`,
      ).run(row.id);
      db.prepare<[number]>("DELETE FROM follow_through_event WHERE goal_id = ?").run(row.id);
    }
    // The zeus_projects read stores linked intention snapshots inside the project
    // audit item. Remove that composite trace when one nested source is deleted.
    const nestedPath = table === "goal" ? "$.goals" : "$.commitments";
    db.prepare<[string, number]>(
      `DELETE FROM mcp_recall_audit
       WHERE item_kind = 'project' AND json_valid(snapshot_json)
         AND EXISTS (
           SELECT 1 FROM json_each(snapshot_json, ?)
           WHERE json_extract(value, '$.id') = ?
         )`,
    ).run(nestedPath, row.id);
    if (messageIds.includes(row.source_message_id)) {
      const replacement = db
        .prepare<[number, ...number[]], { source_message_id: number }>(
          `SELECT source_message_id FROM ${eventTable}
           WHERE ${foreignKey} = ?
             AND source_message_id IS NOT NULL
             AND source_message_id NOT IN (${placeholders})
           ORDER BY id LIMIT 1`,
        )
        .get(row.id, ...messageIds);
      if (replacement) {
        db.prepare<[number, number]>(
          `UPDATE ${table} SET source_message_id = ? WHERE id = ?`,
        ).run(replacement.source_message_id, row.id);
      } else {
        invalidateWorkPlansForSourceLink(db, table, row.id);
        deleteFacetsScopedTo(db, table, row.id);
        db.prepare<[number]>(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
        continue;
      }
    }

    // Event detail is field-level provenance and can retain deleted text even after
    // its FK is nulled. Remove those events, then deterministically replay only the
    // surviving field changes into the current projection.
    db.prepare<[number, ...number[]]>(
      `DELETE FROM ${eventTable}
       WHERE ${foreignKey} = ? AND source_message_id IN (${placeholders})`,
    ).run(row.id, ...messageIds);
    sanitizeSurvivingLifecycleEvents(db, eventTable, foreignKey, row.id);
    if (!replayIntentProjection(db, table, eventTable, row.id)) {
      // If surviving provenance cannot reconstruct the projection, removing the
      // intention is safer than retaining fields that may only have come from the
      // deleted source.
      invalidateWorkPlansForSourceLink(db, table, row.id);
      deleteFacetsScopedTo(db, table, row.id);
      db.prepare<[number]>(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
    }
  }
}

/**
 * Remove project state derived from an explicitly deleted conversation while
 * retaining a lifecycle that still has independent user provenance. Project event
 * detail can contain the user's deleted wording, so affected immutable recall traces
 * and the events themselves are removed rather than merely allowing their message
 * foreign keys to become null.
 */
function deleteOrRehomeProjects(
  db: Db,
  messageIds: number[],
  passageIds: number[],
  placeholders: string,
): void {
  if (!hasTable(db, "project")) return;
  const affected = db
    .prepare<
      number[],
      { id: number; source_message_id: number }
    >(
      `SELECT DISTINCT p.id, p.source_message_id
       FROM project p
       LEFT JOIN project_event ev ON ev.project_id = p.id
       LEFT JOIN evidence_passage ep ON ep.id = ev.passage_id
       WHERE p.source_message_id IN (${placeholders})
          OR ev.source_message_id IN (${placeholders})
          OR ep.message_id IN (${placeholders})`,
    )
    .all(...messageIds, ...messageIds, ...messageIds);

  const passagePlaceholders = passageIds.map(() => "?").join(",");
  for (const project of affected) {
    db.prepare<[number]>(
      "DELETE FROM response_context WHERE item_kind = 'project' AND item_id = ?",
    ).run(project.id);
    db.prepare<[number]>(
      "DELETE FROM mcp_recall_audit WHERE item_kind = 'project' AND item_id = ?",
    ).run(project.id);

    if (messageIds.includes(project.source_message_id)) {
      const replacement = survivingProjectIdentitySource(
        db,
        project.id,
        messageIds,
        placeholders,
      );
      if (!replacement) {
        invalidateWorkPlansForSourceLink(db, "project", project.id);
        db.prepare<[number]>("DELETE FROM project WHERE id = ?").run(project.id);
        continue;
      }
      db.prepare<[number, number]>(
        "UPDATE project SET source_message_id = ? WHERE id = ?",
      ).run(replacement.source_message_id, project.id);
    }

    if (passageIds.length > 0) {
      db.prepare<unknown[]>(
        `DELETE FROM project_event
         WHERE project_id = ? AND (
           source_message_id IN (${placeholders})
           OR passage_id IN (${passagePlaceholders})
         )`,
      ).run(project.id, ...messageIds, ...passageIds);
    } else {
      db.prepare<[number, ...number[]]>(
        `DELETE FROM project_event
         WHERE project_id = ? AND source_message_id IN (${placeholders})`,
      ).run(project.id, ...messageIds);
    }

    sanitizeSurvivingLifecycleEvents(db, "project_event", "project_id", project.id);
    if (!replayProjectProjection(db, project.id)) {
      invalidateWorkPlansForSourceLink(db, "project", project.id);
      db.prepare<[number]>("DELETE FROM project WHERE id = ?").run(project.id);
    }
  }
}

/** A lifecycle event can say only "it is active now". That is evidence for a status
 * transition, but not for the named project identity inherited from a deleted source.
 * Rehome the project root only to an independently evidenced identity/name mention. */
function survivingProjectIdentitySource(
  db: Db,
  projectId: number,
  deletedMessageIds: readonly number[],
  placeholders: string,
): { source_message_id: number } | null {
  const project = db
    .prepare<[number], { entity_id: number; entity_name: string }>(
      `SELECT project.entity_id, entity.name AS entity_name
       FROM project JOIN entity ON entity.id = project.entity_id
       WHERE project.id = ?`,
    )
    .get(projectId);
  if (!project) return null;

  const recorded = db
    .prepare<[number, ...number[]], { source_message_id: number }>(
      `SELECT source_message_id FROM (
         SELECT source_message_id, created_at FROM entity_evidence
         WHERE entity_id = ? AND source_message_id NOT IN (${placeholders})
         UNION ALL
         SELECT source_message_id, created_at FROM entity_alias_evidence
         WHERE entity_id = ? AND source_message_id NOT IN (${placeholders})
       )
       ORDER BY created_at, source_message_id LIMIT 1`,
    )
    .get(
      project.entity_id,
      ...deletedMessageIds,
      project.entity_id,
      ...deletedMessageIds,
    );
  if (recorded) return recorded;

  // Compatibility for early local project rows created before entity-evidence
  // writes were universal: a surviving user message that explicitly names the
  // project (or one of its aliases) is still real supporting evidence.
  return db
    .prepare<[number, ...number[]], { source_message_id: number }>(
      `SELECT event.source_message_id
       FROM project_event event
       JOIN message source ON source.id = event.source_message_id
       JOIN project ON project.id = event.project_id
       JOIN entity ON entity.id = project.entity_id
       WHERE event.project_id = ?
         AND event.source_message_id IS NOT NULL
         AND event.source_message_id NOT IN (${placeholders})
         AND source.role = 'user'
         AND (
           instr(lower(source.content), lower(entity.name)) > 0
           OR EXISTS (
             SELECT 1 FROM entity_alias alias
             WHERE alias.entity_id = entity.id
               AND length(alias.alias) >= 3
               AND instr(lower(source.content), lower(alias.alias)) > 0
           )
         )
       ORDER BY event.id LIMIT 1`,
    )
    .get(projectId, ...deletedMessageIds) ?? null;
}

/**
 * Later lifecycle events historically stored complete before/after projections. If an
 * earlier source is explicitly deleted, those inherited snapshots can retain its text
 * even though the later event did not assert it. Keep only the later source's actual
 * field delta and its new status; remove the prior-state snapshot in place as part of
 * the explicit deletion transaction. Event identity, source, time, and ordering remain
 * intact, so surviving provenance stays append-only and auditable.
 */
function sanitizeSurvivingLifecycleEvents(
  db: Db,
  eventTable: "goal_event" | "commitment_event" | "project_event",
  foreignKey: "goal_id" | "commitment_id" | "project_id",
  ownerId: number,
): void {
  const events = db
    .prepare<
      [number],
      {
        id: number;
        event_type: string;
        from_status: string | null;
        to_status: string | null;
        detail_json: string | null;
      }
    >(
      `SELECT id, event_type, from_status, to_status, detail_json
       FROM ${eventTable} WHERE ${foreignKey} = ? ORDER BY id`,
    )
    .all(ownerId);
  const update = db.prepare<[string | null, string | null, number]>(
    `UPDATE ${eventTable}
     SET detail_json = ?, from_status = NULL, to_status = ? WHERE id = ?`,
  );

  for (const event of events) {
    if (event.event_type === "created") continue;
    const detail = parseReplayDetail(event.detail_json);
    let sanitizedDetail = event.detail_json;
    if (detail?.before && detail.after) {
      const changes: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(detail.after)) {
        if (!Object.hasOwn(detail.before, name) || !sameReplayValue(detail.before[name], value)) {
          changes[name] = value;
        }
      }
      sanitizedDetail = Object.keys(changes).length > 0
        ? JSON.stringify({ changes })
        : null;
    }
    const changedStatus = event.to_status !== null && event.to_status !== event.from_status;
    update.run(sanitizedDetail, changedStatus ? event.to_status : null, event.id);
  }
}

function hasTable(db: Db, table: string): boolean {
  return Boolean(
    db
      .prepare<[string], { found: number }>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table),
  );
}

type ProjectReplayProjection = {
  status: string;
  progressSummary: string | null;
  progressPercent: number | null;
  blockedAt: string | null;
  confidence: number;
  updatedAt: string;
  closedAt: string | null;
};

/** Rebuild the mutable project row solely from the surviving append-only events. */
function replayProjectProjection(db: Db, projectId: number): boolean {
  const events = db
    .prepare<[number], EventReplayRow>(
      `SELECT event_type, from_status, to_status, detail_json, created_at
       FROM project_event WHERE project_id = ? ORDER BY id`,
    )
    .all(projectId);
  if (events.length === 0) return false;

  let projection: ProjectReplayProjection | null = null;
  for (const event of events) {
    const detail = parseJsonRecord(event.detail_json);
    if (event.event_type === "created") {
      const status = projectStatus(event.to_status);
      const confidence = replayNumber(detail?.confidence);
      if (!status || confidence === null) continue;
      projection = {
        status,
        progressSummary: replayNullableString(detail?.progress_summary),
        progressPercent: replayNullableNumber(detail?.progress_percent),
        blockedAt: null,
        confidence,
        updatedAt: event.created_at,
        closedAt: isClosedProjectStatus(status) ? event.created_at : null,
      };
      continue;
    }

    // A later source can preserve a project even if its original creation source was
    // deleted. Start conservatively: status transitions are evidenced by the event,
    // while progress text from a deleted earlier source is not copied from a before
    // snapshot. Confidence is policy metadata rather than a user claim.
    projection ??= {
      status: projectStatus(event.from_status) ?? projectStatus(event.to_status) ?? "planned",
      progressSummary: null,
      progressPercent: null,
      blockedAt: null,
      confidence: 0.8,
      updatedAt: event.created_at,
      closedAt: null,
    };

    if (event.event_type === "updated" || event.event_type === "status_changed") {
      const changes = replayEventChanges(detail);
      if (Object.hasOwn(changes, "progress_summary")) {
        projection.progressSummary = replayNullableString(changes.progress_summary);
      }
      if (Object.hasOwn(changes, "progress_percent")) {
        projection.progressPercent = replayNullableNumber(changes.progress_percent);
      }
      if (Object.hasOwn(changes, "blocked_at")) {
        projection.blockedAt = replayNullableString(changes.blocked_at);
      }
      if (Object.hasOwn(changes, "confidence")) {
        const confidence = replayNumber(changes.confidence);
        if (confidence !== null) projection.confidence = confidence;
      }
    } else if (event.event_type === "progress") {
      const changes = replayEventChanges(detail);
      if (Object.hasOwn(changes, "summary")) {
        projection.progressSummary = replayNullableString(changes.summary);
      }
      if (Object.hasOwn(changes, "percent")) {
        projection.progressPercent = replayNullableNumber(changes.percent);
      }
    } else if (event.event_type === "blocked") {
      projection.blockedAt = replayNullableString(detail?.blocked_at) ?? event.created_at;
    } else if (event.event_type === "unblocked") {
      projection.blockedAt = null;
    }

    const nextStatus = projectStatus(event.to_status);
    if (nextStatus) projection.status = nextStatus;
    projection.updatedAt = event.created_at;
    projection.closedAt = isClosedProjectStatus(projection.status)
      ? projection.closedAt ?? event.created_at
      : null;
  }

  if (!projection) return false;
  db.prepare<[
    string,
    string | null,
    number | null,
    string | null,
    number,
    string,
    string | null,
    number,
  ]>(
    `UPDATE project
     SET status = ?, progress_summary = ?, progress_percent = ?, blocked_at = ?,
         confidence = ?, updated_at = ?, closed_at = ?
     WHERE id = ?`,
  ).run(
    projection.status,
    projection.progressSummary,
    projection.progressPercent,
    projection.blockedAt,
    projection.confidence,
    projection.updatedAt,
    projection.closedAt,
    projectId,
  );
  return true;
}

function projectStatus(value: string | null): string | null {
  return value === "planned" || value === "active" || value === "paused" ||
      value === "completed" || value === "abandoned"
    ? value
    : null;
}

function isClosedProjectStatus(status: string): boolean {
  return status === "completed" || status === "abandoned";
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return asReplayRecord(parsed);
  } catch {
    return null;
  }
}

function replayEventChanges(detail: Record<string, unknown> | null): Record<string, unknown> {
  const explicit = asReplayRecord(detail?.changes);
  if (explicit) return explicit;
  const before = asReplayRecord(detail?.before);
  const after = asReplayRecord(detail?.after);
  if (!before || !after) return {};
  return Object.fromEntries(
    Object.entries(after).filter(
      ([name, value]) => !Object.hasOwn(before, name) || !sameReplayValue(before[name], value),
    ),
  );
}

function deleteFacetsScopedTo(
  db: Db,
  table: "goal" | "commitment",
  id: number,
): void {
  const scopeColumn = table === "goal" ? "scope_goal_id" : "scope_commitment_id";
  const facets = db
    .prepare<[number], { id: number }>(
      `SELECT id FROM understanding_facet WHERE ${scopeColumn} = ?`,
    )
    .all(id);
  for (const facet of facets) deleteFacetCompletely(db, facet.id);
}

type EventReplayRow = {
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  detail_json: string | null;
  created_at: string;
};

function replayIntentProjection(
  db: Db,
  table: "goal" | "commitment",
  eventTable: "goal_event" | "commitment_event",
  id: number,
): boolean {
  const foreignKey = table === "goal" ? "goal_id" : "commitment_id";
  const events = db
    .prepare<[number], EventReplayRow>(
      `SELECT event_type, from_status, to_status, detail_json, created_at
       FROM ${eventTable} WHERE ${foreignKey} = ? ORDER BY id`,
    )
    .all(id);
  if (events.length === 0) return false;

  let fields: Record<string, unknown> | null = null;
  let status: string | null = null;
  let closedAt: string | null = null;
  let lastSurfacedAt: string | null = null;
  let updatedAt = events[0]?.created_at ?? now();

  for (const event of events) {
    if (event.event_type !== "surfaced") updatedAt = event.created_at;
    const detail = parseReplayDetail(event.detail_json);
    if (event.event_type === "created" && detail?.direct) {
      fields = { ...detail.direct };
      status = event.to_status;
    } else {
      const changes = replayIntentChanges(detail);
      if (Object.keys(changes).length > 0) {
        fields ??= {};
        Object.assign(fields, changes);
      }
      if (event.to_status !== null) {
        status = event.to_status;
      }
    }
    if (event.event_type === "surfaced") lastSurfacedAt = event.created_at;
    if (status === "achieved" || status === "abandoned" || status === "done" || status === "cancelled") {
      closedAt ??= event.created_at;
    } else {
      closedAt = null;
    }
  }
  if (!fields || !status) return false;

  if (table === "goal") {
    const title = replayString(fields.title);
    const priority = replayString(fields.priority);
    const confidence = replayNumber(fields.confidence);
    if (!title || !["low", "normal", "high"].includes(priority ?? "") || confidence === null) {
      return false;
    }
    db.prepare<
      [
        string,
        string,
        string,
        string | null,
        number | null,
        number,
        string,
        string | null,
        number,
      ]
    >(
      `UPDATE goal SET title = ?, status = ?, priority = ?, target_at = ?,
                       project_id = ?, confidence = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    ).run(
      title,
      status,
      priority!,
      replayNullableString(fields.target_at),
      replayNullableNumber(fields.project_id),
      confidence,
      updatedAt,
      closedAt,
      id,
    );
    return true;
  }

  const title = replayString(fields.title);
  const ownerId = replayNumber(fields.owner_entity_id);
  const confidence = replayNumber(fields.confidence);
  if (!title || ownerId === null || confidence === null) return false;
  db.prepare<
    [
      string,
      number,
      number | null,
      number | null,
      string,
      string | null,
      string | null,
      number,
      string | null,
      string,
      string | null,
      number,
    ]
  >(
    `UPDATE commitment
     SET title = ?, owner_entity_id = ?, linked_goal_id = ?, project_id = ?, status = ?,
         due_at = ?, snoozed_until = ?, confidence = ?, last_surfaced_at = ?,
         updated_at = ?, closed_at = ?
     WHERE id = ?`,
  ).run(
    title,
    ownerId,
    replayNullableNumber(fields.linked_goal_id),
    replayNullableNumber(fields.project_id),
    status,
    replayNullableString(fields.due_at),
    replayNullableString(fields.snoozed_until),
    confidence,
    lastSurfacedAt,
    updatedAt,
    closedAt,
    id,
  );
  return true;
}

function parseReplayDetail(value: string | null): {
  direct?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changes?: Record<string, unknown>;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const before = asReplayRecord(record.before);
    const after = asReplayRecord(record.after);
    const changes = asReplayRecord(record.changes);
    if (changes) return { changes };
    return before && after ? { before, after } : { direct: record };
  } catch {
    return null;
  }
}

function replayIntentChanges(
  detail: ReturnType<typeof parseReplayDetail>,
): Record<string, unknown> {
  if (detail?.changes) return detail.changes;
  if (!detail?.before || !detail.after) return {};
  return Object.fromEntries(
    Object.entries(detail.after).filter(
      ([name, value]) =>
        !Object.hasOwn(detail.before!, name) ||
        !sameReplayValue(detail.before![name], value),
    ),
  );
}

function asReplayRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function sameReplayValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function replayString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function replayNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function replayNullableString(value: unknown): string | null {
  return value === null ? null : replayString(value);
}

function replayNullableNumber(value: unknown): number | null {
  return value === null ? null : replayNumber(value);
}

function idsForConversation(db: Db, conversationId: number): number[] {
  return db
    .prepare<[number], { id: number }>(
      "SELECT id FROM message WHERE conversation_id = ? ORDER BY id",
    )
    .all(conversationId)
    .map((row) => row.id);
}

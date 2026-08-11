import type { Db } from "./db";
import { now } from "./db";
import { forgetFact, recomputeFactEvidenceAggregates } from "./facts";

export type ConversationDependencies = {
  messages: number;
  factsOnlyHere: number;
  factsWithOtherEvidence: number;
  candidates: number;
  goals: number;
  commitments: number;
  followThroughEvents: number;
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
      followThroughEvents: 0,
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
       WHERE f.source_message_id IN (${placeholders})
          OR p.message_id IN (${placeholders})`,
    )
    .all(...messageIds, ...messageIds)
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
    followThroughEvents:
      db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(*) AS count FROM follow_through_event
           WHERE source_message_id IN (${placeholders})
              OR response_message_id IN (${placeholders})`,
        )
        .get(...messageIds, ...messageIds)?.count ?? 0,
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

/**
 * Explicit source deletion. Multiply evidenced facts survive with a real remaining
 * source; memories supported only by the deleted conversation are removed with it.
 */
export function deleteConversationWithMemory(
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

    // Suggestions and feedback tied to a deleted source/response are audit data, not
    // canonical memory. Remove them rather than retain a rationale the user deleted.
    db.prepare<number[]>(
      `DELETE FROM follow_through_event
       WHERE source_message_id IN (${placeholders})
          OR response_message_id IN (${placeholders})`,
    ).run(...messageIds, ...messageIds);
    db.prepare<[string, ...number[]]>(
      `UPDATE stewardship_setting
       SET mode = 'balanced', source_message_id = NULL, updated_at = ?
       WHERE source_message_id IN (${placeholders})`,
    ).run(now(), ...messageIds);
    if (sourceCandidateIds.length > 0) {
      const candidatePlaceholders = sourceCandidateIds.map(() => "?").join(",");
      db.prepare<number[]>(
        `DELETE FROM mcp_recall_audit
         WHERE item_kind = 'candidate' AND item_id IN (${candidatePlaceholders})`,
      ).run(...sourceCandidateIds);
    }

    rehomeOrDeleteIntent(db, "commitment", "commitment_event", messageIds, placeholders);
    rehomeOrDeleteIntent(db, "goal", "goal_event", messageIds, placeholders);

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
       WHERE f.source_message_id IN (${messagePlaceholders})
          OR p.message_id IN (${messagePlaceholders})`,
    )
    .all(...messageIds, ...messageIds);

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
  }
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
  const candidates = db
    .prepare<number[], { id: number }>(
      `SELECT e.id FROM entity e
       WHERE e.id IN (${placeholders}) AND e.slug != 'self'
         AND NOT EXISTS (SELECT 1 FROM entity_evidence ee WHERE ee.entity_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM fact f WHERE f.subject_id = e.id OR f.object_entity_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM commitment c WHERE c.owner_entity_id = e.id)
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
      deleteConversationWithMemory(db, conversationId);
    }
  })();

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
    if (!replayIntentProjection(db, table, eventTable, row.id)) {
      // If surviving provenance cannot reconstruct the projection, removing the
      // intention is safer than retaining fields that may only have come from the
      // deleted source.
      deleteFacetsScopedTo(db, table, row.id);
      db.prepare<[number]>(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
    }
  }
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
      if (!fields && detail?.before) {
        fields = { ...detail.before };
        status = event.from_status;
      }
      if (fields && detail?.before && detail.after) {
        for (const [name, value] of Object.entries(detail.after)) {
          if (!sameReplayValue(detail.before[name], value)) fields[name] = value;
        }
      }
      if (event.to_status !== null && event.to_status !== event.from_status) {
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
      [string, string, string, string | null, number, string, string | null, number]
    >(
      `UPDATE goal SET title = ?, status = ?, priority = ?, target_at = ?,
                       confidence = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    ).run(
      title,
      status,
      priority!,
      replayNullableString(fields.target_at),
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
    [string, number, number | null, string, string | null, string | null, number, string | null, string, string | null, number]
  >(
    `UPDATE commitment
     SET title = ?, owner_entity_id = ?, linked_goal_id = ?, status = ?,
         due_at = ?, snoozed_until = ?, confidence = ?, last_surfaced_at = ?,
         updated_at = ?, closed_at = ?
     WHERE id = ?`,
  ).run(
    title,
    ownerId,
    replayNullableNumber(fields.linked_goal_id),
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
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const before = asReplayRecord(record.before);
    const after = asReplayRecord(record.after);
    return before && after ? { before, after } : { direct: record };
  } catch {
    return null;
  }
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

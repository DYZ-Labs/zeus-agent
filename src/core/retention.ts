import type { Db } from "./db";
import { forgetFact } from "./facts";

export type ConversationDependencies = {
  messages: number;
  factsOnlyHere: number;
  factsWithOtherEvidence: number;
  candidates: number;
  goals: number;
  commitments: number;
  followThroughEvents: number;
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

  const scalar = (table: string): number =>
    db
      .prepare<number[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE source_message_id IN (${placeholders})`,
      )
      .get(...messageIds)?.count ?? 0;

  return {
    messages: messageIds.length,
    factsOnlyHere,
    factsWithOtherEvidence,
    candidates: scalar("memory_candidate"),
    goals: scalar("goal"),
    commitments: scalar("commitment"),
    followThroughEvents:
      db
        .prepare<number[], { count: number }>(
          `SELECT COUNT(*) AS count FROM follow_through_event
           WHERE source_message_id IN (${placeholders})
              OR response_message_id IN (${placeholders})`,
        )
        .get(...messageIds, ...messageIds)?.count ?? 0,
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

    // Suggestions and feedback tied to a deleted source/response are audit data, not
    // canonical memory. Remove them rather than retain a rationale the user deleted.
    db.prepare<number[]>(
      `DELETE FROM follow_through_event
       WHERE source_message_id IN (${placeholders})
          OR response_message_id IN (${placeholders})`,
    ).run(...messageIds, ...messageIds);

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
      }
    }

    db.prepare<number[]>(
      `DELETE FROM embedding WHERE owner_kind = 'message' AND owner_id IN (${placeholders})`,
    ).run(...messageIds);
    db.prepare<number[]>(
      `DELETE FROM response_context WHERE item_kind = 'episode' AND item_id IN (${placeholders})`,
    ).run(...messageIds);
    db.prepare<number[]>(
      `DELETE FROM message_fts WHERE rowid IN (${placeholders})`,
    ).run(...messageIds);
    db.prepare<[number]>("DELETE FROM conversation WHERE id = ?").run(conversationId);
  })();

  return dependencies;
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
    .prepare<number[], { id: number }>(
      `SELECT id FROM ${table} WHERE source_message_id IN (${placeholders})`,
    )
    .all(...messageIds);
  const foreignKey = table === "goal" ? "goal_id" : "commitment_id";

  for (const row of rows) {
    db.prepare<[string, number]>(
      "DELETE FROM response_context WHERE item_kind = ? AND item_id = ?",
    ).run(table, row.id);
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
      db.prepare<[number]>(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
    }
  }
}

function idsForConversation(db: Db, conversationId: number): number[] {
  return db
    .prepare<[number], { id: number }>(
      "SELECT id FROM message WHERE conversation_id = ? ORDER BY id",
    )
    .all(conversationId)
    .map((row) => row.id);
}

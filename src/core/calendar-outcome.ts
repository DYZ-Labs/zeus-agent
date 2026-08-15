import type { Db } from "./db";
import { now } from "./db";
import { CalendarOutcome } from "./schema";

/**
 * The deterministic account of what a calendar request did, kept with the turn.
 *
 * Live, the outcome reaches the browser in the streaming frame and drives the card. Reload
 * the page and that frame is gone, which left the assistant's prose as the only surviving
 * record of what happened — the one thing the card exists so as not to depend on. A change
 * carried out, a change waiting on confirmation, and a change refused are then
 * indistinguishable except by whatever the model happened to write.
 *
 * Stored rather than recomputed. Most outcomes could be rebuilt from the run, the way
 * `response-context.ts` rebuilds a memory trace — but the two worth surfacing most, nothing
 * connected and a request Zeus could not resolve, never produced a run at all.
 *
 * Assistant-authored, so it lives well away from the evidence tables: it is not indexed, not
 * retrievable, not extracted, and cascades out of existence with the message it belongs to.
 */

export function recordCalendarOutcome(
  db: Db,
  assistantMessageId: number,
  outcome: CalendarOutcome,
): void {
  db.prepare<[number, string, string, string, string]>(
    `INSERT INTO calendar_outcome
       (assistant_message_id, kind, status, outcome_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (assistant_message_id) DO UPDATE SET
       kind = excluded.kind,
       status = excluded.status,
       outcome_json = excluded.outcome_json,
       created_at = excluded.created_at`,
  ).run(assistantMessageId, outcome.kind, outcome.status, JSON.stringify(outcome), now());
}

/** Stored outcomes for one conversation, keyed by the assistant message that reported them. */
export function calendarOutcomesIn(
  db: Db,
  conversationId: number,
): Map<number, CalendarOutcome> {
  const rows = db
    .prepare<[number], { assistant_message_id: number; outcome_json: string }>(
      `SELECT o.assistant_message_id, o.outcome_json
       FROM calendar_outcome o
       JOIN message m ON m.id = o.assistant_message_id
       WHERE m.conversation_id = ?`,
    )
    .all(conversationId);
  const outcomes = new Map<number, CalendarOutcome>();
  for (const row of rows) {
    // A row written by an older shape is dropped rather than crashing the page. The card
    // simply does not appear, which is the same as before this table existed.
    const parsed = CalendarOutcome.safeParse(safeJson(row.outcome_json));
    if (parsed.success) outcomes.set(row.assistant_message_id, parsed.data);
  }
  return outcomes;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

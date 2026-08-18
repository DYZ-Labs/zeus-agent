import type { Db } from "./db";
import { now } from "./db";
import { CalendarOutcome } from "./schema";

/**
 * The deterministic account of what a calendar request did, kept with the turn.
 *
 * Without it, the assistant's prose is the only surviving record of what happened, and a
 * change carried out, a change waiting on confirmation, and a change refused become
 * indistinguishable except by whatever the model happened to write.
 *
 * It has two readers, and the second is the point. The browser reads it so a reload still
 * shows what Zeus did. `calendarHistoryFor` reads it so the *model* does — because every
 * block of a turn is thrown away when the turn ends, and a model replayed only bare prose has
 * no evidence a calendar was ever touched. The prompt then correctly refuses to claim
 * anything, and Zeus denies work it has receipts for.
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

/**
 * What Zeus already did to the calendar in this conversation, oldest first.
 *
 * Bounded by count and scoped to the conversation rather than to the model's message window,
 * deliberately. The window holds twenty messages; a calendar change made forty messages ago
 * is still a change that was made, and dropping it is exactly how "have you added it?" came
 * to be answered with a disclaimer.
 *
 * A record of Zeus's own actions, never of the calendar's contents. What is on the calendar
 * now still needs a fresh read.
 */
export type CalendarHistoryEntry = {
  assistantMessageId: number;
  at: string;
  kind: CalendarOutcome["kind"];
  status: CalendarOutcome["status"];
  reason: string | null;
  /** The event's own title travels in here, so every reader guards it as external text. */
  preview: string | null;
  /**
   * What a confirmation line for this turn would have named.
   *
   * Kept so a later "no" can be matched to the set the user was actually asked about, rather
   * than to whatever happens to be pending in the store. Never given to the model — it is a
   * digest, and a reply reciting one helps nobody.
   */
  confirmationHash: string | null;
};

export const MAX_CALENDAR_HISTORY = 15;

export function calendarHistoryFor(
  db: Db,
  conversationId: number,
  limit: number = MAX_CALENDAR_HISTORY,
): CalendarHistoryEntry[] {
  const rows = db
    .prepare<[number, number], {
      assistant_message_id: number;
      created_at: string;
      outcome_json: string;
    }>(
      `SELECT o.assistant_message_id, o.created_at, o.outcome_json
       FROM calendar_outcome o
       JOIN message m ON m.id = o.assistant_message_id
       WHERE m.conversation_id = ?
       ORDER BY o.assistant_message_id DESC
       LIMIT ?`,
    )
    .all(conversationId, Math.max(1, limit));
  const entries: CalendarHistoryEntry[] = [];
  // Newest-first from SQLite so the cap keeps the most recent; reversed here so the model
  // reads them in the order they happened.
  for (const row of rows.reverse()) {
    const parsed = CalendarOutcome.safeParse(safeJson(row.outcome_json));
    if (!parsed.success) continue;
    entries.push({
      assistantMessageId: row.assistant_message_id,
      at: row.created_at,
      kind: parsed.data.kind,
      status: parsed.data.status,
      reason: parsed.data.reason,
      preview: parsed.data.preview,
      confirmationHash: parsed.data.confirmationHash,
    });
  }
  return entries;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

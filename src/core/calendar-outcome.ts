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

/**
 * What this conversation actually changed, and what it is still waiting on.
 *
 * The gap this closes: on any turn where no calendar work runs, the model receives no
 * `<calendar_result>` and no `<work_result>`, the stored transcript is raw text, and the
 * `<memory>` block has no calendar content by design. So "have you moved it?" had nothing to
 * answer from except Zeus's own earlier sentence — which is how a change it had described
 * one way was reaffirmed as done, in a different way, with nothing able to contradict it.
 *
 * Read from `proposed_effect`, not from the prose and not from `calendar_outcome`: `executed`
 * is set after the connector call returns, so it is the difference between a request that
 * was prepared and one that left the machine. A pending row is reported as pending, never
 * folded in with the rest.
 */

export type CalendarLedgerEntry = {
  status: "executed" | "pending_confirmation";
  preview: string;
  at: string;
};

const LEDGER_LIMIT = 8;

export function conversationCalendarLedger(
  db: Db,
  conversationId: number,
): CalendarLedgerEntry[] {
  const rows = db
    .prepare<[number, number], { status: string; preview_text: string; updated_at: string }>(
      `SELECT e.status, e.preview_text, e.updated_at
       FROM proposed_effect e
       JOIN work_run r ON r.id = e.work_run_id
       JOIN work_plan p ON p.id = r.work_plan_id
       JOIN message m ON m.id = p.source_message_id
       WHERE m.conversation_id = ?
         AND e.status IN ('executed', 'pending_confirmation')
         AND e.effect_kind IN ('schedule', 'modify_external')
       ORDER BY e.id DESC
       LIMIT ?`,
    )
    .all(conversationId, LEDGER_LIMIT);
  return rows
    .map((row) => ({
      status: row.status === "executed"
        ? ("executed" as const)
        : ("pending_confirmation" as const),
      preview: row.preview_text,
      at: row.updated_at,
    }))
    .reverse();
}

/**
 * Calendar changes still waiting on the user, keyed by the turn that proposed them.
 *
 * The card's Confirm button used to live entirely in the streaming frame, so a reload left a
 * genuinely pending change with no way to accept it — and, because the branch was guarded on
 * the effect being present, described as one Zeus had stopped before making. The effect is
 * durable; only the route to it was not.
 *
 * Tied back to the assistant turn through the plan's source message: the reply that reported
 * the proposal is the next assistant message after the request that prompted it.
 */
export type PendingCalendarEffect = {
  id: number;
  payloadHash: string;
  payload: unknown;
};

export function pendingCalendarEffectsIn(
  db: Db,
  conversationId: number,
): Map<number, PendingCalendarEffect> {
  const rows = db
    .prepare<[number, string], {
      id: number;
      payload_hash: string;
      payload_json: string;
      assistant_message_id: number | null;
    }>(
      `SELECT e.id, e.payload_hash, e.payload_json,
              (SELECT MIN(m2.id) FROM message m2
                WHERE m2.conversation_id = m.conversation_id
                  AND m2.role = 'assistant'
                  AND m2.id > p.source_message_id) AS assistant_message_id
       FROM proposed_effect e
       JOIN work_run r ON r.id = e.work_run_id
       JOIN work_plan p ON p.id = r.work_plan_id
       JOIN message m ON m.id = p.source_message_id
       WHERE m.conversation_id = ?
         AND e.status = 'pending_confirmation'
         AND e.expires_at > ?
         AND e.effect_kind IN ('schedule', 'modify_external')
       ORDER BY e.id ASC`,
    )
    .all(conversationId, now());
  const pending = new Map<number, PendingCalendarEffect>();
  for (const row of rows) {
    if (row.assistant_message_id === null) continue;
    pending.set(row.assistant_message_id, {
      id: row.id,
      payloadHash: row.payload_hash,
      payload: safeJson(row.payload_json),
    });
  }
  return pending;
}

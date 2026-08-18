import type { CalendarDetailsFrom } from "./calendar-actions";
import type { Db } from "./db";
import { now } from "./db";
import { CalendarActionSetting } from "./schema";

/**
 * The standing permission to carry out a calendar change without asking each time.
 *
 * Two things this setting deliberately does not do. It does not remove the record: every
 * action still writes a receipt and still appears with its exact payload. And it does not
 * remove the check: the conflict gate has to clear first, so what the setting actually
 * covers is the narrow case where Zeus verified against a freshly read calendar that the
 * time is free. A collision, an unreadable calendar, or an ambiguous target all fall back
 * to asking, whatever this says.
 *
 * So does a change whose particulars Zeus supplied. The conflict gate checks the
 * *destination*; it has nothing to say about whether the request itself is the one that was
 * agreed, and an hour nobody asked for collides with nothing precisely because it is free.
 * When the times were carried over from something Zeus proposed rather than something the
 * user wrote, the one remaining check is the user reading it — so the change is prepared and
 * shown instead of sent.
 *
 * The daily ceiling is a backstop rather than a budget. It exists so that a
 * misclassification loop costs a handful of events and then stops on its own, instead of
 * discovering the problem by the state of somebody's week.
 */

export type DirectExecutionAllowance = {
  allowed: boolean;
  reason: "disabled" | "daily_limit" | "inferred_details" | null;
  usedToday: number;
  limit: number;
};

export function getCalendarActionSetting(db: Db): CalendarActionSetting {
  const row = db
    .prepare<[], unknown>("SELECT * FROM calendar_action_setting WHERE id = 1")
    .get();
  return CalendarActionSetting.parse(row);
}

export function updateCalendarActionSetting(
  db: Db,
  update: {
    directExecution?: boolean;
    dailyLimit?: number;
    dayStart?: string;
    dayEnd?: string;
  },
  sourceMessageId: number,
): CalendarActionSetting {
  return db.transaction((): CalendarActionSetting => {
    const message = db
      .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
      .get(sourceMessageId);
    // The setting's provenance is what keeps `authorized_by_policy` honest downstream.
    if (!message || message.role !== "user") {
      throw new Error("Changing this setting requires an explicit user action");
    }
    const current = getCalendarActionSetting(db);
    const next = {
      direct_execution: update.directExecution === undefined
        ? current.direct_execution
        : ((update.directExecution ? 1 : 0) as 0 | 1),
      daily_limit: update.dailyLimit ?? current.daily_limit,
      day_start: update.dayStart ?? current.day_start,
      day_end: update.dayEnd ?? current.day_end,
    };
    db.prepare<[number, number, string, string, number, string]>(
      `UPDATE calendar_action_setting
       SET direct_execution = ?, daily_limit = ?, day_start = ?, day_end = ?,
           source_message_id = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      next.direct_execution,
      next.daily_limit,
      next.day_start,
      next.day_end,
      sourceMessageId,
      now(),
    );
    return getCalendarActionSetting(db);
  })();
}

/**
 * Whether a calendar change may be carried out without asking, right now.
 *
 * Counted from the ledger rather than from a counter, so the ceiling cannot be reset by a
 * crash loop — the same reason the model and connector budgets are durable.
 */
export function directExecutionAllowance(
  db: Db,
  options: { at?: Date; detailsFrom?: CalendarDetailsFrom } = {},
): DirectExecutionAllowance {
  const setting = getCalendarActionSetting(db);
  const at = options.at ?? new Date();
  const dayStart = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  ).toISOString();
  const used = db
    .prepare<[string], { count: number }>(
      `SELECT COUNT(*) AS count FROM effect_event
       WHERE event_type = 'authorized_by_policy' AND created_at >= ?`,
    )
    .get(dayStart);
  const usedToday = used?.count ?? 0;
  if (setting.direct_execution !== 1) {
    return { allowed: false, reason: "disabled", usedToday, limit: setting.daily_limit };
  }
  // Anything that is not plainly the user's own words is treated as inferred. A request that
  // reached here without saying where its details came from — a plan encoded before this
  // field existed, say — is exactly the case that should ask rather than assume.
  if (options.detailsFrom !== "user_message") {
    return { allowed: false, reason: "inferred_details", usedToday, limit: setting.daily_limit };
  }
  if (usedToday >= setting.daily_limit) {
    return { allowed: false, reason: "daily_limit", usedToday, limit: setting.daily_limit };
  }
  return { allowed: true, reason: null, usedToday, limit: setting.daily_limit };
}

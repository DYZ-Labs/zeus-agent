import type { CalendarCoverage } from "./calendar-conflicts";
import { endOf } from "./calendar-time";
import type { CachedEvent } from "./calendar-time";
import { availableCapability } from "./connectors";
import type { Db } from "./db";
import { callCapability } from "./mcp-client";
import { errorSignature, logEvent } from "./observability";

/**
 * Refreshing the local view of the user's calendar.
 *
 * What comes back is somebody else's text — anyone who can send an invite can write it —
 * so it is stored as a disposable, expiring cache with no path to any evidence table. It
 * can inform a plan or trip a detector; it can never become a fact about the user.
 *
 * Deliberately model-free. The background worker calls this and then runs detectors, and
 * neither step reasons about what it read.
 */

const WINDOW_DAYS = 30;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_EVENTS = 250;

export type CalendarEvent = {
  id: string;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
};

export type CalendarWindow = { from: string; to: string };

export function calendarWindow(at: Date = new Date(), days = WINDOW_DAYS): CalendarWindow {
  return {
    from: at.toISOString(),
    to: new Date(at.getTime() + days * 86_400_000).toISOString(),
  };
}

/**
 * Fetch and cache the current window.
 *
 * Returns null when no calendar is connected — the honest answer, and never an excuse to
 * fall back to some other source.
 */
export async function syncCalendar(
  db: Db,
  options: { at?: Date; signal?: AbortSignal } = {},
): Promise<{ events: CalendarEvent[]; window: CalendarWindow } | null> {
  const available = availableCapability(db, "calendar.list_events");
  if (!available) return null;
  const at = options.at ?? new Date();
  const window = calendarWindow(at);
  try {
    const result = await callCapability(db, "calendar.list_events", { ...window }, {
      signal: options.signal,
      capabilityId: available.capability.id,
    });
    const events = cacheCalendarEvents(db, available.connector.id, result.value, at);
    logEvent({
      event: "calendar_synced",
      outcome: "ok",
      connector_id: available.connector.id,
      count: events.length,
    });
    return { events, window };
  } catch (error) {
    logEvent({
      event: "calendar_synced",
      outcome: "error",
      connector_id: available.connector.id,
      ...errorSignature(error),
    });
    return null;
  }
}

/**
 * Replace the cached window and drop anything expired.
 *
 * Rows are keyed by the service's own id so a re-read updates in place rather than
 * accumulating duplicates of the same meeting.
 */
export function cacheCalendarEvents(
  db: Db,
  connectorId: number,
  value: unknown,
  at: Date = new Date(),
  window: CalendarWindow = calendarWindow(at),
): CalendarEvent[] {
  const events = parseCalendarEvents(value);
  const fetchedAt = at.toISOString();
  const expiresAt = new Date(at.getTime() + CACHE_TTL_MS).toISOString();
  const upsert = db.prepare<
    [number, string, string | null, string | null, string | null, string, string, string]
  >(
    `INSERT INTO external_signal
       (connector_id, kind, external_id, starts_at, ends_at, location, payload_json,
        fetched_at, expires_at)
     VALUES (?, 'calendar_event', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (connector_id, kind, external_id) DO UPDATE SET
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       location = excluded.location,
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
  );
  db.transaction(() => {
    db.prepare<[string]>("DELETE FROM external_signal WHERE expires_at <= ?").run(fetchedAt);
    for (const event of events) {
      upsert.run(
        connectorId,
        event.id,
        event.starts_at,
        event.ends_at,
        event.location,
        JSON.stringify(event),
        fetchedAt,
        expiresAt,
      );
    }
    // Recorded in the same transaction as the rows themselves, because the whole value of
    // this row is that it cannot disagree with them. A calendar with nothing in it and a
    // calendar that was never read are otherwise indistinguishable to a write gate.
    db.prepare<[number, string, string, number, string]>(
      `INSERT INTO external_read_window
         (connector_id, kind, window_from, window_to, event_count, fetched_at)
       VALUES (?, 'calendar_event', ?, ?, ?, ?)
       ON CONFLICT (connector_id, kind) DO UPDATE SET
         window_from = excluded.window_from,
         window_to = excluded.window_to,
         event_count = excluded.event_count,
         fetched_at = excluded.fetched_at`,
    ).run(connectorId, window.from, window.to, events.length, fetchedAt);
  })();
  return events;
}

/**
 * The most recent proof that a calendar window was read.
 *
 * Returns null when no read has ever succeeded. Callers must treat that as "unknown", never
 * as "empty" — that distinction is the entire reason this table exists.
 */
export function readCalendarCoverage(db: Db): CalendarCoverage | null {
  const row = db
    .prepare<[], { window_from: string; window_to: string; event_count: number; fetched_at: string }>(
      `SELECT window_from, window_to, event_count, fetched_at
       FROM external_read_window
       WHERE kind = 'calendar_event'
       ORDER BY fetched_at DESC
       LIMIT 1`,
    )
    .get();
  if (!row) return null;
  return {
    from: row.window_from,
    to: row.window_to,
    fetchedAt: row.fetched_at,
    eventCount: row.event_count,
  };
}

/**
 * Cached calendar rows that have not expired and have not already ended, ordered in time.
 *
 * "Has not ended" rather than "has not started": an event that began twenty minutes ago and
 * runs another forty still collides with something booked ten minutes from now. The SQL
 * bound is deliberately generous and the exact test is applied in TypeScript, where the
 * one-hour default for a missing end already lives.
 */
export function cachedEvents(
  db: Db,
  at: Date,
  options: { includeEnded?: boolean } = {},
): CachedEvent[] {
  const rows = db
    .prepare<[string, string], CachedEvent>(
      `SELECT external_id, starts_at, ends_at, location,
              json_extract(payload_json, '$.title') AS title
       FROM external_signal
       WHERE kind = 'calendar_event' AND expires_at > ? AND starts_at IS NOT NULL
         AND starts_at > ?
       ORDER BY starts_at, external_id`,
    )
    .all(at.toISOString(), new Date(at.getTime() - 2 * 86_400_000).toISOString())
    .filter((event) => Number.isFinite(Date.parse(event.starts_at)));
  if (options.includeEnded) return rows;
  return rows.filter((event) => endOf(event) > at.getTime());
}

/**
 * Read the shapes a calendar server plausibly returns and keep only the fields Zeus uses.
 *
 * Anything without an id is dropped: without a stable identifier a later read would
 * duplicate it rather than update it, and a detector would raise the same conflict twice.
 */
export function parseCalendarEvents(value: unknown): CalendarEvent[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { events?: unknown }).events)
      ? (value as { events: unknown[] }).events
      : [];
  const events: CalendarEvent[] = [];
  for (const entry of list.slice(0, MAX_EVENTS)) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = firstString(record, ["id", "event_id", "eventId", "uid"]);
    if (id === null) continue;
    events.push({
      id,
      title: firstString(record, ["title", "summary", "name"]),
      starts_at: firstString(record, ["starts_at", "start", "startTime", "start_time"]),
      ends_at: firstString(record, ["ends_at", "end", "endTime", "end_time"]),
      location: firstString(record, ["location", "where"]),
    });
  }
  return events;
}

/** Accepts both a plain string and the `{ dateTime }` / `{ date }` shape calendars use. */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (value && typeof value === "object") {
      const nested =
        (value as Record<string, unknown>).dateTime ?? (value as Record<string, unknown>).date;
      if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
    }
  }
  return null;
}

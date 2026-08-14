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
  })();
  return events;
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

import type { CalendarCoverage } from "./calendar-conflicts";
import { endOf } from "./calendar-time";
import type { CachedEvent } from "./calendar-time";
import {
  CALENDAR_CAPABILITY_SLOTS,
  availableCapability,
  connectorAwaitingReachability,
  listConnectors,
} from "./connectors";
import type { Db } from "./db";
import { callCapability, restoreConnectorReachability } from "./mcp-client";
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
/** How long a cached row remains visible to `cachedEvents` after the read that wrote it. */
export const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_EVENTS = 250;

/**
 * How stale the proof-of-read may be before a chat turn refreshes it.
 *
 * Equal to the background refresh cadence, so on a healthy deployment the turn-start check
 * is a pure SQLite read and never spends a connector call. Deliberately looser than the
 * write gate's ten minutes — an action still gets its own fresh read — and tighter than the
 * one-hour row expiry, so a conversational answer normally comes from an unexpired cache.
 */
export const CHAT_COVERAGE_TTL_MS = 15 * 60_000;

/**
 * How long a chat turn will wait on a refresh before answering from what it has.
 *
 * Shorter than the connector call timeout because someone is waiting on a reply: a provider
 * that cannot answer in this window gets reported as a stale schedule with an honest as-of
 * time, not as a turn that hangs.
 */
export const CHAT_SYNC_TIMEOUT_MS = 6_000;

/**
 * One invited person, as the calendar reported them.
 *
 * Both fields are nullable because servers disagree about which they send: an entry with
 * neither is not an attendee and is dropped at parse.
 */
export type CalendarAttendee = {
  email: string | null;
  name: string | null;
};

/** Beyond this, an event is an announcement rather than a meeting to prepare for. */
const MAX_ATTENDEES = 25;

export type CalendarEvent = {
  id: string;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  /**
   * Retained for meeting preparation, which cannot say who is coming without it.
   *
   * Null means the server said nothing about attendees; an empty array means it said there
   * are none. Prep has to tell those apart — "nobody else is invited" and "this calendar
   * does not report attendees" are different sentences.
   */
  attendees: CalendarAttendee[] | null;
};

export type CalendarWindow = { from: string; to: string };

const CALENDAR_WINDOW_FIELDS = [
  ["from", "to"],
  ["startTime", "endTime"],
  ["timeMin", "timeMax"],
  ["start_time", "end_time"],
] as const;

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
    const args = calendarListEventArguments(available.capability.input_schema_json, window);
    const result = await callCapability(db, "calendar.list_events", args, {
      signal: options.signal,
      capabilityId: available.capability.id,
    });
    if (result.isError) throw new Error("calendar_tool_reported_error");
    const events = cacheCalendarEvents(db, available.connector.id, result.value, at, window);
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

export type CalendarCacheFreshness =
  | "fresh"
  | "synced"
  | "restored_and_synced"
  | "sync_failed"
  | "unavailable"
  | "no_connector";

/**
 * Make the schedule cache fresh enough for a chat turn to answer from, if it can.
 *
 * Called at the start of every turn, so it must cost nothing when there is nothing to do:
 * fresh coverage returns before any capability lookup, and a missing connector returns
 * before any network. When the connector is merely unreachable it gets the same bounded
 * revive a recognized calendar request gets — a schedule question the intent gate missed
 * still deserves a calendar that heals — but at most once per TTL window, because the
 * connector row's `updated_at` records every verification attempt, success or failure.
 *
 * Never throws and never calls a model. A failure here degrades the turn to the last-known
 * schedule with an honest as-of time; it must not replace the reply with an error.
 */
export async function ensureFreshCalendarCache(
  db: Db,
  options: { at?: Date; signal?: AbortSignal } = {},
): Promise<CalendarCacheFreshness> {
  const at = options.at ?? new Date();
  const coverage = readCalendarCoverage(db);
  if (coverage && at.getTime() - Date.parse(coverage.fetchedAt) <= CHAT_COVERAGE_TTL_MS) {
    return "fresh";
  }
  let restored = false;
  if (!availableCapability(db, "calendar.list_events")) {
    const awaiting = connectorAwaitingReachability(db, "calendar.list_events");
    if (!awaiting) return calendarConnectorExists(db) ? "unavailable" : "no_connector";
    // `updated_at` moves on every recorded verification, so a handshake that just failed is
    // not retried on the very next turn — the background refresh owns the steady cadence.
    if (at.getTime() - Date.parse(awaiting.updated_at) <= CHAT_COVERAGE_TTL_MS) {
      return "unavailable";
    }
    restored = await restoreConnectorReachability(db, "calendar.list_events", {
      signal: options.signal,
    });
    if (!restored) return "unavailable";
  }
  const deadline = AbortSignal.timeout(CHAT_SYNC_TIMEOUT_MS);
  const synced = await syncCalendar(db, {
    at,
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
  if (!synced) return "sync_failed";
  return restored ? "restored_and_synced" : "synced";
}

/** Whether any calendar connector exists at all, usable or not. Mirrors the capability block. */
function calendarConnectorExists(db: Db): boolean {
  return listConnectors(db).some(
    (connector) =>
      connector.provider === "google_calendar" ||
      connector.capabilities.some((capability) =>
        (CALENDAR_CAPABILITY_SLOTS as readonly string[]).includes(capability.slot),
      ),
  );
}

/**
 * Translate Zeus's canonical bounded window into the exact live tool contract the user
 * reviewed. The hosted broker uses `from`/`to`; Google's official MCP server uses
 * `startTime`/`endTime`, and earlier previews used `timeMin`/`timeMax`. Unknown or newly
 * required fields fail closed instead of sending a malformed or broader request.
 */
export function calendarListEventArguments(
  inputSchemaJson: string,
  window: CalendarWindow,
): Record<string, unknown> {
  let schema: unknown;
  try {
    schema = JSON.parse(inputSchemaJson) as unknown;
  } catch {
    throw new Error("Calendar list tool has an invalid input schema");
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Calendar list tool has an invalid input schema");
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Calendar list tool has no reviewable input fields");
  }
  const fields = properties as Record<string, unknown>;
  const pair = CALENDAR_WINDOW_FIELDS.find(
    ([lower, upper]) => Object.hasOwn(fields, lower) && Object.hasOwn(fields, upper),
  );
  if (!pair) {
    throw new Error("Calendar list tool has no supported bounded time window");
  }

  const [lower, upper] = pair;
  const args: Record<string, unknown> = {
    [lower]: window.from,
    [upper]: window.to,
  };
  const required = Array.isArray(record.required)
    ? record.required.filter((field): field is string => typeof field === "string")
    : [];
  for (const field of required) {
    if (Object.hasOwn(args, field)) continue;
    if (field === "calendarId" && Object.hasOwn(fields, field)) {
      args.calendarId = "primary";
      continue;
    }
    throw new Error(`Calendar list tool requires unsupported field ${field}`);
  }
  return args;
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
    // Reconcile the window, don't just merge into it. A read that comes back without an
    // event Zeus had cached is the only evidence it will ever get that the event is gone —
    // and a cache that only ever grows will happily resolve "cancel my standup" against a
    // meeting that was deleted an hour ago, or refuse a slot that is actually free. Scoped
    // to the window that was read, so events outside it are left alone rather than assumed
    // absent. This mirrors `resolveAbsentSignals`, for the same reason.
    const seen = new Set(events.map((event) => event.id));
    const stale = db
      .prepare<[number, string, string], { external_id: string }>(
        `SELECT external_id FROM external_signal
         WHERE connector_id = ? AND kind = 'calendar_event'
           AND starts_at IS NOT NULL AND starts_at >= ? AND starts_at < ?`,
      )
      .all(connectorId, window.from, window.to)
      .filter((row) => !seen.has(row.external_id));
    const drop = db.prepare<[number, string]>(
      "DELETE FROM external_signal WHERE connector_id = ? AND kind = 'calendar_event' AND external_id = ?",
    );
    for (const row of stale) drop.run(connectorId, row.external_id);
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
 * Cached calendar rows regardless of expiry — the last thing a successful read wrote.
 *
 * Render-only, for the standing schedule block's degraded state: when a refresh has not
 * succeeded lately, the honest answer is the schedule as it was last read, said with its
 * as-of time, not silence. Readable during an outage because the expired-row sweep runs
 * only inside `cacheCalendarEvents`, which only a successful read reaches.
 *
 * Never hand this to the conflict gate or the detectors: both must keep failing closed on
 * expiry, and `cachedEvents` is the reader that enforces that.
 */
export function lastKnownEvents(db: Db, at: Date): CachedEvent[] {
  const rows = db
    .prepare<[string], CachedEvent>(
      `SELECT external_id, starts_at, ends_at, location,
              json_extract(payload_json, '$.title') AS title
       FROM external_signal
       WHERE kind = 'calendar_event' AND starts_at IS NOT NULL AND starts_at > ?
       ORDER BY starts_at, external_id`,
    )
    .all(new Date(at.getTime() - 2 * 86_400_000).toISOString())
    .filter((event) => Number.isFinite(Date.parse(event.starts_at)));
  return rows.filter((event) => endOf(event) > at.getTime());
}

/**
 * Read the shapes a calendar server plausibly returns and keep only the fields Zeus uses.
 * Every returned entry needs a stable id. Silently dropping an unidentifiable entry could
 * turn a malformed non-empty response into proof that the calendar was empty and clear a
 * conflicting write, so the whole read fails closed instead.
 */
export function parseCalendarEvents(value: unknown): CalendarEvent[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { events?: unknown }).events)
      ? (value as { events: unknown[] }).events
      : null;
  // An invalid response is not an empty calendar. Throw before cacheCalendarEvents opens its
  // transaction, so neither event rows nor the proof-of-read row can be written.
  if (list === null) throw new Error("Calendar response did not contain an event list");
  if (list.length > MAX_EVENTS) {
    throw new Error("Calendar response exceeded the complete event limit");
  }
  const events: CalendarEvent[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Calendar response contained an invalid event");
    }
    const record = entry as Record<string, unknown>;
    const id = firstString(record, ["id", "event_id", "eventId", "uid"]);
    if (id === null) throw new Error("Calendar response contained an event without an id");
    events.push({
      id,
      title: firstString(record, ["title", "summary", "name"]),
      starts_at: firstString(record, ["starts_at", "start", "startTime", "start_time"]),
      ends_at: firstString(record, ["ends_at", "end", "endTime", "end_time"]),
      location: firstString(record, ["location", "where"]),
      attendees: parseAttendees(record),
    });
  }
  return events;
}

/**
 * Who was invited, from whichever shape the server sent.
 *
 * Unlike an id or a start time, an unreadable attendee list does **not** fail the read. Those
 * two are load-bearing — a missing id makes an event unaddressable, and a missing start makes
 * a window unprovable — so the parse fails closed on them rather than let a malformed
 * response look like an empty calendar. Attendees only feed meeting preparation. Losing them
 * degrades a brief; refusing the whole read over them would lose the conflict gate a window
 * it needs, which is the worse failure by far.
 *
 * Null and empty are kept distinct all the way through: a server that reports no attendee
 * field is not a meeting with nobody in it.
 */
function parseAttendees(record: Record<string, unknown>): CalendarAttendee[] | null {
  const raw = record.attendees ?? record.participants;
  if (!Array.isArray(raw)) return null;
  const attendees: CalendarAttendee[] = [];
  for (const entry of raw.slice(0, MAX_ATTENDEES)) {
    if (typeof entry === "string") {
      const value = entry.trim();
      if (!value) continue;
      // A bare string is an address where it looks like one, and a name otherwise.
      attendees.push(
        value.includes("@") ? { email: value, name: null } : { email: null, name: value },
      );
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const fields = entry as Record<string, unknown>;
    const email = firstString(fields, ["email", "emailAddress", "address"]);
    const name = firstString(fields, ["displayName", "name", "display_name"]);
    if (email === null && name === null) continue;
    attendees.push({ email, name });
  }
  return attendees;
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

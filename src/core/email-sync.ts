import {
  availableCapability,
  connectorAwaitingReachability,
  listConnectors,
} from "./connectors";
import type { Db } from "./db";
import { callCapability, restoreConnectorReachability } from "./mcp-client";
import { errorSignature, logEvent } from "./observability";

/**
 * Refreshing the local view of the user's inbox.
 *
 * The calendar twin of this file is `calendar-sync.ts`, and most of it is the same shape for
 * the same reasons: a disposable expiring cache, reconciled rather than merged, with a
 * separate proof-of-read so that "nothing there" and "never read" can never be confused.
 *
 * Three things are genuinely different, and each is a decision rather than a translation.
 *
 * **The window is a query, not a parameter pair.** Gmail has no `from`/`to`; the bound lives
 * inside the search string as `newer_than:`. So the argument builder requires a `query` field
 * and constructs a bounded one, where the calendar builder looks for a bounding pair. Same
 * fail-closed rule, different shape.
 *
 * **A truncated read narrows the window instead of failing it.** The calendar throws when a
 * response exceeds `MAX_EVENTS`, because a truncated window is not a read window and a write
 * gate would act on it. Email has no write gate, and `pageSize` caps at 50 — an inbox busier
 * than that is normal, not exceptional, so failing would mean never syncing. Threads come
 * back newest first, so a truncated page still *completely* covers everything newer than its
 * oldest thread. That is the window recorded, and the window reconciled. Everything older is
 * outside what was proven and is left alone, exactly as the calendar leaves events outside
 * its window alone.
 *
 * **Snippets are dropped at parse.** No view returns subject and sender without one:
 * `THREAD_VIEW_MINIMAL` includes the snippet and `THREAD_VIEW_METADATA_ONLY` omits the
 * subject. So the snippet arrives and is discarded before anything is stored — weaker than
 * never fetching it, and worth saying plainly rather than implying the standing block's
 * "subjects and senders only" is enforced at the wire.
 */

/** How far back a sync reaches. Gmail expresses this inside the query, in whole days. */
const WINDOW_DAYS = 7;

/** How long a cached thread stays visible to `cachedThreads` after the read that wrote it. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

/** The server's own ceiling. Asking for more is refused rather than silently clamped. */
const MAX_PAGE_SIZE = 50;

/** Mirrors `CHAT_COVERAGE_TTL_MS` in the calendar: how stale the proof may be on a turn. */
export const CHAT_COVERAGE_TTL_MS = 15 * 60_000;

/** Mirrors `CHAT_SYNC_TIMEOUT_MS`: how long a turn waits before answering from what it has. */
export const CHAT_SYNC_TIMEOUT_MS = 6_000;

export type EmailThread = {
  id: string;
  subject: string | null;
  from: string | null;
  /** The thread's most recent activity. What the window is reconciled against. */
  last_activity_at: string | null;
  unread: boolean;
};

export type EmailWindow = { from: string; to: string };

export type EmailCoverage = {
  from: string;
  to: string;
  fetchedAt: string;
  threadCount: number;
};

export function emailWindow(at: Date = new Date(), days = WINDOW_DAYS): EmailWindow {
  return {
    from: new Date(at.getTime() - days * 86_400_000).toISOString(),
    to: at.toISOString(),
  };
}

/**
 * Fetch and cache the current window.
 *
 * Returns null when no inbox is connected — the honest answer, and never an excuse to fall
 * back to some other source.
 */
export async function syncEmail(
  db: Db,
  options: { at?: Date; signal?: AbortSignal } = {},
): Promise<{ threads: EmailThread[]; window: EmailWindow } | null> {
  const available = availableCapability(db, "email.search_threads");
  if (!available) return null;
  const at = options.at ?? new Date();
  try {
    const args = searchThreadArguments(available.capability.input_schema_json, WINDOW_DAYS);
    const result = await callCapability(db, "email.search_threads", args, {
      signal: options.signal,
      capabilityId: available.capability.id,
    });
    if (result.isError) throw new Error("email_tool_reported_error");
    const cached = cacheEmailThreads(db, available.connector.id, result.value, at);
    logEvent({
      event: "email_synced",
      outcome: "ok",
      connector_id: available.connector.id,
      count: cached.threads.length,
    });
    return cached;
  } catch (error) {
    logEvent({
      event: "email_synced",
      outcome: "error",
      connector_id: available.connector.id,
      ...errorSignature(error),
    });
    return null;
  }
}

export type EmailCacheFreshness =
  | "fresh"
  | "synced"
  | "restored_and_synced"
  | "sync_failed"
  | "unavailable"
  | "no_connector";

/**
 * Make the inbox cache fresh enough for a chat turn to answer from, if it can.
 *
 * The calendar twin's contract, kept exactly: costs nothing when there is nothing to do,
 * revives an unreachable connector at most once per TTL window, and **never throws**. A
 * failure here degrades the turn to the last-known inbox with an honest as-of time; it must
 * not replace the reply with an error. The turn awaits this alongside the calendar refresh
 * under one deadline, and `Promise.all` rejects on the first rejection — so "never throws"
 * is load-bearing for the calendar too, not just for this.
 */
export async function ensureFreshEmailCache(
  db: Db,
  options: { at?: Date; signal?: AbortSignal } = {},
): Promise<EmailCacheFreshness> {
  const at = options.at ?? new Date();
  const coverage = readEmailCoverage(db);
  if (coverage && at.getTime() - Date.parse(coverage.fetchedAt) <= CHAT_COVERAGE_TTL_MS) {
    return "fresh";
  }
  let restored = false;
  if (!availableCapability(db, "email.search_threads")) {
    const awaiting = connectorAwaitingReachability(db, "email.search_threads");
    if (!awaiting) return emailConnectorExists(db) ? "unavailable" : "no_connector";
    if (at.getTime() - Date.parse(awaiting.updated_at) <= CHAT_COVERAGE_TTL_MS) {
      return "unavailable";
    }
    restored = await restoreConnectorReachability(db, "email.search_threads", {
      signal: options.signal,
    });
    if (!restored) return "unavailable";
  }
  const deadline = AbortSignal.timeout(CHAT_SYNC_TIMEOUT_MS);
  const synced = await syncEmail(db, {
    at,
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
  if (!synced) return "sync_failed";
  return restored ? "restored_and_synced" : "synced";
}

/** Whether any inbox connector exists at all, usable or not. Mirrors the capability block. */
function emailConnectorExists(db: Db): boolean {
  return listConnectors(db).some((connector) =>
    connector.capabilities.some(
      (capability) =>
        capability.slot === "email.search_threads" || capability.slot === "email.get_thread",
    ),
  );
}

/**
 * Build the exact arguments the reviewed tool contract accepts.
 *
 * The one field this refuses to proceed without is `query`. Everything else has a defensible
 * default on the server side; an unbounded search does not, and sending one would pull an
 * entire mailbox into a cache meant to hold a week.
 */
export function searchThreadArguments(
  inputSchemaJson: string,
  days: number,
): Record<string, unknown> {
  let schema: unknown;
  try {
    schema = JSON.parse(inputSchemaJson) as unknown;
  } catch {
    throw new Error("Email search tool has an invalid input schema");
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Email search tool has an invalid input schema");
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Email search tool has no reviewable input fields");
  }
  const fields = properties as Record<string, unknown>;
  if (!Object.hasOwn(fields, "query")) {
    throw new Error("Email search tool has no supported bounded query");
  }

  const args: Record<string, unknown> = {
    query: `in:inbox newer_than:${days}d`,
  };
  if (Object.hasOwn(fields, "pageSize")) args.pageSize = MAX_PAGE_SIZE;
  // Pinned rather than defaulted. The server's default is the minimal view today, but a
  // default that changes is a default that starts sending message bodies, and the standing
  // block is built on the promise that it does not hold them.
  if (Object.hasOwn(fields, "view")) args.view = "THREAD_VIEW_MINIMAL";

  const required = Array.isArray(record.required)
    ? record.required.filter((field): field is string => typeof field === "string")
    : [];
  for (const field of required) {
    if (Object.hasOwn(args, field)) continue;
    throw new Error(`Email search tool requires unsupported field ${field}`);
  }
  return args;
}

/** The most messages a fetched thread will render, oldest first, newest kept. */
const MAX_THREAD_MESSAGES = 6;

/** Per-message body budget. A long thread is a summary problem, not a context problem. */
const MAX_BODY_CHARS = 2_000;

export type ThreadMessage = {
  subject: string | null;
  from: string | null;
  sentAt: string | null;
  body: string | null;
};

/**
 * Build the arguments for one on-request thread read.
 *
 * `messageFormat` is **pinned**, and this is the one call in Zeus that deliberately asks for
 * message bodies. The server's default happens to be `FULL_CONTENT`, which is what this wants
 * — but relying on that would mean the most consequential parameter in the system was the one
 * nobody chose. A contract that stops offering the field is a contract Zeus can no longer
 * control the verbosity of, so it fails closed rather than sending the request blind.
 */
export function getThreadArguments(
  inputSchemaJson: string,
  threadId: string,
): Record<string, unknown> {
  let schema: unknown;
  try {
    schema = JSON.parse(inputSchemaJson) as unknown;
  } catch {
    throw new Error("Email thread tool has an invalid input schema");
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Email thread tool has an invalid input schema");
  }
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("Email thread tool has no reviewable input fields");
  }
  const fields = properties as Record<string, unknown>;
  const idField = ["threadId", "thread_id", "id"].find((name) => Object.hasOwn(fields, name));
  if (!idField) throw new Error("Email thread tool takes no thread identifier");
  if (!Object.hasOwn(fields, "messageFormat")) {
    throw new Error("Email thread tool no longer lets Zeus choose how much it returns");
  }
  return { [idField]: threadId, messageFormat: "FULL_CONTENT" };
}

/**
 * Read one thread, on request.
 *
 * The only path in Zeus that holds a message body, and it holds it for exactly one turn:
 * what comes back is rendered and discarded. Nothing here writes to `external_signal`, and
 * there is no table a body could reach — a cached body would be somebody else's text sitting
 * in a store, retrievable long after the moment that justified reading it.
 *
 * Returns null when no inbox is connected or the read fails, which the caller renders as an
 * honest "could not open it" rather than as an empty thread.
 */
export async function fetchThread(
  db: Db,
  threadId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ThreadMessage[] | null> {
  const available = availableCapability(db, "email.get_thread");
  if (!available) return null;
  try {
    const args = getThreadArguments(available.capability.input_schema_json, threadId);
    const deadline = AbortSignal.timeout(CHAT_SYNC_TIMEOUT_MS);
    const result = await callCapability(db, "email.get_thread", args, {
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      capabilityId: available.capability.id,
    });
    if (result.isError) throw new Error("email_thread_tool_reported_error");
    const messages = parseThreadMessages(result.value);
    logEvent({
      event: "email_thread_read",
      outcome: "ok",
      connector_id: available.connector.id,
      count: messages.length,
    });
    return messages;
  } catch (error) {
    logEvent({
      event: "email_thread_read",
      outcome: "error",
      connector_id: available.connector.id,
      ...errorSignature(error),
    });
    return null;
  }
}

/** The messages of one thread, newest last, bodies bounded. */
export function parseThreadMessages(value: unknown): ThreadMessage[] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const list = Array.isArray(value)
    ? value
    : record && Array.isArray(record.messages)
      ? (record.messages as unknown[])
      : record && Array.isArray((record.thread as Record<string, unknown> | undefined)?.messages)
        ? ((record.thread as Record<string, unknown>).messages as unknown[])
        : null;
  if (list === null) throw new Error("Thread response did not contain a message list");

  const usable = list.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  return usable.slice(-MAX_THREAD_MESSAGES).map((message) => ({
    subject: firstString(message, ["subject", "title"]),
    from: firstString(message, ["sender", "from", "fromAddress"]),
    sentAt: firstString(message, ["date", "internalDate", "receivedAt"]),
    body: bodyOf(message),
  }));
}

/** Plain text where the server offers it. HTML is not un-marked-up here, it is skipped. */
function bodyOf(message: Record<string, unknown>): string | null {
  const plain = firstString(message, ["plaintextBody", "plainTextBody", "body", "text"]);
  if (plain === null) return null;
  return plain.length > MAX_BODY_CHARS ? `${plain.slice(0, MAX_BODY_CHARS)}…` : plain;
}

/**
 * Parse a response into the fields Zeus keeps, failing closed on anything unreadable.
 *
 * An invalid response is not an empty inbox. Throwing before the transaction opens is what
 * stops a malformed non-empty answer from being recorded as proof that nothing is waiting.
 */
export function parseEmailThreads(value: unknown): {
  threads: EmailThread[];
  truncated: boolean;
} {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const list = Array.isArray(value)
    ? value
    : record && Array.isArray(record.threads)
      ? (record.threads as unknown[])
      : null;
  if (list === null) throw new Error("Email response did not contain a thread list");

  const threads: EmailThread[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Email response contained an invalid thread");
    }
    const thread = entry as Record<string, unknown>;
    const id = firstString(thread, ["id", "threadId", "thread_id"]);
    if (id === null) throw new Error("Email response contained a thread without an id");
    const newest = newestMessage(thread);
    threads.push({
      id,
      // The snippet is deliberately absent. It arrives on the wire because no view omits it
      // while keeping the subject, and it stops here.
      subject: firstString(newest, ["subject", "title"]),
      from: firstString(newest, ["sender", "from", "fromAddress"]),
      last_activity_at: firstString(newest, ["date", "internalDate", "receivedAt"]),
      unread: labelsOf(newest, thread).includes("UNREAD"),
    });
  }
  return {
    threads,
    truncated: typeof record?.nextPageToken === "string" && record.nextPageToken.length > 0,
  };
}

/**
 * Write the window, reconcile it, and record the proof — one transaction, as the calendar
 * does, because a proof row that can disagree with its own rows proves nothing.
 */
export function cacheEmailThreads(
  db: Db,
  connectorId: number,
  value: unknown,
  at: Date = new Date(),
): { threads: EmailThread[]; window: EmailWindow } {
  const { threads, truncated } = parseEmailThreads(value);
  const requested = emailWindow(at);
  const window = provenWindow(requested, threads, truncated);
  const fetchedAt = at.toISOString();
  const expiresAt = new Date(at.getTime() + CACHE_TTL_MS).toISOString();

  const upsert = db.prepare<[number, string, string | null, string, string, string]>(
    `INSERT INTO external_signal
       (connector_id, kind, external_id, starts_at, payload_json, fetched_at, expires_at)
     VALUES (?, 'email_thread', ?, ?, ?, ?, ?)
     ON CONFLICT (connector_id, kind, external_id) DO UPDATE SET
       starts_at = excluded.starts_at,
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
  );

  db.transaction(() => {
    db.prepare<[string]>("DELETE FROM external_signal WHERE expires_at <= ?").run(fetchedAt);
    // Reconcile, don't merge — and only within the window actually proven. A thread that
    // left the inbox is gone from Zeus's view of it, which is the point; a thread older than
    // this read reached is not evidence of anything and is left alone.
    const seen = new Set(threads.map((thread) => thread.id));
    const stale = db
      .prepare<[number, string, string], { external_id: string }>(
        `SELECT external_id FROM external_signal
         WHERE connector_id = ? AND kind = 'email_thread'
           AND starts_at IS NOT NULL AND starts_at >= ? AND starts_at <= ?`,
      )
      .all(connectorId, window.from, window.to)
      .filter((row) => !seen.has(row.external_id));
    const drop = db.prepare<[number, string]>(
      "DELETE FROM external_signal WHERE connector_id = ? AND kind = 'email_thread' AND external_id = ?",
    );
    for (const row of stale) drop.run(connectorId, row.external_id);

    for (const thread of threads) {
      upsert.run(
        connectorId,
        thread.id,
        thread.last_activity_at,
        JSON.stringify(thread),
        fetchedAt,
        expiresAt,
      );
    }
    db.prepare<[number, string, string, number, string]>(
      `INSERT INTO external_read_window
         (connector_id, kind, window_from, window_to, event_count, fetched_at)
       VALUES (?, 'email_thread', ?, ?, ?, ?)
       ON CONFLICT (connector_id, kind) DO UPDATE SET
         window_from = excluded.window_from,
         window_to = excluded.window_to,
         event_count = excluded.event_count,
         fetched_at = excluded.fetched_at`,
    ).run(connectorId, window.from, window.to, threads.length, fetchedAt);
  })();

  return { threads, window };
}

/**
 * The window a read actually proved, which is not always the one it asked for.
 *
 * Threads come back newest first and `pageSize` caps at 50, so a busy week overflows one
 * page as a matter of course. What such a page still establishes completely is everything
 * newer than its oldest thread — nothing in that range can have been withheld, or it would
 * have displaced the oldest. Recording that narrower window keeps reconciliation honest
 * without the calendar's throw-on-truncation rule, which here would mean a busy inbox never
 * syncing at all.
 */
export function provenWindow(
  requested: EmailWindow,
  threads: readonly EmailThread[],
  truncated: boolean,
): EmailWindow {
  if (!truncated) return requested;
  const oldest = threads
    .map((thread) => thread.last_activity_at)
    .filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)))
    .sort()[0];
  // A truncated page with no readable date proves nothing about any range, so the window
  // collapses to the instant of the read: no thread is reconciled away on this pass.
  if (oldest === undefined) return { from: requested.to, to: requested.to };
  return { from: oldest > requested.from ? oldest : requested.from, to: requested.to };
}

/** Cached threads, expiry enforced. The reader every gate and detector must use. */
export function cachedThreads(db: Db, at: Date): EmailThread[] {
  return db
    .prepare<[string], { payload_json: string }>(
      `SELECT payload_json FROM external_signal
       WHERE kind = 'email_thread' AND expires_at > ?
       ORDER BY starts_at DESC, external_id`,
    )
    .all(at.toISOString())
    .map((row) => safeThread(row.payload_json))
    .filter((thread): thread is EmailThread => thread !== null);
}

/**
 * Cached threads regardless of expiry — render-only, for the degraded standing block.
 *
 * Never hand this to a gate or a detector: both must keep failing closed on expiry, and
 * `cachedThreads` is the reader that enforces that.
 *
 * Takes no reference time, unlike its calendar twin. `lastKnownEvents` needs one to drop
 * events that have already ended; a thread has no end, so there is nothing to compare.
 */
export function lastKnownThreads(db: Db): EmailThread[] {
  return db
    .prepare<[], { payload_json: string }>(
      `SELECT payload_json FROM external_signal
       WHERE kind = 'email_thread'
       ORDER BY starts_at DESC, external_id`,
    )
    .all()
    .map((row) => safeThread(row.payload_json))
    .filter((thread): thread is EmailThread => thread !== null);
}

/**
 * The most recent proof that an inbox window was read.
 *
 * Null when no read has ever succeeded. Callers must treat that as "unknown", never as
 * "empty" — that distinction is the entire reason this table exists.
 */
export function readEmailCoverage(db: Db): EmailCoverage | null {
  const row = db
    .prepare<
      [],
      { window_from: string; window_to: string; event_count: number; fetched_at: string }
    >(
      `SELECT window_from, window_to, event_count, fetched_at
       FROM external_read_window
       WHERE kind = 'email_thread'
       ORDER BY fetched_at DESC
       LIMIT 1`,
    )
    .get();
  if (!row) return null;
  return {
    from: row.window_from,
    to: row.window_to,
    fetchedAt: row.fetched_at,
    threadCount: row.event_count,
  };
}

/** The message a thread should be described by: the newest one it holds. */
function newestMessage(thread: Record<string, unknown>): Record<string, unknown> {
  const messages = thread.messages;
  if (!Array.isArray(messages) || messages.length === 0) return thread;
  const usable = messages.filter(
    (message): message is Record<string, unknown> =>
      message !== null && typeof message === "object" && !Array.isArray(message),
  );
  if (usable.length === 0) return thread;
  return usable[usable.length - 1]!;
}

function labelsOf(
  newest: Record<string, unknown>,
  thread: Record<string, unknown>,
): string[] {
  const raw = newest.labelIds ?? thread.labelIds;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).name ??
        (value as Record<string, unknown>).address ??
        (value as Record<string, unknown>).email;
      if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
    }
  }
  return null;
}

function safeThread(payload: string): EmailThread | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const thread = parsed as Record<string, unknown>;
    return typeof thread.id === "string"
      ? {
          id: thread.id,
          subject: typeof thread.subject === "string" ? thread.subject : null,
          from: typeof thread.from === "string" ? thread.from : null,
          last_activity_at:
            typeof thread.last_activity_at === "string" ? thread.last_activity_at : null,
          unread: thread.unread === true,
        }
      : null;
  } catch {
    return null;
  }
}

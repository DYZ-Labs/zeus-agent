import type { Db } from "./db";
import { now } from "./db";
import { logEvent } from "./observability";

/**
 * Per-store limits on model-backed work.
 *
 * Every model call in a hosted deployment spends one shared OpenAI key, and nothing
 * previously bounded how many an account could make: a loop over `POST /api/chat`, or a
 * client retrying a failed turn forever, spends without limit and takes every other
 * account's budget with it.
 *
 * Two windows, because they answer different questions. The per-minute window stops a
 * runaway loop while a person is still typing; the daily window bounds the bill. Both
 * are counted per store, so one account's spending cannot exhaust another's — which is
 * the property the shared key otherwise destroys.
 *
 * Counters live in SQLite rather than memory on purpose: an in-memory cap resets on
 * every deploy and restart, and a spend limit that a crash-loop can clear is not a
 * spend limit. Both windows are approximate at the edges — a call is counted when it
 * starts, tokens when it finishes — which is the right bias for a ceiling.
 */

export const DEFAULT_CALLS_PER_MINUTE = 20;
export const DEFAULT_CALLS_PER_DAY = 500;
export const DEFAULT_TOKENS_PER_DAY = 2_000_000;

export type BudgetLimits = {
  callsPerMinute: number;
  callsPerDay: number;
  tokensPerDay: number;
};

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: BudgetReason; retryAfterSeconds: number };

export type BudgetReason = "rate_limited" | "daily_calls_spent" | "daily_tokens_spent";

type WindowKind = "minute" | "day";

type UsageRow = { calls: number; input_tokens: number; output_tokens: number };

export function configuredBudgetLimits(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BudgetLimits {
  return {
    callsPerMinute: positiveInteger(
      environment.ZEUS_MODEL_CALLS_PER_MINUTE,
      DEFAULT_CALLS_PER_MINUTE,
      "ZEUS_MODEL_CALLS_PER_MINUTE",
    ),
    callsPerDay: positiveInteger(
      environment.ZEUS_MODEL_CALLS_PER_DAY,
      DEFAULT_CALLS_PER_DAY,
      "ZEUS_MODEL_CALLS_PER_DAY",
    ),
    tokensPerDay: positiveInteger(
      environment.ZEUS_MODEL_TOKENS_PER_DAY,
      DEFAULT_TOKENS_PER_DAY,
      "ZEUS_MODEL_TOKENS_PER_DAY",
    ),
  };
}

/**
 * Decide whether this store may start another model-backed request.
 *
 * Read-only: callers that proceed must record the call themselves. Keeping the check
 * separate from the increment is what lets a route refuse before doing any work while
 * the accounting still reflects calls that actually happened.
 */
export function checkModelBudget(
  db: Db,
  options: { at?: Date; limits?: BudgetLimits } = {},
): BudgetDecision {
  const at = options.at ?? new Date();
  const limits = options.limits ?? configuredBudgetLimits();

  const minute = usageFor(db, "minute", windowStart("minute", at));
  if (minute.calls >= limits.callsPerMinute) {
    return {
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: secondsUntilNextWindow("minute", at),
    };
  }

  const day = usageFor(db, "day", windowStart("day", at));
  if (day.calls >= limits.callsPerDay) {
    return {
      allowed: false,
      reason: "daily_calls_spent",
      retryAfterSeconds: secondsUntilNextWindow("day", at),
    };
  }
  if (day.input_tokens + day.output_tokens >= limits.tokensPerDay) {
    return {
      allowed: false,
      reason: "daily_tokens_spent",
      retryAfterSeconds: secondsUntilNextWindow("day", at),
    };
  }

  return { allowed: true };
}

/**
 * Count one model call, and its tokens when the caller knows them.
 *
 * Tokens arrive only after a response completes, so a call is recorded first with zero
 * and topped up later. A call whose token usage never arrives — a stream that died, a
 * request that timed out — still counts against the call ceiling, which is the safe
 * direction for a limit to be wrong in.
 */
export function recordModelCall(
  db: Db,
  usage: { inputTokens?: number | null; outputTokens?: number | null } = {},
  options: { at?: Date } = {},
): void {
  const at = options.at ?? new Date();
  const inputTokens = nonNegative(usage.inputTokens);
  const outputTokens = nonNegative(usage.outputTokens);
  const timestamp = now();

  const upsert = db.prepare<[string, string, number, number, string]>(
    `INSERT INTO model_usage
       (window_kind, window_start, calls, input_tokens, output_tokens, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT (window_kind, window_start) DO UPDATE SET
       calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       updated_at = excluded.updated_at`,
  );

  db.transaction(() => {
    for (const kind of ["minute", "day"] as const) {
      upsert.run(kind, windowStart(kind, at), inputTokens, outputTokens, timestamp);
    }
    pruneExpiredWindows(db, at);
  })();
}

/**
 * Add token usage to a call already counted by `recordModelCall`.
 *
 * Kept separate so a streamed turn can be admitted, counted, and only later billed for
 * the tokens it turned out to use, without counting the call twice.
 */
export function recordModelTokens(
  db: Db,
  usage: { inputTokens?: number | null; outputTokens?: number | null },
  options: { at?: Date } = {},
): void {
  const at = options.at ?? new Date();
  const inputTokens = nonNegative(usage.inputTokens);
  const outputTokens = nonNegative(usage.outputTokens);
  if (inputTokens === 0 && outputTokens === 0) return;

  const upsert = db.prepare<[string, string, number, number, string]>(
    `INSERT INTO model_usage
       (window_kind, window_start, calls, input_tokens, output_tokens, updated_at)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT (window_kind, window_start) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       updated_at = excluded.updated_at`,
  );

  const timestamp = now();
  db.transaction(() => {
    for (const kind of ["minute", "day"] as const) {
      upsert.run(kind, windowStart(kind, at), inputTokens, outputTokens, timestamp);
    }
  })();
}

/** Pull token counts off an OpenAI response without depending on its full type. */
export function responseUsage(response: {
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
}): { inputTokens: number | null; outputTokens: number | null } {
  return {
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}

/** Current usage, for the health endpoint and for tests. */
export function modelUsageSnapshot(
  db: Db,
  options: { at?: Date } = {},
): { minute: UsageRow; day: UsageRow } {
  const at = options.at ?? new Date();
  return {
    minute: usageFor(db, "minute", windowStart("minute", at)),
    day: usageFor(db, "day", windowStart("day", at)),
  };
}

/**
 * What to tell the person who hit a ceiling.
 *
 * Says which limit and when it clears, because a user who cannot tell "slow down" from
 * "you are done for today" cannot act on either.
 */
export const BUDGET_MESSAGES: Record<BudgetReason, string> = {
  rate_limited: "Too many requests in a row. Wait a moment and try again.",
  daily_calls_spent:
    "This account has reached its daily limit for model-backed requests. " +
    "Memory browsing, curation, search, and export still work.",
  daily_tokens_spent:
    "This account has reached its daily model usage limit. " +
    "Memory browsing, curation, search, and export still work.",
};

/** Emit a denial as an operational event. Never includes the request's content. */
export function logBudgetDenial(route: string, decision: BudgetDecision): void {
  if (decision.allowed) return;
  logEvent({
    event: "model_budget_denied",
    outcome: "error",
    reason: decision.reason,
    route,
    status: 429,
  });
}

function usageFor(db: Db, kind: WindowKind, start: string): UsageRow {
  return (
    db
      .prepare<[string, string], UsageRow>(
        `SELECT calls, input_tokens, output_tokens FROM model_usage
         WHERE window_kind = ? AND window_start = ?`,
      )
      .get(kind, start) ?? { calls: 0, input_tokens: 0, output_tokens: 0 }
  );
}

/**
 * Windows are fixed UTC buckets rather than a sliding log. A bucket is one row and one
 * indexed lookup; a sliding window would mean retaining every call. The cost is that a
 * caller can spend two minutes' allowance across a bucket boundary, which is an
 * acceptable seam for a ceiling whose job is to stop runaway loops.
 */
export function windowStart(kind: WindowKind, at: Date): string {
  const iso = at.toISOString();
  return kind === "minute" ? `${iso.slice(0, 16)}Z` : `${iso.slice(0, 10)}`;
}

function secondsUntilNextWindow(kind: WindowKind, at: Date): number {
  const milliseconds =
    kind === "minute"
      ? 60_000 - (at.getTime() % 60_000)
      : 86_400_000 - (at.getTime() % 86_400_000);
  return Math.max(1, Math.ceil(milliseconds / 1_000));
}

/** Keep the table bounded: only the current windows can still be spent against. */
function pruneExpiredWindows(db: Db, at: Date): void {
  db.prepare<[string]>(
    "DELETE FROM model_usage WHERE window_kind = 'minute' AND window_start < ?",
  ).run(windowStart("minute", new Date(at.getTime() - 5 * 60_000)));
  db.prepare<[string]>(
    "DELETE FROM model_usage WHERE window_kind = 'day' AND window_start < ?",
  ).run(windowStart("day", new Date(at.getTime() - 90 * 86_400_000)));
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/u.test(trimmed)) throw new Error(`${name} must be a positive integer`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

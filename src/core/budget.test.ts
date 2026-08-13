import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CALLS_PER_MINUTE,
  checkModelBudget,
  configuredBudgetLimits,
  modelUsageSnapshot,
  recordModelCall,
  recordModelTokens,
  responseUsage,
  windowStart,
} from "./budget";
import { openTestDb, type Db } from "./db";

afterEach(() => vi.unstubAllEnvs());

const LIMITS = { callsPerMinute: 3, callsPerDay: 5, tokensPerDay: 1_000 };
const AT = new Date("2026-08-14T10:30:15.000Z");

function spend(db: Db, calls: number, at = AT): void {
  for (let index = 0; index < calls; index += 1) recordModelCall(db, {}, { at });
}

describe("per-store model budget", () => {
  it("admits calls up to the per-minute ceiling and then asks for a wait", () => {
    const db = openTestDb();

    spend(db, 3);
    const decision = checkModelBudget(db, { at: AT, limits: LIMITS });

    expect(decision).toMatchObject({ allowed: false, reason: "rate_limited" });
    // 45 seconds remain in the 10:30 bucket.
    expect(decision.allowed === false && decision.retryAfterSeconds).toBe(45);
  });

  it("clears the per-minute ceiling in the next minute but keeps the daily count", () => {
    const db = openTestDb();
    spend(db, 3);

    const nextMinute = new Date("2026-08-14T10:31:00.000Z");
    expect(checkModelBudget(db, { at: nextMinute, limits: LIMITS })).toEqual({
      allowed: true,
    });
    expect(modelUsageSnapshot(db, { at: nextMinute }).day.calls).toBe(3);
  });

  it("stops for the rest of the day once the daily call ceiling is reached", () => {
    const db = openTestDb();
    spend(db, 3);
    spend(db, 2, new Date("2026-08-14T10:31:00.000Z"));

    const decision = checkModelBudget(db, {
      at: new Date("2026-08-14T10:32:00.000Z"),
      limits: LIMITS,
    });

    expect(decision).toMatchObject({ allowed: false, reason: "daily_calls_spent" });
  });

  it("stops on tokens even while the call count is still under its ceiling", () => {
    const db = openTestDb();
    recordModelCall(db, { inputTokens: 600, outputTokens: 500 }, { at: AT });

    const decision = checkModelBudget(db, { at: AT, limits: LIMITS });

    expect(decision).toMatchObject({ allowed: false, reason: "daily_tokens_spent" });
    expect(modelUsageSnapshot(db, { at: AT }).day.calls).toBe(1);
  });

  it("survives a restart, because a cap a crash-loop can clear is not a cap", () => {
    const db = openTestDb();
    spend(db, 3);

    // The counters are rows, not process memory: a new reader sees the same spend.
    expect(modelUsageSnapshot(db, { at: AT }).minute.calls).toBe(3);
    expect(checkModelBudget(db, { at: AT, limits: LIMITS })).toMatchObject({
      allowed: false,
    });
  });

  it("bills tokens to an already-counted call without counting it twice", () => {
    const db = openTestDb();
    recordModelCall(db, {}, { at: AT });

    recordModelTokens(db, { inputTokens: 120, outputTokens: 30 }, { at: AT });

    const usage = modelUsageSnapshot(db, { at: AT });
    expect(usage.day.calls).toBe(1);
    expect(usage.day.input_tokens).toBe(120);
    expect(usage.day.output_tokens).toBe(30);
  });

  it("counts a call whose token usage never arrives", () => {
    const db = openTestDb();

    // A stream that died mid-turn still spent money.
    recordModelCall(db, { inputTokens: null, outputTokens: undefined }, { at: AT });

    expect(modelUsageSnapshot(db, { at: AT }).day).toMatchObject({
      calls: 1,
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("keeps one store's spending out of another's ledger", () => {
    const spender = openTestDb();
    const other = openTestDb();
    spend(spender, 3);

    expect(checkModelBudget(spender, { at: AT, limits: LIMITS })).toMatchObject({
      allowed: false,
    });
    expect(checkModelBudget(other, { at: AT, limits: LIMITS })).toEqual({ allowed: true });
  });

  it("prunes stale minute buckets so the table cannot grow without bound", () => {
    const db = openTestDb();
    recordModelCall(db, {}, { at: new Date("2026-08-14T09:00:00.000Z") });
    recordModelCall(db, {}, { at: AT });

    const rows = db
      .prepare<[], { window_kind: string; window_start: string }>(
        "SELECT window_kind, window_start FROM model_usage WHERE window_kind = 'minute'",
      )
      .all();

    expect(rows).toEqual([{ window_kind: "minute", window_start: windowStart("minute", AT) }]);
  });

  it("reads limits from the environment and rejects a nonsense value", () => {
    expect(configuredBudgetLimits({}).callsPerMinute).toBe(DEFAULT_CALLS_PER_MINUTE);
    expect(
      configuredBudgetLimits({ ZEUS_MODEL_CALLS_PER_MINUTE: "7" }).callsPerMinute,
    ).toBe(7);
    expect(() => configuredBudgetLimits({ ZEUS_MODEL_CALLS_PER_DAY: "0" })).toThrow(
      /positive integer/u,
    );
    expect(() => configuredBudgetLimits({ ZEUS_MODEL_TOKENS_PER_DAY: "lots" })).toThrow(
      /positive integer/u,
    );
  });
});

describe("usage extraction", () => {
  it("reads token counts off a response and tolerates their absence", () => {
    expect(responseUsage({ usage: { input_tokens: 10, output_tokens: 4 } })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(responseUsage({})).toEqual({ inputTokens: null, outputTokens: null });
    expect(responseUsage({ usage: null })).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });
});

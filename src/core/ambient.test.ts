import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const ambientMocks = vi.hoisted(() => ({
  restoreConnectorReachability: vi.fn(async () => false),
}));

vi.mock("./mcp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-client")>()),
  restoreConnectorReachability: ambientMocks.restoreConnectorReachability,
}));

import {
  ambientDeliveriesForLocalDay,
  buildAmbientEvaluationContext,
  getAmbientDeliveryAttempt,
  getAmbientSetting,
  getCoarseLocation,
  getFreshCoarseLocation,
  isQuietLocalTime,
  recordCoarseLocation,
  refreshExternalSignals,
  resolveTodayOpportunity,
  runAmbientEvaluation,
  updateAmbientSetting,
  type AmbientNotification,
  type AmbientNotifier,
} from "./ambient";
import { buildAmbientLaunchAgentPlist } from "./ambient-launch-agent";
import { appendMessage, createConversation } from "./conversations";
import { openDb, openTestDb } from "./db";
import { createCommitment, updateCommitment } from "./intentions";
import { deleteConversationWithMemory } from "./retention";
import {
  createEvaluationContext,
  followThroughMetrics,
  listFollowThroughEvents,
  listOpportunityDeliveries,
  markOpportunityDelivered,
  setStewardshipMode,
} from "./stewardship";

afterEach(() => {
  vi.useRealTimers();
});

function source(db: ReturnType<typeof openTestDb>) {
  const conversation = createConversation(db);
  return appendMessage(db, conversation.id, "user", "I need to prepare the launch brief.");
}

/**
 * Something worth delivering, in an account that agreed to be interrupted about it.
 *
 * Proactivity is opt-in and defaults to `off`, so a due commitment on its own produces no
 * ambient delivery at all. Every test below is about how a delivery is claimed, budgeted, or
 * released — questions that only arise once the user has opted in.
 */
function dueCommitment(db: ReturnType<typeof openTestDb>) {
  const message = source(db);
  setStewardshipMode(db, "balanced", message.id);
  return createCommitment(db, {
    title: "Prepare the launch brief",
    dueAt: "2029-12-01T09:00:00.000Z",
    sourceMessageId: message.id,
  });
}

describe("the scheduled refresh", () => {
  it("gives an unreachable connector its handshake instead of no-oping forever", async () => {
    const db = openTestDb();

    const result = await refreshExternalSignals(db);

    // Nothing is connected here, so the sync itself degrades — but the heal was attempted,
    // which is what keeps a background refresh from silently skipping a repairable outage.
    expect(ambientMocks.restoreConnectorReachability).toHaveBeenCalledWith(
      db,
      "calendar.list_events",
      { signal: undefined },
    );
    expect(ambientMocks.restoreConnectorReachability).toHaveBeenCalledWith(
      db,
      "email.search_threads",
      { signal: undefined },
    );
    expect(result.synced).toBe(false);
  });
});

function notifier(result = true): AmbientNotifier & { calls: AmbientNotification[] } {
  const calls: AmbientNotification[] = [];
  return {
    calls,
    deliver(notification) {
      calls.push(notification);
      return result;
    },
  };
}

describe("ambient settings and context", () => {
  it("is disabled by default and requires explicit location consent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const db = openTestDb();

    expect(getAmbientSetting(db)).toMatchObject({
      enabled: 0,
      timezone: "UTC",
      quiet_start: "22:00",
      quiet_end: "08:00",
      daily_limit: 1,
      channels_json: '["macos"]',
      location_consent: 0,
    });
    expect(() => recordCoarseLocation(db, "home", new Date())).toThrow(/consent/u);
    const adapter = notifier();
    expect(runAmbientEvaluation(db, adapter)).toEqual({ status: "disabled" });
    expect(adapter.calls).toEqual([]);
  });

  it("keeps only a fresh coarse named zone and deletes it when consent is revoked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const db = openTestDb();
    updateAmbientSetting(db, { locationConsent: true, timezone: "Asia/Singapore" });

    const recorded = recordCoarseLocation(db, "  Home   area ", new Date());
    expect(recorded).toMatchObject({
      zone_id: "home area",
      observed_at: "2030-01-07T09:00:00.000Z",
      expires_at: "2030-01-07T09:30:00.000Z",
    });
    expect(
      buildAmbientEvaluationContext(db, new Date("2030-01-07T09:29:59.000Z")),
    ).toMatchObject({
      trigger: "worker",
      timezone: "Asia/Singapore",
      local_time: "17:29",
      location_zone: "home area",
      location_observed_at: "2030-01-07T09:00:00.000Z",
    });
    expect(getFreshCoarseLocation(db, new Date("2030-01-07T09:30:00.000Z"))).toBeNull();
    expect(
      buildAmbientEvaluationContext(db, new Date("2030-01-07T09:31:00.000Z")),
    ).toMatchObject({ location_zone: null, location_observed_at: null });

    updateAmbientSetting(db, { locationConsent: false });
    expect(getCoarseLocation(db)).toBeNull();
  });

  it("validates user-sourced changes and IANA timezones", () => {
    const db = openTestDb();
    const user = source(db);
    const assistant = appendMessage(db, user.conversation_id, "assistant", "Okay.");

    expect(
      updateAmbientSetting(db, {
        enabled: true,
        timezone: "America/New_York",
        sourceMessageId: user.id,
      }),
    ).toMatchObject({ enabled: 1, timezone: "America/New_York", source_message_id: user.id });
    expect(() => updateAmbientSetting(db, { sourceMessageId: assistant.id })).toThrow(
      /stored user message/u,
    );
    expect(() => updateAmbientSetting(db, { timezone: "Mars/Olympus" })).toThrow(
      /Invalid IANA timezone/u,
    );
    expect(() => updateAmbientSetting(db, { dailyLimit: 2 as 1 })).toThrow(
      /one notification per local day/u,
    );
  });

  it("revokes ambient delivery and coarse location when its source is deleted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const db = openTestDb();
    const user = source(db);
    updateAmbientSetting(db, {
      enabled: true,
      timezone: "Asia/Singapore",
      quietStart: "23:00",
      quietEnd: "07:00",
      locationConsent: true,
      sourceMessageId: user.id,
    });
    recordCoarseLocation(db, "home", new Date());

    deleteConversationWithMemory(db, user.conversation_id);

    expect(getAmbientSetting(db)).toMatchObject({
      enabled: 0,
      timezone: "UTC",
      quiet_start: "22:00",
      quiet_end: "08:00",
      daily_limit: 1,
      channels_json: '["macos"]',
      location_consent: 0,
      source_message_id: null,
    });
    expect(getCoarseLocation(db)).toBeNull();
  });
});

describe("ambient eligibility", () => {
  it("renders a LaunchAgent with the exact resolved database path and no shell", () => {
    const plist = buildAmbientLaunchAgentPlist({
      nodePath: "/opt/node & runtime/bin/node",
      tsxCliPath: "/opt/zeus/node_modules/tsx.mjs",
      workerPath: "/opt/zeus/scripts/ambient-worker.ts",
      databasePath: "/Volumes/Private & Local/zeus.db",
      stdoutPath: "/tmp/zeus.out",
      stderrPath: "/tmp/zeus.err",
    });

    expect(plist).toContain("<string>--db</string>");
    expect(plist).toContain("<string>/Volumes/Private &amp; Local/zeus.db</string>");
    expect(plist).toContain("<integer>900</integer>");
    expect(plist).not.toMatch(/(?:sh|zsh|bash) -c/u);
  });

  it("supports ordinary and overnight quiet-hour windows", () => {
    expect(isQuietLocalTime("13:00", "12:00", "14:00")).toBe(true);
    expect(isQuietLocalTime("14:00", "12:00", "14:00")).toBe(false);
    expect(isQuietLocalTime("23:30", "22:00", "08:00")).toBe(true);
    expect(isQuietLocalTime("07:59", "22:00", "08:00")).toBe(true);
    expect(isQuietLocalTime("08:00", "22:00", "08:00")).toBe(false);
    expect(isQuietLocalTime("17:00", "22:00", "08:00")).toBe(false);
  });

  it("does not evaluate or replay an opportunity during quiet hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T23:00:00.000Z"));
    const db = openTestDb();
    dueCommitment(db);
    updateAmbientSetting(db, { enabled: true });
    const adapter = notifier();

    expect(runAmbientEvaluation(db, adapter)).toMatchObject({ status: "quiet_hours" });
    expect(adapter.calls).toEqual([]);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM recommendation_cycle").get()
        ?.count,
    ).toBe(0);

    vi.setSystemTime(new Date("2030-01-08T09:00:00.000Z"));
    expect(runAmbientEvaluation(db, adapter)).toMatchObject({ status: "delivered" });
    expect(adapter.calls).toHaveLength(1);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM recommendation_cycle").get()
        ?.count,
    ).toBe(1);
  });

  it("respects a disabled macOS channel", () => {
    const db = openTestDb();
    updateAmbientSetting(db, { enabled: true, allowedChannels: ["today"] });
    const adapter = notifier();
    expect(runAmbientEvaluation(db, adapter)).toEqual({ status: "channel_disabled" });
    expect(adapter.calls).toEqual([]);
  });
});

describe("ambient delivery accounting", () => {
  it("reuses one still-relevant worker opportunity on Today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const db = openTestDb();
    const commitment = dueCommitment(db);
    updateAmbientSetting(db, { enabled: true, timezone: "UTC" });

    const delivered = runAmbientEvaluation(db, notifier());
    expect(delivered).toMatchObject({ status: "delivered" });
    if (delivered.status !== "delivered") throw new Error("Expected ambient delivery");

    const todayContext = createEvaluationContext({
      trigger: "today",
      timezone: "UTC",
      referenceTime: new Date("2030-01-07T09:10:00.000Z"),
    });
    const reused = resolveTodayOpportunity(db, todayContext);
    expect(reused?.id).toBe(delivered.opportunityId);
    markOpportunityDelivered(db, reused!.id, "today");

    expect(listOpportunityDeliveries(db, reused!.id).map((item) => item.channel)).toEqual([
      "macos",
      "today",
    ]);
    expect(listFollowThroughEvents(db).filter((event) => event.event_type === "surfaced"))
      .toHaveLength(1);

    const feedbackConversation = createConversation(db);
    const completed = appendMessage(
      db,
      feedbackConversation.id,
      "user",
      "I completed the launch brief.",
    );
    updateCommitment(db, commitment.id, {
      status: "done",
      sourceMessageId: completed.id,
      sourceKind: "message",
    });
    expect(resolveTodayOpportunity(db, todayContext)).toBeNull();
  });

  it("releases a failed claim and records delivery only after notifier success", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const db = openTestDb();
    dueCommitment(db);
    updateAmbientSetting(db, { enabled: true });
    const adapter = notifier(false);

    const result = runAmbientEvaluation(db, adapter);
    expect(result).toMatchObject({ status: "delivery_failed" });
    expect(adapter.calls).toHaveLength(1);
    const opportunityId = result.status === "delivery_failed" ? result.opportunityId : 0;
    expect(listOpportunityDeliveries(db, opportunityId)).toEqual([]);
    expect(followThroughMetrics(db).surfaced).toBe(0);
    const attempt = result.status === "delivery_failed"
      ? getAmbientDeliveryAttempt(db, result.attemptId)
      : null;
    expect(attempt).toMatchObject({
      status: "failed",
      claim_slot: null,
      error_code: "notifier_failed",
    });

    expect(runAmbientEvaluation(db, notifier())).toMatchObject({ status: "delivered" });
    expect(followThroughMetrics(db).surfaced).toBe(1);
  });

  it("commits a claim before notifying and serializes a concurrent invocation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const db = openTestDb();
    dueCommitment(db);
    updateAmbientSetting(db, { enabled: true, dailyLimit: 1 });
    let concurrent: ReturnType<typeof runAmbientEvaluation> | null = null;
    const concurrentAdapter = notifier();
    const calls: AmbientNotification[] = [];
    const adapter: AmbientNotifier & { calls: AmbientNotification[] } = {
      calls,
      deliver(notification) {
        calls.push(notification);
        concurrent = runAmbientEvaluation(db, concurrentAdapter);
        return true;
      },
    };

    const first = runAmbientEvaluation(db, adapter);
    expect(first).toMatchObject({ status: "delivered" });
    expect(concurrent).toMatchObject({
      status: "delivery_in_flight",
      opportunityId: first.status === "delivered" ? first.opportunityId : -1,
      attemptId: first.status === "delivered" ? first.attemptId : -1,
    });
    expect(concurrentAdapter.calls).toEqual([]);
    expect(adapter.calls[0]).toMatchObject({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      title: "Zeus has one useful next step",
    });
    expect(first.status === "delivered" ? first.delivery.channel : null).toBe("macos");
    expect(first.status === "delivered" ? getAmbientDeliveryAttempt(db, first.attemptId) : null)
      .toMatchObject({
        status: "succeeded",
        delivery_id: first.status === "delivered" ? first.delivery.id : -1,
      });
    expect(followThroughMetrics(db).surfaced).toBe(1);

    vi.setSystemTime(new Date("2030-01-07T09:15:00.000Z"));
    const second = runAmbientEvaluation(db, adapter);
    expect(second).toMatchObject({ status: "daily_limit" });
    expect(adapter.calls).toHaveLength(1);
    expect(followThroughMetrics(db).surfaced).toBe(1);
    if (second.status === "daily_limit") {
      expect(ambientDeliveriesForLocalDay(db, second.context)).toBe(1);
    }
  });

  it("releases the SQLite write lock before invoking the notifier", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const directory = mkdtempSync(join(tmpdir(), "zeus-ambient-"));
    const databasePath = join(directory, "ambient.db");
    const primary = openDb(databasePath);
    try {
      dueCommitment(primary);
      updateAmbientSetting(primary, { enabled: true });
      let concurrent: ReturnType<typeof runAmbientEvaluation> | null = null;
      const result = runAmbientEvaluation(primary, {
        deliver() {
          const secondary = openDb(databasePath);
          try {
            concurrent = runAmbientEvaluation(secondary, notifier());
          } finally {
            secondary.close();
          }
          return true;
        },
      });

      expect(result).toMatchObject({ status: "delivered" });
      expect(concurrent).toMatchObject({ status: "delivery_in_flight" });
    } finally {
      primary.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails an expired delivery lease closed instead of risking a restart duplicate", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-07T09:00:00.000Z"));
    const db = openTestDb();
    dueCommitment(db);
    updateAmbientSetting(db, { enabled: true });
    let restart: ReturnType<typeof runAmbientEvaluation> | null = null;

    expect(() =>
      runAmbientEvaluation(db, {
        deliver() {
          vi.setSystemTime(new Date("2030-01-07T09:03:00.000Z"));
          restart = runAmbientEvaluation(db, notifier());
          return true;
        },
      }),
    ).toThrow(/claim is no longer active/u);

    expect(restart).toMatchObject({ status: "daily_limit" });
    const attempt = db
      .prepare<[], { id: number }>(
        "SELECT id FROM ambient_delivery_attempt ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(attempt ? getAmbientDeliveryAttempt(db, attempt.id) : null).toMatchObject({
      status: "unknown",
      claim_slot: "macos:2030-01-07",
      error_code: "lease_expired_delivery_unknown",
    });
    expect(followThroughMetrics(db).surfaced).toBe(0);
  });

  it("applies the notification budget to the configured local calendar day across DST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-11-03T05:30:00.000Z"));
    const db = openTestDb();
    dueCommitment(db);
    updateAmbientSetting(db, {
      enabled: true,
      timezone: "America/New_York",
      quietStart: "03:00",
      quietEnd: "04:00",
    });
    const adapter = notifier();

    const first = runAmbientEvaluation(db, adapter);
    expect(first).toMatchObject({ status: "delivered", context: { local_time: "01:30" } });
    // 06:30Z repeats 01:30 after the fall-back transition, but it is still the same local day.
    vi.setSystemTime(new Date("2030-11-03T06:30:00.000Z"));
    expect(runAmbientEvaluation(db, adapter)).toMatchObject({
      status: "daily_limit",
      context: { local_time: "01:30" },
    });
    expect(adapter.calls).toHaveLength(1);
  });

});

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bindCapability,
  createConnector,
  getConnector,
  listConnectors,
  setCapabilityEnabled,
  setConnectorEnabled,
} from "./connectors";
import { calendarActionWorkPlanProposal, encodeCalendarRequest } from "./calendar-actions";
import type { CalendarRequest } from "./calendar-actions";
import { updateCalendarActionSetting } from "./calendar-policy";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import {
  confirmEffect,
  declineEffect,
  effectsForRun,
  executeConfirmedEffect,
} from "./effects";
import { verifyConnector } from "./mcp-client";
import {
  cacheCalendarEvents,
  cachedEvents,
  parseCalendarEvents,
  readCalendarCoverage,
} from "./calendar-sync";
import { createSafeWorkExecutor, payloadSchemaMismatch } from "./work-execution";
import {
  authorizeWorkPlan,
  createWorkPlan,
  listToolReceipts,
  listWorkArtifacts,
  resumeWorkRun,
  runWorkPlan,
} from "./work-plans";

/**
 * The end-to-end shape of an acting turn: a run reaches a write step, prepares the exact
 * request, and stops. Nothing reaches the connected service until the user confirms the
 * payload hash — and after that, exactly those bytes and no others.
 *
 * The model calls are stubbed with a scripted executor so this stays an offline test of
 * the deterministic write path, in the same spirit as `seed:demo`.
 */

let db: Db;
let userMessageId: number;
let conversationId: number;
let directory: string;
let callLog: string;

const require = createRequire(import.meta.url);
const moduleUrl = (specifier: string): string =>
  pathToFileURL(require.resolve(specifier)).href;

const CALENDAR_SERVER = `
import { McpServer } from "${moduleUrl("@modelcontextprotocol/sdk/server/mcp.js")}";
import { StdioServerTransport } from "${moduleUrl("@modelcontextprotocol/sdk/server/stdio.js")}";
import { z } from "${moduleUrl("zod")}";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const log = process.env.FAKE_CALENDAR_CALL_LOG;

// A service that is briefly unavailable. Each call spawns a fresh child, so a marker file
// is what carries "this has already failed once" between them.
const failOnce = process.env.FAKE_CALENDAR_FAIL_ONCE;
if (failOnce && !existsSync(failOnce)) {
  writeFileSync(failOnce, "1");
  process.exit(1);
}

const server = new McpServer({ name: "fake-calendar", version: "0.0.1" });

const DEFAULT_EVENTS = [
  { id: "evt-a", summary: "Flight lands", start: "2026-08-20T18:40:00Z", end: "2026-08-20T19:10:00Z" },
];

server.registerTool(
  "list_events",
  { title: "List events", inputSchema: { from: z.string(), to: z.string() },
    annotations: { readOnlyHint: true } },
  async (args) => {
    if (log) appendFileSync(log, JSON.stringify({ tool: "list_events", args }) + "\\n");
    if (process.env.FAKE_CALENDAR_RESULT_MODE === "error") {
      return { isError: true, content: [{ type: "text", text: "calendar_read_failed" }] };
    }
    if (process.env.FAKE_CALENDAR_RESULT_MODE === "malformed") {
      return { content: [{ type: "text", text: JSON.stringify({ not_events: [] }) }] };
    }
    if (process.env.FAKE_CALENDAR_RESULT_MODE === "malformed_event") {
      return { content: [{ type: "text", text: JSON.stringify({ events: [{ summary: "No id" }] }) }] };
    }
    const events = process.env.FAKE_CALENDAR_EVENTS
      ? JSON.parse(process.env.FAKE_CALENDAR_EVENTS)
      : DEFAULT_EVENTS;
    return { content: [{ type: "text", text: JSON.stringify({ events }) }] };
  },
);

// Mirrors the real broker's contract, so a payload built here is a payload that would work.
server.registerTool(
  "create_event",
  {
    title: "Create event",
    inputSchema: {
      title: z.string(),
      start: z.string(),
      end: z.string(),
      time_zone: z.string().optional(),
      location: z.string().optional(),
    },
  },
  async (args) => {
    if (log) appendFileSync(log, JSON.stringify({ tool: "create_event", args }) + "\\n");
    return { content: [{ type: "text", text: JSON.stringify({ id: "evt-new", ...args }) }] };
  },
);

server.registerTool(
  "update_event",
  {
    title: "Update event",
    inputSchema: {
      event_id: z.string(),
      start: z.string().optional(),
      end: z.string().optional(),
      status: z.string().optional(),
      title: z.string().optional(),
      location: z.string().optional(),
      time_zone: z.string().optional(),
    },
  },
  async (args) => {
    if (log) appendFileSync(log, JSON.stringify({ tool: "update_event", args }) + "\\n");
    return { content: [{ type: "text", text: JSON.stringify({ updated: args.event_id }) }] };
  },
);

await server.connect(new StdioServerTransport());
`;

beforeEach(() => {
  db = openTestDb();
  const conversation = createConversation(db, { title: "Work requests", source: "web" });
  conversationId = conversation.id;
  userMessageId = appendMessage(
    db,
    conversationId,
    "user",
    "check my calendar that week and hold the better option",
    { origin: "user_action", recallState: "blocked" },
  ).id;
  directory = mkdtempSync(join(tmpdir(), "zeus-work-effects-"));
  callLog = join(directory, "calls.log");
  process.env.FAKE_CALENDAR_CALL_LOG = callLog;
  process.env.FAKE_CALENDAR_EVENTS = "";
  process.env.FAKE_CALENDAR_RESULT_MODE = "";
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.FAKE_CALENDAR_CALL_LOG;
  delete process.env.FAKE_CALENDAR_EVENTS;
  delete process.env.FAKE_CALENDAR_RESULT_MODE;
  delete process.env.FAKE_CALENDAR_FAIL_ONCE;
});

function recordedCalls(): Array<Record<string, unknown>> {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function connectCalendar(): Promise<void> {
  writeFileSync(join(directory, "calendar-server.mjs"), CALENDAR_SERVER, { mode: 0o600 });
  const connector = createConnector(db, {
    label: "Fake calendar",
    transport: "stdio",
    command: process.execPath,
    args: [join(directory, "calendar-server.mjs")],
    cwd: process.cwd(),
    envVarNames: [
      "FAKE_CALENDAR_CALL_LOG",
      "FAKE_CALENDAR_EVENTS",
      "FAKE_CALENDAR_RESULT_MODE",
    ],
    sourceMessageId: userMessageId,
  });
  const { tools } = await verifyConnector(db, connector.id);
  for (const [slot, tool] of [
    ["calendar.list_events", "list_events"],
    ["calendar.create_event", "create_event"],
    ["calendar.update_event", "update_event"],
  ] as const) {
    const discovered = tools.find((entry) => entry.name === tool);
    if (!discovered) throw new Error(`missing ${tool}`);
    bindCapability(db, {
      connectorId: connector.id,
      slot,
      remoteToolName: tool,
      inputSchema: discovered.inputSchema,
      sourceMessageId: userMessageId,
    });
  }
  setConnectorEnabled(db, connector.id, true, userMessageId);
  for (const capability of getConnector(db, connector.id)?.capabilities ?? []) {
    setCapabilityEnabled(db, capability.id, true, userMessageId);
  }
}

const PROPOSAL = calendarActionWorkPlanProposal(
  {
    kind: "create",
    title: "Dinner",
    startsAt: "2026-08-20T18:30:00.000Z",
    endsAt: "2026-08-20T19:30:00.000Z",
    location: null,
    timezone: "UTC",
  },
  "Hold the dinner slot after the flight lands",
);


/**
 * Drives the real executor.
 *
 * The calendar payload is built deterministically now, so the whole write path — read,
 * resolve, check, act — runs offline without a model. That is the point: the gate is
 * testable rather than merely described.
 */
async function realRun(
  options: { request?: CalendarRequest; skipRead?: boolean } = {},
) {
  const request: CalendarRequest = options.request ?? {
    kind: "create",
    title: "Dinner",
    startsAt: "2026-08-20T18:30:00.000Z",
    endsAt: "2026-08-20T19:30:00.000Z",
    location: null,
    timezone: "UTC",
  };
  const proposal = options.skipRead
    ? {
        ...calendarActionWorkPlanProposal(request, calendarObjective(request)),
        // Deliberately malformed: a plan that writes without reading must fail closed
        // rather than clear a slot it never looked at.
        steps: calendarActionWorkPlanProposal(request, calendarObjective(request))
          .steps.slice(1)
          .map((step, index) => ({ ...step, depends_on: index === 0 ? [] : [index] })),
      }
    : calendarActionWorkPlanProposal(request, calendarObjective(request));
  const detail = createWorkPlan(db, {
    proposal,
    sourceMessageId: userMessageId,
    origin: "explicit_request",
  });
  authorizeWorkPlan(db, detail.plan.id, {
    planHash: detail.plan.plan_hash,
    authorizationKind: "explicit_request",
    allowedEffects: proposal.allowed_effects,
    maxModelToolCalls: detail.plan.max_model_tool_calls,
    maxRetriesPerStep: detail.plan.max_retries_per_step,
    maxDurationSeconds: detail.plan.max_duration_seconds,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    sourceMessageId: userMessageId,
  });
  const run = await runWorkPlan(db, detail.plan.id, {
    executor: createSafeWorkExecutor(db),
  });
  return { planId: detail.plan.id, run };
}

function calendarObjective(request: CalendarRequest): string {
  return `Calendar request from the user.\n\n${encodeCalendarRequest(request)}`;
}


describe("a calendar change reads first, checks, then acts", () => {
  it("creates the event when the requested time is genuinely free", async () => {
    // A calendar with something on it, but not at the requested time.
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      { id: "evt-a", summary: "Flight lands", start: "2026-08-20T14:00:00Z", end: "2026-08-20T15:00:00Z" },
    ]);
    await connectCalendar();

    const { run } = await realRun();

    expect(run.status).toBe("completed");
    const effects = effectsForRun(db, run.id);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.status).toBe("executed");
    // The ledger says which of the two authorization paths was used, and never guesses.
    expect(effects[0]?.confirmation_kind).toBe("standing_policy");
    expect(effects[0]?.request_message_id).toBe(userMessageId);
    expect(effects[0]?.events.map((event) => event.event_type)).toEqual([
      "proposed",
      "authorized_by_policy",
      "executed",
    ]);

    const calls = recordedCalls();
    expect(calls.map((call) => call.tool)).toEqual(["list_events", "create_event"]);
    expect(calls[1]?.args).toMatchObject({
      title: "Dinner",
      start: "2026-08-20T18:30:00.000Z",
      end: "2026-08-20T19:30:00.000Z",
    });
    const receipts = listToolReceipts(db, run.id);
    expect(receipts.filter((receipt) => receipt.tool_name === "connector_call")).toHaveLength(2);
  }, 30_000);

  it("prepares one exact override when a move's destination is occupied", async () => {
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      {
        id: "evt-dinner",
        summary: "Dinner",
        start: "2026-08-20T17:00:00Z",
        end: "2026-08-20T18:00:00Z",
      },
      {
        id: "evt-taken",
        summary: "Design review",
        start: "2026-08-20T19:30:00Z",
        end: "2026-08-20T20:30:00Z",
      },
    ]);
    await connectCalendar();

    const { planId, run } = await realRun({
      request: {
        kind: "reschedule",
        reference: { titleText: "dinner", startsAt: null, dateLocal: null },
        startsAt: "2026-08-20T19:30:00.000Z",
        endsAt: "2026-08-20T20:30:00.000Z",
        timezone: "UTC",
      },
    });

    expect(run.status).toBe("paused");
    expect(run.error_code).toBe("effect_confirmation_required");
    const effect = effectsForRun(db, run.id)[0];
    expect(effect).toMatchObject({
      status: "pending_confirmation",
      confirmation_kind: "user_message",
      payload: {
        event_id: "evt-dinner",
        start: "2026-08-20T19:30:00.000Z",
        end: "2026-08-20T20:30:00.000Z",
      },
    });
    const check = JSON.parse(effect!.conflict_check_json!) as {
      status: string;
      considered_events: number;
      conflicts: Array<{ external_id: string }>;
      coverage: unknown;
    };
    expect(check).toMatchObject({ status: "conflict", considered_events: 2 });
    expect(check.coverage).toBeTruthy();
    expect(check.conflicts.map((conflict) => conflict.external_id)).toEqual(["evt-taken"]);
    // The read is the only connector call before confirmation.
    expect(recordedCalls().map((call) => call.tool)).toEqual(["list_events"]);

    const artifacts = listWorkArtifacts(db, { planId });
    const pending = artifacts.find((artifact) => artifact.content.includes("calendar_conflict"));
    expect(pending?.content).toContain("Design review");
    expect(pending?.content).toContain("alternatives");

    const confirmation = appendMessage(
      db,
      conversationId,
      "user",
      `I confirm external request ${effect!.payload_hash}.`,
      { origin: "user_action", recallState: "blocked" },
    ).id;
    confirmEffect(db, effect!.id, effect!.payload_hash, confirmation);
    expect((await executeConfirmedEffect(db, effect!.id)).status).toBe("executed");
    const resumed = await resumeWorkRun(db, run.id, { executor: createSafeWorkExecutor(db) });
    expect(resumed.status).toBe("completed");
    expect(recordedCalls().map((call) => call.tool)).toEqual(["list_events", "update_event"]);
  }, 30_000);

  it("declining an occupied destination sends nothing", async () => {
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      { id: "evt-taken", summary: "Design review", start: "2026-08-20T18:00:00Z", end: "2026-08-20T19:00:00Z" },
    ]);
    await connectCalendar();

    const { run } = await realRun();
    const effect = effectsForRun(db, run.id)[0];
    if (!effect) throw new Error("no pending conflict effect");
    const decline = appendMessage(db, conversationId, "user", "Don't add it.", {
      origin: "user_action",
      recallState: "blocked",
    }).id;
    declineEffect(db, effect.id, decline, "user_declined");

    expect(effectsForRun(db, run.id)[0]?.status).toBe("declined");
    expect(recordedCalls().map((call) => call.tool)).toEqual(["list_events"]);
  }, 30_000);

  it("will not clear a slot against a calendar it could not read", async () => {
    await connectCalendar();
    const { run } = await realRun({ skipRead: true });

    expect(run.status).toBe("paused");
    expect(run.error_code).toBe("calendar_unverifiable");
    expect(effectsForRun(db, run.id)).toHaveLength(0);
    expect(recordedCalls().filter((call) => call.tool === "create_event")).toEqual([]);
  }, 30_000);

  it.each(["error", "malformed", "malformed_event"])(
    "does not create read coverage for a %s Calendar response",
    async (mode) => {
      await connectCalendar();
      process.env.FAKE_CALENDAR_RESULT_MODE = mode;

      const { run } = await realRun();

      expect(run.status).toBe("paused");
      expect(run.error_code).toBe("calendar_unverifiable");
      expect(readCalendarCoverage(db)).toBeNull();
      expect(effectsForRun(db, run.id)).toHaveLength(0);
      expect(recordedCalls().filter((call) => call.tool !== "list_events")).toEqual([]);
    },
    30_000,
  );

  it("falls back to asking when the standing setting is switched off", async () => {
    // A calendar with something on it, but not at the requested time.
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      { id: "evt-a", summary: "Flight lands", start: "2026-08-20T14:00:00Z", end: "2026-08-20T15:00:00Z" },
    ]);
    await connectCalendar();
    updateCalendarActionSetting(db, { directExecution: false }, userMessageId);

    const { run } = await realRun();

    expect(run.status).toBe("paused");
    expect(run.error_code).toBe("effect_confirmation_required");
    const effect = effectsForRun(db, run.id)[0];
    expect(effect?.status).toBe("pending_confirmation");
    expect(effect?.confirmation_kind).toBe("user_message");
    expect(recordedCalls().filter((call) => call.tool === "create_event")).toEqual([]);

    // And the hand-confirmation path still works end to end.
    if (!effect) throw new Error("no proposed effect");
    const confirmation = appendMessage(
      db,
      conversationId,
      "user",
      `I confirm external request ${effect.payload_hash}.`,
      { origin: "user_action", recallState: "blocked" },
    ).id;
    confirmEffect(db, effect.id, effect.payload_hash, confirmation);
    const result = await executeConfirmedEffect(db, effect.id);
    expect(result.status).toBe("executed");
  }, 30_000);

  it("keeps the artifact that explains why it stopped", async () => {
    // A calendar with something on it, but not at the requested time.
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      { id: "evt-a", summary: "Flight lands", start: "2026-08-20T14:00:00Z", end: "2026-08-20T15:00:00Z" },
    ]);
    await connectCalendar();
    updateCalendarActionSetting(db, { directExecution: false }, userMessageId);

    const { planId } = await realRun();

    // A paused step used to return before its artifacts were written, throwing away the
    // one record of what it was holding.
    expect(listWorkArtifacts(db, { planId }).length).toBeGreaterThan(0);
  }, 30_000);

  it("moves an event away from an existing conflict when the destination is free", async () => {
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      {
        id: "evt-review",
        summary: "Design review",
        start: "2026-08-20T15:00:00Z",
        end: "2026-08-20T16:00:00Z",
      },
      {
        id: "evt-overlap",
        summary: "Client call",
        start: "2026-08-20T15:30:00Z",
        end: "2026-08-20T16:30:00Z",
      },
    ]);
    await connectCalendar();

    const { run } = await realRun({
      request: {
        kind: "reschedule",
        reference: { titleText: "design review", startsAt: null, dateLocal: null },
        startsAt: "2026-08-20T17:00:00.000Z",
        endsAt: "2026-08-20T18:00:00.000Z",
        timezone: "UTC",
      },
    });

    expect(run.status).toBe("completed");
    const effect = effectsForRun(db, run.id)[0];
    expect(effect?.payload).toMatchObject({ event_id: "evt-review" });
    // The snapshot of what it looked like before exists only because the calendar was read
    // first. Nothing acts on it now; it is what the receipt shows when the user asks what
    // Zeus changed.
    expect(JSON.parse(effect?.prior_state_json ?? "null")).toMatchObject({
      external_id: "evt-review",
      title: "Design review",
      start: "2026-08-20T15:00:00Z",
      end: "2026-08-20T16:00:00Z",
    });
  }, 30_000);

  it("cancels by setting the event's status, not by inventing a delete", async () => {
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      {
        id: "evt-dinner",
        summary: "Dinner with Priya",
        start: "2026-08-20T19:00:00Z",
        end: "2026-08-20T21:00:00Z",
      },
    ]);
    await connectCalendar();

    const { run } = await realRun({
      request: {
        kind: "cancel",
        reference: { titleText: "dinner with Priya", startsAt: null, dateLocal: null },
        timezone: "UTC",
      },
    });

    expect(run.status).toBe("completed");
    expect(recordedCalls().at(-1)).toMatchObject({
      tool: "update_event",
      args: { event_id: "evt-dinner", status: "cancelled" },
    });
  }, 30_000);

  it("asks which one rather than guessing between two matches", async () => {
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      { id: "a", summary: "Design review", start: "2026-08-20T15:00:00Z", end: "2026-08-20T16:00:00Z" },
      { id: "b", summary: "Design review", start: "2026-08-21T15:00:00Z", end: "2026-08-21T16:00:00Z" },
    ]);
    await connectCalendar();

    const { run } = await realRun({
      request: {
        kind: "cancel",
        reference: { titleText: "design review", startsAt: null, dateLocal: null },
        timezone: "UTC",
      },
    });

    expect(run.error_code).toBe("calendar_target_ambiguous");
    expect(effectsForRun(db, run.id)).toHaveLength(0);
    expect(recordedCalls().filter((call) => call.tool === "update_event")).toEqual([]);
  }, 30_000);

  it("says what it did see instead of asserting the event is not there", async () => {
    // The reported failure: "there is no existing dinner event to reschedule", said about a
    // calendar that had been read correctly and did have a dinner on it. A lookup that
    // missed is not evidence of absence, so the refusal has to carry what was actually
    // there and let the reply ask.
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      { id: "evt-sushi", summary: "Sushi with Mark", start: "2026-08-20T18:00:00Z", end: "2026-08-20T20:00:00Z" },
    ]);
    await connectCalendar();

    const { run } = await realRun({
      request: {
        kind: "reschedule",
        reference: { titleText: "quarterly board meeting", startsAt: null, dateLocal: null },
        startsAt: "2026-08-20T19:30:00.000Z",
        endsAt: "2026-08-20T20:30:00.000Z",
        timezone: "UTC",
      },
    });

    expect(run.error_code).toBe("calendar_target_not_found");
    expect(effectsForRun(db, run.id)).toHaveLength(0);
    const artifact = listWorkArtifacts(db, { runId: run.id }).at(-1);
    const detail = JSON.parse(artifact!.content.slice(artifact!.content.indexOf("{"))) as {
      near_misses: { external_id: string }[];
      coverage: { eventCount: number } | null;
    };
    expect(detail.near_misses.map((entry) => entry.external_id)).toContain("evt-sushi");
    // And enough to tell "your calendar is empty" apart from "I could not match it".
    expect(detail.coverage?.eventCount).toBe(1);
  }, 30_000);

  it("will not resolve a target against a read that is too old, even to cancel", async () => {
    // A cancel never reaches the conflict check, which is the only thing that enforced the
    // staleness bound — so this was the one path that could resolve a target from a cache of
    // any age and then execute under the standing setting.
    await connectCalendar();
    const connector = listConnectors(db)[0];
    const staleAt = new Date(Date.now() - 40 * 60_000);
    cacheCalendarEvents(
      db,
      connector!.id,
      [{ id: "evt-dinner", summary: "Dinner with Priya", start: "2026-08-20T19:00:00Z", end: "2026-08-20T21:00:00Z" }],
      staleAt,
    );

    const { run } = await realRun({
      skipRead: true,
      request: {
        kind: "cancel",
        reference: { titleText: "dinner with Priya", startsAt: null, dateLocal: null },
        timezone: "UTC",
      },
    });

    // The cached rows have not expired, so the target *would* have resolved. What stops it
    // is the age of the read, which is the honest reason and the one the user can act on.
    expect(cachedEvents(db, new Date())).toHaveLength(1);
    expect(run.error_code).toBe("calendar_unverifiable");
    expect(recordedCalls().filter((call) => call.tool === "update_event")).toEqual([]);
    expect(effectsForRun(db, run.id)).toHaveLength(0);
  }, 30_000);

  it("refuses a plan whose own limits cannot cover its own steps", async () => {
    await connectCalendar();

    expect(() =>
      createWorkPlan(db, {
        proposal: {
          ...PROPOSAL,
          limits: { ...PROPOSAL.limits, max_model_tool_calls: 3 },
        },
        sourceMessageId: userMessageId,
        origin: "explicit_request",
      }),
    ).toThrow(/allows 3 model\/tool calls but its steps need at least/u);
  }, 30_000);

  it("pauses rather than acting when the grant is withdrawn before resume", async () => {
    // A calendar with something on it, but not at the requested time.
    process.env.FAKE_CALENDAR_EVENTS = JSON.stringify([
      { id: "evt-a", summary: "Flight lands", start: "2026-08-20T14:00:00Z", end: "2026-08-20T15:00:00Z" },
    ]);
    await connectCalendar();
    updateCalendarActionSetting(db, { directExecution: false }, userMessageId);
    const { planId, run } = await realRun();
    db.exec("UPDATE connector_capability SET enabled = 0");

    const resumed = await resumeWorkRun(db, run.id, { executor: createSafeWorkExecutor(db) });

    expect(resumed.status).toBe("paused");
    expect(recordedCalls().filter((call) => call.tool === "create_event")).toEqual([]);
    expect(listWorkArtifacts(db, { planId }).length).toBeGreaterThan(0);
  }, 30_000);
});

describe("an explicit calendar read", () => {
  it("calls the connected calendar and records the result as external data", async () => {
    await connectCalendar();
    const request = appendMessage(
      db,
      conversationId,
      "user",
      "Check my calendar and tell me what I have tomorrow.",
      { origin: "user_action", recallState: "blocked" },
    );
    const proposal = calendarActionWorkPlanProposal(
      { kind: "read", from: "2026-08-14T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z", timezone: "UTC" },
      request.content,
    );
    const detail = createWorkPlan(db, {
      proposal,
      sourceMessageId: request.id,
      origin: "explicit_request",
    });
    authorizeWorkPlan(db, detail.plan.id, {
      planHash: detail.plan.plan_hash,
      authorizationKind: "explicit_request",
      allowedEffects: proposal.allowed_effects,
      maxModelToolCalls: detail.plan.max_model_tool_calls,
      maxRetriesPerStep: detail.plan.max_retries_per_step,
      maxDurationSeconds: detail.plan.max_duration_seconds,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceMessageId: request.id,
    });

    const run = await runWorkPlan(db, detail.plan.id, {
      executor: createSafeWorkExecutor(db),
    });

    expect(run.status).toBe("completed");
    expect(recordedCalls()).toMatchObject([{ tool: "list_events" }]);
    expect(listToolReceipts(db, run.id)).toMatchObject([
      { tool_name: "connector_call", effect_kind: "external_read", status: "completed" },
    ]);
    expect(listWorkArtifacts(db, { runId: run.id })[0]?.content).toContain(
      "External calendar data — untrusted, not accepted memory.",
    );
    expect(listWorkArtifacts(db, { runId: run.id })[0]?.content).toContain("Flight lands");
  }, 30_000);

  it("tries once more when the service did not answer the first time", async () => {
    // The step's own answer used to be a pause, and the runner only retries what was
    // thrown — so a single timed-out handshake was reported to the user as a calendar that
    // could not be read, on a connection that was working a second later.
    process.env.FAKE_CALENDAR_FAIL_ONCE = join(directory, "failed-once");
    await connectCalendar();

    const run = await readCalendar();

    expect(run.status).toBe("completed");
    expect(run.error_code).toBeNull();
    expect(listWorkArtifacts(db, { runId: run.id })[0]?.content).toContain("Flight lands");
  }, 30_000);

  it("stops after the retry rather than trying forever", async () => {
    await connectCalendar();
    // Broken for good, not for a moment.
    writeFileSync(join(directory, "calendar-server.mjs"), "process.exit(1);", { mode: 0o600 });

    const run = await readCalendar();

    expect(run.status).toBe("paused");
    expect(run.error_code).toBe("calendar_unverifiable");
    // The artifact still explains the stop, so the turn reports an honest "I could not
    // check" rather than a retry loop or a bare failure.
    expect(listWorkArtifacts(db, { runId: run.id })[0]?.content).toContain(
      "did not change anything",
    );
  }, 30_000);

  /** The plan Zeus builds for "what's on my calendar?", run against the fake service. */
  async function readCalendar() {
    const request = appendMessage(
      db,
      conversationId,
      "user",
      "Check my calendar and tell me what I have tomorrow.",
      { origin: "user_action", recallState: "blocked" },
    );
    const proposal = calendarActionWorkPlanProposal(
      { kind: "read", from: "2026-08-14T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z", timezone: "UTC" },
      request.content,
    );
    const detail = createWorkPlan(db, {
      proposal,
      sourceMessageId: request.id,
      origin: "explicit_request",
    });
    authorizeWorkPlan(db, detail.plan.id, {
      planHash: detail.plan.plan_hash,
      authorizationKind: "explicit_request",
      allowedEffects: proposal.allowed_effects,
      maxModelToolCalls: detail.plan.max_model_tool_calls,
      maxRetriesPerStep: detail.plan.max_retries_per_step,
      maxDurationSeconds: detail.plan.max_duration_seconds,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceMessageId: request.id,
    });
    return runWorkPlan(db, detail.plan.id, { executor: createSafeWorkExecutor(db) });
  }
});

describe("a request the user is asked to confirm must be able to succeed", () => {
  const schema = JSON.stringify({
    type: "object",
    properties: { title: { type: "string" }, start: { type: "string" } },
    required: ["title", "start"],
  });

  it("catches a missing required field", () => {
    expect(payloadSchemaMismatch(schema, { title: "Dinner" })).toMatch(/missing start/u);
  });

  it("catches a field the reviewed contract never mentioned", () => {
    expect(
      payloadSchemaMismatch(schema, { title: "Dinner", start: "2026-08-20T18:30:00Z", guests: 4 }),
    ).toMatch(/adds guests/u);
  });

  it("accepts a payload that matches, and stays quiet on an unusable schema", () => {
    expect(
      payloadSchemaMismatch(schema, { title: "Dinner", start: "2026-08-20T18:30:00Z" }),
    ).toBeNull();
    expect(payloadSchemaMismatch("not json", { anything: true })).toBeNull();
    expect(payloadSchemaMismatch("{}", { anything: true })).toBeNull();
  });
});

describe("the read cache reflects the calendar, not the union of every read", () => {
  it("drops an event that the calendar stopped returning", () => {
    const at = new Date("2026-08-15T09:00:00.000Z");
    const window = { from: "2026-08-15T09:00:00.000Z", to: "2026-09-14T09:00:00.000Z" };
    db.exec(`INSERT INTO connector (id,label,transport,command,args_json,cwd,env_var_names_json,status,enabled,source_message_id,created_at,updated_at)
      VALUES (9,'C','stdio','node','[]','/tmp','[]','ready',1,${userMessageId},'2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z')`);

    cacheCalendarEvents(db, 9, {
      events: [
        { id: "a", summary: "Standup", start: "2026-08-16T09:00:00Z", end: "2026-08-16T09:15:00Z" },
        { id: "b", summary: "Review", start: "2026-08-16T15:00:00Z", end: "2026-08-16T16:00:00Z" },
      ],
    }, at, window);
    expect(cachedEvents(db, at).map((event) => event.external_id).sort()).toEqual(["a", "b"]);

    // The standup was cancelled in the calendar itself. The next read is the only evidence
    // Zeus will ever get; a cache that only merges would keep resolving "cancel my
    // standup" against a meeting that no longer exists.
    cacheCalendarEvents(db, 9, {
      events: [
        { id: "b", summary: "Review", start: "2026-08-16T15:00:00Z", end: "2026-08-16T16:00:00Z" },
      ],
    }, at, window);
    expect(cachedEvents(db, at).map((event) => event.external_id)).toEqual(["b"]);
  });

  it("leaves events outside the window that was read alone", () => {
    const at = new Date("2026-08-15T09:00:00.000Z");
    db.exec(`INSERT INTO connector (id,label,transport,command,args_json,cwd,env_var_names_json,status,enabled,source_message_id,created_at,updated_at)
      VALUES (9,'C','stdio','node','[]','/tmp','[]','ready',1,${userMessageId},'2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z')`);
    cacheCalendarEvents(db, 9, {
      events: [{ id: "far", summary: "Later", start: "2026-09-30T10:00:00Z", end: "2026-09-30T11:00:00Z" }],
    }, at, { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });

    // A read of next week says nothing about a meeting six weeks out.
    cacheCalendarEvents(db, 9, { events: [] }, at, {
      from: "2026-08-15T09:00:00.000Z",
      to: "2026-08-22T09:00:00.000Z",
    });

    expect(cachedEvents(db, at, { includeEnded: true }).map((e) => e.external_id)).toEqual(["far"]);
  });
});

describe("external data stays outside memory", () => {
  it("reads the shapes a calendar server plausibly returns and keeps only fields Zeus uses", () => {
    const events = parseCalendarEvents({
      events: [
        { id: "evt-a", summary: "Flight", start: { dateTime: "2026-08-20T18:40:00Z" } },
        { event_id: "evt-b", title: "Dinner", starts_at: "2026-08-20T18:30:00Z", where: "Lisbon" },
      ],
    });

    expect(events).toEqual([
      {
        id: "evt-a",
        title: "Flight",
        starts_at: "2026-08-20T18:40:00Z",
        ends_at: null,
        location: null,
      },
      {
        id: "evt-b",
        title: "Dinner",
        starts_at: "2026-08-20T18:30:00Z",
        ends_at: null,
        location: "Lisbon",
      },
    ]);
    expect(() => parseCalendarEvents({ events: [{ summary: "no id" }] })).toThrow(
      /without an id/u,
    );
  });

  it("never lets a cached external signal become evidence", async () => {
    await connectCalendar();
    db.exec(`
      INSERT INTO external_signal
        (connector_id, kind, external_id, starts_at, ends_at, location, payload_json,
         fetched_at, expires_at)
      VALUES (1, 'calendar_event', 'evt-a', '2026-08-20T18:40:00Z', '2026-08-20T19:10:00Z',
              NULL, '{"id":"evt-a"}', '2026-08-14T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    `);

    // There is no column, foreign key, or table anywhere in the evidence chain that can
    // reference an external signal. This is the structural version of the invariant.
    const referencingTables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND sql LIKE '%REFERENCES external_signal%'`,
      )
      .pluck()
      .all();
    expect(referencingTables).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) FROM fact_evidence").pluck().get(),
    ).toBe(0);
  }, 30_000);
});

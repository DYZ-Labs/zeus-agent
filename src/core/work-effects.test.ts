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
  setCapabilityEnabled,
  setConnectorEnabled,
} from "./connectors";
import { calendarReadWorkPlanProposal } from "./chat";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import {
  confirmEffect,
  effectsForRun,
  executeConfirmedEffect,
  proposeEffect,
} from "./effects";
import { verifyConnector } from "./mcp-client";
import { parseCalendarEvents } from "./calendar-sync";
import type { WorkPlanProposal } from "./schema";
import { createSafeWorkExecutor, payloadSchemaMismatch } from "./work-execution";
import {
  authorizeWorkPlan,
  createWorkPlan,
  listToolReceipts,
  listWorkArtifacts,
  resumeWorkRun,
  runWorkPlan,
  type SafeWorkExecutor,
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
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_CALENDAR_CALL_LOG;
const server = new McpServer({ name: "fake-calendar", version: "0.0.1" });

server.registerTool(
  "list_events",
  { title: "List events", inputSchema: { from: z.string(), to: z.string() },
    annotations: { readOnlyHint: true } },
  async (args) => {
    if (log) appendFileSync(log, JSON.stringify({ tool: "list_events", args }) + "\\n");
    return { content: [{ type: "text", text: JSON.stringify({ events: [
      { id: "evt-a", summary: "Flight lands", start: "2026-08-20T18:40:00Z", end: "2026-08-20T19:10:00Z" },
    ] }) }] };
  },
);

server.registerTool(
  "create_event",
  { title: "Create event", inputSchema: { title: z.string(), starts_at: z.string() } },
  async (args) => {
    if (log) appendFileSync(log, JSON.stringify({ tool: "create_event", args }) + "\\n");
    return { content: [{ type: "text", text: JSON.stringify({ id: "evt-new", ...args }) }] };
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
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.FAKE_CALENDAR_CALL_LOG;
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
    envVarNames: ["FAKE_CALENDAR_CALL_LOG"],
    sourceMessageId: userMessageId,
  });
  const { tools } = await verifyConnector(db, connector.id);
  for (const [slot, tool] of [
    ["calendar.list_events", "list_events"],
    ["calendar.create_event", "create_event"],
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

const PROPOSAL: WorkPlanProposal = {
  objective: "Hold the dinner slot after the flight lands",
  steps: [
    {
      title: "Draft the request",
      instruction: "Draft the exact calendar request.",
      effect_kind: "prepare_local",
      depends_on: [],
    },
    {
      title: "Hold the slot",
      instruction: "Create the calendar event.",
      effect_kind: "schedule",
      depends_on: [1],
    },
  ],
  allowed_effects: ["prepare_local", "schedule"],
  completion_criteria: ["The dinner slot is held"],
  limits: { max_model_tool_calls: 20, max_retries_per_step: 2, max_duration_seconds: 900 },
};

/**
 * Stands in for the model half of the executor. The write step still goes through the
 * real `prepareExternalRequest` path in production; here it produces the same proposal
 * deterministically so the test exercises the gate rather than the model.
 */
function scriptedExecutor(): SafeWorkExecutor {
  return async (input) => {
    if (input.step.effect_kind === "prepare_local") {
      return {
        artifacts: [
          {
            kind: "draft",
            title: input.step.title,
            content: "Dinner with Sam at 19:30 on 20 August.",
            citations: [],
          },
        ],
        modelCalls: 1,
        toolCalls: 1,
      };
    }
    const effect = proposeEffect(db, {
      workRunId: input.run.id,
      workStepId: input.step.id,
      slot: "calendar.create_event",
      payload: { title: "Dinner with Sam", starts_at: "2026-08-20T19:30:00Z" },
      previewText: "Create “Dinner with Sam” on 20 August at 19:30.",
      providerRequestKey: input.providerRequestKey,
    });
    return {
      artifacts: [
        {
          kind: "draft",
          title: input.step.title,
          content: `Waiting for confirmation. Hash: ${effect.payload_hash}`,
          citations: [],
        },
      ],
      modelCalls: 1,
      toolCalls: 0,
      pause: {
        code: "effect_confirmation_required",
        message: "Waiting for confirmation",
        requiresReauthorization: false,
      },
    };
  };
}

async function authorizedRun() {
  const detail = createWorkPlan(db, {
    proposal: PROPOSAL,
    sourceMessageId: userMessageId,
    origin: "explicit_request",
  });
  authorizeWorkPlan(db, detail.plan.id, {
    planHash: detail.plan.plan_hash,
    authorizationKind: "explicit_request",
    allowedEffects: PROPOSAL.allowed_effects,
    maxModelToolCalls: detail.plan.max_model_tool_calls,
    maxRetriesPerStep: detail.plan.max_retries_per_step,
    maxDurationSeconds: detail.plan.max_duration_seconds,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    sourceMessageId: userMessageId,
  });
  const run = await runWorkPlan(db, detail.plan.id, { executor: scriptedExecutor() });
  return { planId: detail.plan.id, run };
}

describe("a run that would act stops and waits", () => {
  it("pauses at the write step with the exact request recorded and nothing sent", async () => {
    await connectCalendar();

    const { run } = await authorizedRun();

    expect(run.status).toBe("paused");
    expect(run.error_code).toBe("effect_confirmation_required");
    const pending = effectsForRun(db, run.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending_confirmation");
    expect(pending[0]?.payload).toEqual({
      title: "Dinner with Sam",
      starts_at: "2026-08-20T19:30:00Z",
    });
    // Verification listed tools; no tool was ever called.
    expect(recordedCalls()).toEqual([]);
    // The receipt log distinguishes preparing from sending.
    const receipts = listToolReceipts(db, run.id);
    expect(receipts.map((receipt) => receipt.tool_name)).toEqual([
      "local_artifact",
      "effect_proposal",
    ]);
    expect(receipts.some((receipt) => receipt.tool_name === "connector_call")).toBe(false);
  }, 30_000);

  it("sends only after the user confirms the exact hash, then records a connector call", async () => {
    await connectCalendar();
    const { run } = await authorizedRun();
    const effect = effectsForRun(db, run.id)[0];
    if (!effect) throw new Error("no proposed effect");

    const confirmation = appendMessage(
      db,
      conversationId,
      "user",
      `Confirm ${effect.payload_hash}`,
      { origin: "user_action", recallState: "blocked" },
    ).id;
    confirmEffect(db, effect.id, effect.payload_hash, confirmation);
    const result = await executeConfirmedEffect(db, effect.id);

    expect(result.status).toBe("executed");
    expect(recordedCalls()).toEqual([
      {
        tool: "create_event",
        args: { title: "Dinner with Sam", starts_at: "2026-08-20T19:30:00Z" },
      },
    ]);
    const receipts = listToolReceipts(db, run.id);
    const call = receipts.find((receipt) => receipt.tool_name === "connector_call");
    expect(call?.status).toBe("completed");
    expect(call?.proposed_effect_id).toBe(effect.id);
  }, 30_000);

  it("finishes the step on resume instead of proposing the same request again", async () => {
    await connectCalendar();
    const { run } = await authorizedRun();
    const effect = effectsForRun(db, run.id)[0];
    if (!effect) throw new Error("no proposed effect");
    const confirmation = appendMessage(
      db,
      conversationId,
      "user",
      `I confirm external request ${effect.payload_hash}.`,
      { origin: "user_action", recallState: "blocked" },
    ).id;
    confirmEffect(db, effect.id, effect.payload_hash, confirmation);
    await executeConfirmedEffect(db, effect.id);

    // The real executor, deliberately: an already-settled step short-circuits before any
    // model call, so this exercises the production path without one.
    const resumed = await resumeWorkRun(db, run.id, {
      executor: createSafeWorkExecutor(db),
    });

    expect(resumed.status).toBe("completed");
    expect(recordedCalls().filter((call) => call.tool === "create_event")).toHaveLength(1);
    expect(effectsForRun(db, run.id)).toHaveLength(1);
  }, 30_000);

  it("refuses a plan whose own limits cannot cover its own steps", async () => {
    await connectCalendar();

    // Three non-trivial steps need six calls; the plan allows three. Left unchecked this
    // fails on the last step — the one that would have asked the user to confirm.
    expect(() =>
      createWorkPlan(db, {
        proposal: {
          ...PROPOSAL,
          limits: { ...PROPOSAL.limits, max_model_tool_calls: 3 },
        },
        sourceMessageId: userMessageId,
        origin: "explicit_request",
      }),
    ).toThrow(/allows 3 model\/tool calls but its steps need at least 4/u);
  }, 30_000);

  it("pauses again rather than acting when the grant is withdrawn before resume", async () => {
    await connectCalendar();
    const { planId, run } = await authorizedRun();
    db.exec("UPDATE connector_capability SET enabled = 0");

    const resumed = await resumeWorkRun(db, run.id, { executor: scriptedExecutor() });

    expect(resumed.status).toBe("paused");
    expect(resumed.error_code).toBe("capability_unavailable");
    expect(recordedCalls()).toEqual([]);
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
    const proposal = calendarReadWorkPlanProposal(request.content);
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

describe("external data stays outside memory", () => {
  it("reads the shapes a calendar server plausibly returns and keeps only fields Zeus uses", () => {
    const events = parseCalendarEvents({
      events: [
        { id: "evt-a", summary: "Flight", start: { dateTime: "2026-08-20T18:40:00Z" } },
        { event_id: "evt-b", title: "Dinner", starts_at: "2026-08-20T18:30:00Z", where: "Lisbon" },
        { summary: "no id, dropped" },
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

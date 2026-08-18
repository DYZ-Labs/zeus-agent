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
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import {
  directExecutionAllowance,
  getCalendarActionSetting,
  updateCalendarActionSetting,
} from "./calendar-policy";
import {
  authorizeEffectByPolicy,
  confirmEffect,
  declineEffect,
  effectsForRun,
  executeConfirmedEffect,
  expireStaleEffects,
  listPendingEffects,
  payloadHash,
  proposeEffect,
  revertEffect,
} from "./effects";
import { verifyConnector } from "./mcp-client";

/**
 * The invariant under test is one sentence: nothing reaches a connected service without a
 * user message naming the exact payload hash. Everything else here exists to prove that
 * the machinery cannot be talked around — not by an assistant sentence, not by a stale
 * approval, not by editing the payload afterwards, not by silence.
 */

let db: Db;
let userMessageId: number;
let conversationId: number;
let directory: string;
/** The fake server appends every call it receives here, so tests can assert on the wire. */
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
  "create_event",
  { title: "Create event", inputSchema: { title: z.string(), starts_at: z.string() } },
  async (args) => {
    if (log) appendFileSync(log, JSON.stringify(args) + "\\n");
    return { content: [{ type: "text", text: JSON.stringify({ id: "evt-1", ...args }) }] };
  },
);

server.registerTool(
  "update_event",
  {
    title: "Update event",
    inputSchema: {
      event_id: z.string(),
      status: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      title: z.string().optional(),
      location: z.string().optional(),
    },
  },
  async (args) => {
    if (log) appendFileSync(log, JSON.stringify(args) + "\\n");
    return { content: [{ type: "text", text: JSON.stringify({ updated: args.event_id }) }] };
  },
);

await server.connect(new StdioServerTransport());
`;

beforeEach(() => {
  db = openTestDb();
  const conversation = createConversation(db, { title: "Work requests", source: "web" });
  conversationId = conversation.id;
  userMessageId = appendMessage(db, conversationId, "user", "connect my calendar", {
    origin: "user_action",
    recallState: "blocked",
  }).id;
  directory = mkdtempSync(join(tmpdir(), "zeus-effects-test-"));
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

/** A work run and step for effects to hang off, without exercising the whole engine. */
function workRun(): { runId: number; stepId: number } {
  const hash = "f".repeat(64);
  db.exec(`
    INSERT INTO work_plan
      (id, objective, status, plan_hash, allowed_effects_json, completion_criteria_json,
       max_steps, max_model_tool_calls, max_retries_per_step, max_duration_seconds,
       source_message_id, origin, created_at, updated_at)
    VALUES (1, 'hold dinner', 'running', '${hash}', '["schedule"]', '["held"]', 12, 20, 2,
            900, ${userMessageId}, 'explicit_request', '2026-08-14T00:00:00.000Z',
            '2026-08-14T00:00:00.000Z');
    INSERT INTO work_step (id, work_plan_id, position, title, instruction, effect_kind, status)
    VALUES (1, 1, 1, 'hold', 'hold the slot', 'schedule', 'running');
    INSERT INTO work_authorization
      (id, work_plan_id, plan_hash, authorization_kind, allowed_effects_json,
       max_model_tool_calls, max_retries_per_step, max_duration_seconds, expires_at,
       source_message_id, created_at)
    VALUES (1, 1, '${hash}', 'explicit_request', '["schedule"]', 20, 2, 900,
            '2099-01-01T00:00:00.000Z', ${userMessageId}, '2026-08-14T00:00:00.000Z');
    INSERT INTO work_run
      (id, work_plan_id, authorization_id, plan_hash, status, model_call_count,
       tool_call_count, started_at, updated_at, deadline_at)
    VALUES (1, 1, 1, '${hash}', 'running', 0, 0, '2026-08-14T00:00:00.000Z',
            '2026-08-14T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  `);
  return { runId: 1, stepId: 1 };
}

async function grantCalendar(): Promise<void> {
  const scriptPath = join(directory, "calendar-server.mjs");
  writeFileSync(scriptPath, CALENDAR_SERVER, { mode: 0o600 });
  const connector = createConnector(db, {
    label: "Fake calendar",
    transport: "stdio",
    command: process.execPath,
    args: [scriptPath],
    cwd: process.cwd(),
    envVarNames: ["FAKE_CALENDAR_CALL_LOG"],
    sourceMessageId: userMessageId,
  });
  const { tools } = await verifyConnector(db, connector.id);
  for (const [slot, tool] of [
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

function propose() {
  const { runId, stepId } = workRun();
  return proposeEffect(db, {
    workRunId: runId,
    workStepId: stepId,
    slot: "calendar.create_event",
    payload: { title: "Dinner with Sam", starts_at: "2026-08-20T18:30:00Z" },
    previewText: "Create “Dinner with Sam” on 20 August at 18:30.",
    providerRequestKey: "req-1",
    conflictCheck: {
      status: "clear",
      checked_at: "2026-08-20T18:00:00.000Z",
      coverage: {
        from: "2026-08-20T00:00:00.000Z",
        to: "2026-08-21T00:00:00.000Z",
        fetchedAt: "2026-08-20T18:00:00.000Z",
        eventCount: 0,
      },
      considered_events: 0,
      conflicts: [],
    },
  });
}

function confirmationMessage(hash: string, text = `Confirm ${hash}`): number {
  return appendMessage(db, conversationId, "user", text, {
    origin: "user_action",
    recallState: "blocked",
  }).id;
}

/** Guards the rule that Zeus never writes a message the user did not send. */
function messageCount(): number {
  return db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM message").get()?.count ?? 0;
}

describe("proposing an effect never performs it", () => {
  it("records the exact payload and leaves the world untouched", async () => {
    await grantCalendar();

    const effect = propose();

    expect(effect.status).toBe("pending_confirmation");
    expect(effect.payload).toEqual({
      title: "Dinner with Sam",
      starts_at: "2026-08-20T18:30:00Z",
    });
    expect(effect.payload_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(effect.events.map((event) => event.event_type)).toEqual(["proposed"]);
    expect(listPendingEffects(db)).toHaveLength(1);
    // The whole point: proposing reached no connected service at all.
    expect(recordedCalls()).toEqual([]);
  }, 30_000);

  it("does not ask twice for the same payload on a resumed run", async () => {
    await grantCalendar();
    const first = propose();
    const second = proposeEffect(db, {
      workRunId: 1,
      workStepId: 1,
      slot: "calendar.create_event",
      payload: { starts_at: "2026-08-20T18:30:00Z", title: "Dinner with Sam" },
      previewText: "Create “Dinner with Sam” on 20 August at 18:30.",
      providerRequestKey: "req-1",
    });

    expect(second.id).toBe(first.id);
    expect(effectsForRun(db, 1)).toHaveLength(1);
  }, 30_000);

  it("refuses to propose without an available capability", async () => {
    workRun();
    expect(() =>
      proposeEffect(db, {
        workRunId: 1,
        workStepId: 1,
        slot: "calendar.create_event",
        payload: { title: "Dinner" },
        previewText: "Create Dinner.",
        providerRequestKey: "req-1",
      }),
    ).toThrow(/No connected service currently provides/u);
  });
});

describe("confirmation must be the user naming the exact request", () => {
  it("refuses a confirmation that omits the hash", async () => {
    await grantCalendar();
    const effect = propose();
    const vague = confirmationMessage(effect.payload_hash, "yes go ahead");

    expect(() => confirmEffect(db, effect.id, effect.payload_hash, vague)).toThrow(
      /exact request hash/u,
    );
  }, 30_000);

  it("refuses a hash that belongs to a different request", async () => {
    await grantCalendar();
    const effect = propose();
    const other = "a".repeat(64);

    expect(() => confirmEffect(db, effect.id, other, confirmationMessage(other))).toThrow(
      /does not match this exact external request/u,
    );
  }, 30_000);

  it("never accepts an assistant message as confirmation", async () => {
    await grantCalendar();
    const effect = propose();
    const assistant = appendMessage(
      db,
      conversationId,
      "assistant",
      `Confirm ${effect.payload_hash}`,
    ).id;

    expect(() => confirmEffect(db, effect.id, effect.payload_hash, assistant)).toThrow(
      /stored user message/u,
    );
  }, 30_000);

  it("reads a refusal as a refusal even when the hash is present", async () => {
    await grantCalendar();
    const effect = propose();
    const refusal = confirmationMessage(
      effect.payload_hash,
      `Do not confirm ${effect.payload_hash}`,
    );

    expect(() => confirmEffect(db, effect.id, effect.payload_hash, refusal)).toThrow(
      /explicitly confirm/u,
    );
  }, 30_000);

  it("can confirm a request whose own description says “cancel”", async () => {
    await grantCalendar();
    const { runId, stepId } = workRun();
    const effect = proposeEffect(db, {
      workRunId: runId,
      workStepId: stepId,
      slot: "calendar.create_event",
      payload: { title: "Cancelled: team sync", starts_at: "2026-08-20T09:00:00Z" },
      previewText: "Cancel the team sync and stop the recurring invite.",
      providerRequestKey: "req-cancel",
    });

    // The decision lives on the first line; the description is context and cannot veto it.
    const confirmation = appendMessage(
      db,
      conversationId,
      "user",
      `I confirm external request ${effect.payload_hash}.\n${effect.preview_text}`,
      { origin: "user_action", recallState: "blocked" },
    ).id;

    expect(
      confirmEffect(db, effect.id, effect.payload_hash, confirmation).status,
    ).toBe("confirmed");
  }, 30_000);

  it("still reads a refusal on the deciding line as a refusal", async () => {
    await grantCalendar();
    const effect = propose();
    const refusal = appendMessage(
      db,
      conversationId,
      "user",
      `Do not confirm external request ${effect.payload_hash}.\n${effect.preview_text}`,
      { origin: "user_action", recallState: "blocked" },
    ).id;

    expect(() => confirmEffect(db, effect.id, effect.payload_hash, refusal)).toThrow(
      /explicitly confirm/u,
    );
  }, 30_000);

  it("accepts an exact confirmation once and refuses to decide twice", async () => {
    await grantCalendar();
    const effect = propose();

    const confirmed = confirmEffect(
      db,
      effect.id,
      effect.payload_hash,
      confirmationMessage(effect.payload_hash),
    );

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.events.map((event) => event.event_type)).toEqual([
      "proposed",
      "confirmed",
    ]);
    expect(() =>
      declineEffect(db, effect.id, confirmationMessage(effect.payload_hash, "stop")),
    ).toThrow(/already been decided/u);
  }, 30_000);
});

describe("executing sends the confirmed bytes and nothing else", () => {
  it("calls the remote tool with exactly the confirmed payload", async () => {
    await grantCalendar();
    const effect = propose();
    confirmEffect(db, effect.id, effect.payload_hash, confirmationMessage(effect.payload_hash));

    const result = await executeConfirmedEffect(db, effect.id);

    expect(result.status).toBe("executed");
    expect(recordedCalls()).toEqual([
      { title: "Dinner with Sam", starts_at: "2026-08-20T18:30:00Z" },
    ]);
  }, 30_000);

  it("refuses to execute anything that was not confirmed", async () => {
    await grantCalendar();
    const effect = propose();

    await expect(executeConfirmedEffect(db, effect.id)).rejects.toThrow(
      /Only a confirmed external request/u,
    );
  }, 30_000);

  it("fails closed when the payload is edited after confirmation", async () => {
    await grantCalendar();
    const effect = propose();
    confirmEffect(db, effect.id, effect.payload_hash, confirmationMessage(effect.payload_hash));

    // Simulate any path that could rewrite stored state between approval and dispatch.
    db.prepare("UPDATE proposed_effect SET payload_json = ? WHERE id = ?").run(
      JSON.stringify({ title: "Dinner with someone else", starts_at: "2026-08-20T18:30:00Z" }),
      effect.id,
    );

    const result = await executeConfirmedEffect(db, effect.id);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("payload_changed_since_confirmation");
  }, 30_000);

  it("fails closed when the grant was withdrawn after confirmation", async () => {
    await grantCalendar();
    const effect = propose();
    confirmEffect(db, effect.id, effect.payload_hash, confirmationMessage(effect.payload_hash));
    db.exec("UPDATE connector_capability SET enabled = 0");

    const result = await executeConfirmedEffect(db, effect.id);

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("capability_unavailable");
  }, 30_000);

  it("records how to undo a created event, and undoes it on request", async () => {
    await grantCalendar();
    const effect = propose();
    confirmEffect(db, effect.id, effect.payload_hash, confirmationMessage(effect.payload_hash));
    await executeConfirmedEffect(db, effect.id);

    const reverted = await revertEffect(
      db,
      effect.id,
      confirmationMessage(effect.payload_hash, "undo it"),
    );

    expect(reverted.status).toBe("reverted");
    expect(recordedCalls()[1]).toEqual({ event_id: "evt-1", status: "cancelled" });
  }, 30_000);
});

describe("silence is not consent", () => {
  it("expires an unanswered request instead of acting on it", async () => {
    await grantCalendar();
    const { runId, stepId } = workRun();
    const effect = proposeEffect(db, {
      workRunId: runId,
      workStepId: stepId,
      slot: "calendar.create_event",
      payload: { title: "Dinner", starts_at: "2026-08-20T18:30:00Z" },
      previewText: "Create Dinner.",
      providerRequestKey: "req-1",
      expiresAt: "2026-08-14T00:00:01.000Z",
    });

    expect(expireStaleEffects(db, { at: new Date("2026-08-15T00:00:00.000Z") })).toBe(1);

    const expired = effectsForRun(db, 1)[0];
    expect(expired?.status).toBe("expired");
    expect(listPendingEffects(db)).toEqual([]);
    expect(() =>
      confirmEffect(db, effect.id, effect.payload_hash, confirmationMessage(effect.payload_hash)),
    ).toThrow(/expired/u);
  }, 30_000);
});

describe("acting on a standing setting, without pretending it was confirmed", () => {
  it("cites the user's real request and never fabricates a confirmation", async () => {
    await grantCalendar();
    const effect = propose();
    const before = messageCount();

    const authorized = authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
      requestMessageId: userMessageId,
      policy: "calendar_direct_execution",
      detail: { conflict_check: "clear" },
    });

    expect(authorized.status).toBe("confirmed");
    expect(authorized.confirmation_kind).toBe("standing_policy");
    expect(authorized.request_message_id).toBe(userMessageId);
    const types = authorized.events.map((event) => event.event_type);
    expect(types).toEqual(["proposed", "authorized_by_policy"]);
    // The ledger must never record a confirmation the user did not type.
    expect(types).not.toContain("confirmed");
    // And Zeus must not have written a message on their behalf to get there.
    expect(messageCount()).toBe(before);
  }, 30_000);

  it("executes exactly the authorized bytes and records the call", async () => {
    await grantCalendar();
    const effect = propose();
    authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
      requestMessageId: userMessageId,
      policy: "calendar_direct_execution",
    });

    const result = await executeConfirmedEffect(db, effect.id);

    expect(result.status).toBe("executed");
    expect(recordedCalls()).toEqual([
      { title: "Dinner with Sam", starts_at: "2026-08-20T18:30:00Z" },
    ]);
  }, 30_000);

  it("refuses to cite an assistant message", async () => {
    await grantCalendar();
    const effect = propose();
    const assistantId = appendMessage(db, conversationId, "assistant", "I'll add that.").id;

    expect(() =>
      authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
        requestMessageId: assistantId,
        policy: "calendar_direct_execution",
      }),
    ).toThrow(/must cite the user's own request/u);
  }, 30_000);

  it("refuses a hash that does not match the stored payload", async () => {
    await grantCalendar();
    const effect = propose();

    expect(() =>
      authorizeEffectByPolicy(db, effect.id, "0".repeat(64), {
        requestMessageId: userMessageId,
        policy: "calendar_direct_execution",
      }),
    ).toThrow(/does not match this exact external request/u);
  }, 30_000);

  it("cannot authorize a conflicting request even when the caller claims it was clear", async () => {
    await grantCalendar();
    const { runId, stepId } = workRun();
    const effect = proposeEffect(db, {
      workRunId: runId,
      workStepId: stepId,
      slot: "calendar.create_event",
      payload: { title: "Dinner", starts_at: "2026-08-20T18:30:00Z" },
      previewText: "Create Dinner.",
      providerRequestKey: "req-conflict",
      conflictCheck: {
        status: "conflict",
        checked_at: "2026-08-20T18:00:00.000Z",
        coverage: {
          from: "2026-08-20T00:00:00.000Z",
          to: "2026-08-21T00:00:00.000Z",
          fetchedAt: "2026-08-20T18:00:00.000Z",
          eventCount: 1,
        },
        considered_events: 1,
        conflicts: [{ external_id: "busy", starts_at: "2026-08-20T18:00:00Z" }],
      },
    });

    expect(() =>
      authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
        requestMessageId: userMessageId,
        policy: "calendar_direct_execution",
        detail: { conflict_check: "clear" },
      }),
    ).toThrow(/stored clear calendar conflict check/u);
    expect(effect.status).toBe("pending_confirmation");
    expect(recordedCalls()).toEqual([]);
  }, 30_000);

  it("authorizes an external request once, one way", async () => {
    await grantCalendar();
    const effect = propose();
    authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
      requestMessageId: userMessageId,
      policy: "calendar_direct_execution",
    });

    expect(() =>
      confirmEffect(db, effect.id, effect.payload_hash, confirmationMessage(effect.payload_hash)),
    ).toThrow(/already been decided|already authorized by your standing setting/u);

    // And the database refuses the pair independently of the write path.
    expect(() =>
      db.exec(
        `INSERT INTO effect_event (proposed_effect_id, event_type, source_message_id, created_at)
         VALUES (${effect.id}, 'confirmed', ${userMessageId}, '2026-08-20T00:00:00.000Z')`,
      ),
    ).toThrow(/authorized once, one way/u);
  }, 30_000);

  it("lets the user undo a reschedule, because the calendar was read first", async () => {
    await grantCalendar();
    const { runId, stepId } = workRun();
    const effect = proposeEffect(db, {
      workRunId: runId,
      workStepId: stepId,
      slot: "calendar.update_event",
      payload: {
        event_id: "evt-1",
        start: "2026-08-20T16:00:00Z",
        end: "2026-08-20T17:00:00Z",
      },
      previewText: "Move “Design review” to 16:00.",
      providerRequestKey: "req-move",
      priorState: {
        external_id: "evt-1",
        title: "Design review",
        start: "2026-08-20T15:00:00Z",
        end: "2026-08-20T16:00:00Z",
      },
      conflictCheck: {
        status: "clear",
        coverage: {},
        considered_events: 1,
        conflicts: [],
      },
    });
    authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
      requestMessageId: userMessageId,
      policy: "calendar_direct_execution",
    });

    await executeConfirmedEffect(db, effect.id);

    // Undo restores the times Zeus itself changed, and only those.
    expect(effectsForRun(db, runId)[0]?.reversal).toEqual({
      slot: "calendar.update_event",
      payload: {
        event_id: "evt-1",
        start: "2026-08-20T15:00:00Z",
        end: "2026-08-20T16:00:00Z",
      },
    });
  }, 30_000);

  it("offers no undo for an update it has no snapshot for", async () => {
    await grantCalendar();
    const { runId, stepId } = workRun();
    const effect = proposeEffect(db, {
      workRunId: runId,
      workStepId: stepId,
      slot: "calendar.update_event",
      payload: { event_id: "evt-2", start: "2026-08-20T16:00:00Z" },
      previewText: "Move an event.",
      providerRequestKey: "req-blind",
      conflictCheck: {
        status: "clear",
        coverage: {},
        considered_events: 1,
        conflicts: [],
      },
    });
    authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
      requestMessageId: userMessageId,
      policy: "calendar_direct_execution",
    });

    await executeConfirmedEffect(db, effect.id);

    expect(effectsForRun(db, runId)[0]?.reversal).toBeNull();
  }, 30_000);
});

describe("the standing setting is a user decision", () => {
  it("starts on, so a connected calendar acts rather than asks", () => {
    expect(getCalendarActionSetting(db).direct_execution).toBe(1);
    expect(directExecutionAllowance(db, { detailsFrom: "user_message" })).toMatchObject({
      allowed: true,
      reason: null,
    });
  });

  it("still asks when the times came from Zeus's own suggestion", () => {
    // The conflict gate can only vouch for the destination. A change assembled from
    // something Zeus proposed — "ok do it" — has had no check that it is the change the user
    // meant, and an hour nobody asked for is free precisely because nobody asked for it.
    expect(getCalendarActionSetting(db).direct_execution).toBe(1);
    expect(directExecutionAllowance(db, { detailsFrom: "earlier_proposal" })).toMatchObject({
      allowed: false,
      reason: "inferred_details",
    });
  });

  it("treats a request that never said where its details came from as inferred", () => {
    // Fails closed. The alternative is that anything reaching this call without the field —
    // a plan encoded before it existed — quietly recovers the permission it never had.
    expect(directExecutionAllowance(db)).toMatchObject({
      allowed: false,
      reason: "inferred_details",
    });
  });

  it("stops acting once the day's ceiling is reached", async () => {
    await grantCalendar();
    updateCalendarActionSetting(db, { dailyLimit: 1 }, userMessageId);
    const effect = propose();
    authorizeEffectByPolicy(db, effect.id, effect.payload_hash, {
      requestMessageId: userMessageId,
      policy: "calendar_direct_execution",
    });

    expect(directExecutionAllowance(db, { detailsFrom: "user_message" })).toMatchObject({
      allowed: false,
      reason: "daily_limit",
      usedToday: 1,
    });
  }, 30_000);

  it("can be switched off, and refuses to be switched by anything but a user action", () => {
    updateCalendarActionSetting(db, { directExecution: false }, userMessageId);
    expect(directExecutionAllowance(db, { detailsFrom: "user_message" })).toMatchObject({
      allowed: false,
      reason: "disabled",
    });

    const assistantId = appendMessage(db, conversationId, "assistant", "Turning that on.").id;
    expect(() =>
      updateCalendarActionSetting(db, { directExecution: true }, assistantId),
    ).toThrow(/explicit user action/u);
  });
});

describe("two identical requests are two requests", () => {
  it("proposes again on a new step rather than returning a spent one", async () => {
    await grantCalendar();
    const first = propose();

    // The same event, asked for again after the first was dealt with. A digest that was
    // unique globally rather than per step silently returned the old row and created
    // nothing.
    db.exec(`
      INSERT INTO work_step (id, work_plan_id, position, title, instruction, effect_kind, status)
      VALUES (2, 1, 2, 'hold again', 'hold the slot again', 'schedule', 'running');
    `);
    const second = proposeEffect(db, {
      workRunId: 1,
      workStepId: 2,
      slot: "calendar.create_event",
      payload: { title: "Dinner with Sam", starts_at: "2026-08-20T18:30:00Z" },
      previewText: "Create “Dinner with Sam” on 20 August at 18:30.",
      providerRequestKey: "req-2",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.payload_hash).toBe(first.payload_hash);
  }, 30_000);
});

describe("payload hashing", () => {
  it("ignores key order but not values", () => {
    expect(
      payloadHash("calendar.create_event", "create_event", { a: 1, b: 2 }),
    ).toBe(payloadHash("calendar.create_event", "create_event", { b: 2, a: 1 }));
    expect(
      payloadHash("calendar.create_event", "create_event", { a: 1 }),
    ).not.toBe(payloadHash("calendar.create_event", "create_event", { a: 2 }));
    // A different tool for the same bytes is a different request.
    expect(
      payloadHash("calendar.create_event", "create_event", { a: 1 }),
    ).not.toBe(payloadHash("calendar.create_event", "create_event_v2", { a: 1 }));
  });
});

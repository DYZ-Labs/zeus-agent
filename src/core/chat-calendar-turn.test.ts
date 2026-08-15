import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarIntent } from "./calendar-intent";

/**
 * What a chat turn does with a calendar request it recognizes but does not carry out.
 *
 * Every one of these used to end the same way: `work` was null, no block reached the model,
 * no card reached the screen, and the reply was composed from memory alone. That is how
 * "there is no existing dinner event to reschedule" came to be said about a calendar nothing
 * in the turn had opened.
 */

const mocks = vi.hoisted(() => ({
  assertResponseComplete: vi.fn(),
  buildContext: vi.fn(),
  callCapability: vi.fn(),
  classifyCalendarIntent: vi.fn(),
  finalResponse: vi.fn(),
  generateWorkPlanProposal: vi.fn(),
  on: vi.fn(),
  openaiStream: vi.fn(),
  recordResponseContext: vi.fn(),
  renderMemoryBlock: vi.fn(() => "<memory />"),
  restoreConnectorReachability: vi.fn(),
}));

vi.mock("./openai", () => ({
  MODEL: "test-model",
  OPENAI_TIMEOUT_MS: 75_000,
  assertResponseComplete: mocks.assertResponseComplete,
  openai: () => ({ responses: { stream: mocks.openaiStream } }),
}));

vi.mock("./context", () => ({
  buildContext: mocks.buildContext,
  intentFieldProvenance: vi.fn(),
  recordResponseContext: mocks.recordResponseContext,
  renderMemoryBlock: mocks.renderMemoryBlock,
}));

vi.mock("./extract", () => ({
  applyExtraction: vi.fn(),
  extract: vi.fn(async () => ({})),
  extractionContext: vi.fn(() => ({})),
  extractionSourceMessageIds: vi.fn(() => []),
  finishExtractionRun: vi.fn(() => ({ status: "completed" })),
  startExtractionRun: vi.fn(() => ({ id: 1 })),
}));

// Only the model call is replaced. The veto, the capability check, and the outcome mapping
// all run for real — they are the parts under test.
vi.mock("./calendar-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./calendar-intent")>()),
  classifyCalendarIntent: mocks.classifyCalendarIntent,
}));

vi.mock("./work-execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./work-execution")>()),
  generateWorkPlanProposal: mocks.generateWorkPlanProposal,
}));

// The two places this turn reaches the network. The recovery handshake and the read itself
// are exercised for real in mcp-client.test.ts; what matters here is what the turn does with
// each answer.
vi.mock("./mcp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-client")>()),
  callCapability: mocks.callCapability,
  restoreConnectorReachability: mocks.restoreConnectorReachability,
}));

import { streamTurn } from "./chat";
import {
  availableCapability,
  bindCapability,
  createConnector,
  getConnector,
  recordConnectorVerification,
  restoreConnectorAfterReachability,
  setCapabilityEnabled,
  setConnectorEnabled,
} from "./connectors";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import type { CapabilitySlot } from "./schema";

function intent(overrides: Partial<CalendarIntent> = {}): CalendarIntent {
  return {
    intent: "reschedule",
    confidence: "high",
    title: null,
    starts_at_local: "2026-08-17T19:30",
    ends_at_local: null,
    location: null,
    target: { title_text: "dinner", starts_at_local: null, date_local: null },
    is_negated: false,
    is_hypothetical_or_quoted: false,
    is_about_another_person: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildContext.mockResolvedValue({
    hits: [],
    plan: {},
    queryVector: null,
    recommendation: null,
  });
  mocks.openaiStream.mockReturnValue({ on: mocks.on, finalResponse: mocks.finalResponse });
  mocks.finalResponse.mockResolvedValue({ output_text: "Reply." });
  mocks.generateWorkPlanProposal.mockResolvedValue(null);
  mocks.restoreConnectorReachability.mockResolvedValue(false);
  mocks.callCapability.mockResolvedValue({
    value: { events: [] },
    text: JSON.stringify({ events: [] }),
    isError: false,
  });
});

function connectCalendar(db: Db, slots: readonly CapabilitySlot[]): void {
  const conversation = createConversation(db, { title: "Connections", source: "web" });
  const sourceMessageId = appendMessage(db, conversation.id, "user", "connect my calendar", {
    origin: "user_action",
    recallState: "blocked",
  }).id;
  const connector = createConnector(db, {
    label: "Calendar",
    transport: "stdio",
    command: "node",
    args: ["./calendar-server.js"],
    sourceMessageId,
  });
  recordConnectorVerification(db, connector.id, { status: "ready" });
  setConnectorEnabled(db, connector.id, true, sourceMessageId);
  for (const slot of slots) {
    const capability = bindCapability(db, {
      connectorId: connector.id,
      slot,
      remoteToolName: slot.split(".")[1] ?? slot,
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      sourceMessageId,
    });
    setCapabilityEnabled(db, capability.id, true, sourceMessageId);
  }
}

async function turn(input: string, db: Db = openTestDb()) {
  const conversation = createConversation(db);
  const result = await streamTurn(db, {
    conversationId: conversation.id,
    input,
    timezone: "UTC",
  });
  const body = mocks.openaiStream.mock.calls[0]?.[0] as {
    input: { role: string; content: string }[];
  };
  return { result, sentToModel: body.input.at(-1)?.content ?? "" };
}

describe("a recognized calendar request is never silent", () => {
  it("reads a connected calendar on the first turn of every new conversation", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    // A classifier timeout or malformed response returns null. A direct read must not need
    // conversational history—or a second attempt—to reach an already granted capability.
    mocks.classifyCalendarIntent.mockResolvedValue(null);

    const first = await turn("What is on my calendar tomorrow?", db);
    const second = await turn("Show me my calendar for tomorrow.", db);

    expect(first.result.calendar).toMatchObject({ kind: "read", status: "done" });
    expect(second.result.calendar).toMatchObject({ kind: "read", status: "done" });
    expect(mocks.callCapability).toHaveBeenCalledTimes(2);
    expect(mocks.classifyCalendarIntent).not.toHaveBeenCalled();
  });

  it("answers a connection question from live capability state without reading events", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);

    const { result, sentToModel } = await turn("Is Google Calendar connected?", db);

    expect(result.calendar).toBeNull();
    expect(sentToModel).toContain("<capabilities>");
    expect(sentToModel).toContain("connected for reading only");
    expect(mocks.classifyCalendarIntent).not.toHaveBeenCalled();
    expect(mocks.generateWorkPlanProposal).not.toHaveBeenCalled();
  });

  it("says nothing is connected instead of letting the model guess", async () => {
    mocks.classifyCalendarIntent.mockResolvedValue(intent());

    const { result, sentToModel } = await turn("move dinner to 7:30pm");

    expect(result.calendar).toMatchObject({
      kind: "reschedule",
      status: "no_connector",
      reason: "not_connected",
    });
    expect(sentToModel).toContain('<calendar_result status="no_connector"');
    // No connector means no plan to generate; the turn must not spend a model call finding
    // that out.
    expect(mocks.generateWorkPlanProposal).not.toHaveBeenCalled();
  });

  it("reports a read-only connection instead of discarding the turn", async () => {
    // A read-only grant used to make `assertAuthorizableEffects` throw, which the planning
    // catch swallowed — so the user was told nothing and the model was told nothing.
    mocks.classifyCalendarIntent.mockResolvedValue(intent());
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);

    const { result, sentToModel } = await turn("move dinner to 7:30pm", db);

    expect(result.calendar).toMatchObject({
      status: "read_only",
      reason: "no_write_capability",
    });
    expect(sentToModel).toContain('<calendar_result status="read_only"');
  });

  it("asks rather than inventing a reason when the classifier was unsure", async () => {
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ confidence: "low" }));

    const { result, sentToModel } = await turn("move dinner to 7:30pm");

    expect(result.calendar).toMatchObject({
      status: "needs_clarification",
      reason: "low_confidence_write",
      kind: "reschedule",
    });
    expect(sentToModel).toContain("needs_clarification");
  });

  it.each([
    ["negated", { is_negated: true }],
    ["hypothetical", { is_hypothetical_or_quoted: true }],
    ["someone else's", { is_about_another_person: true }],
    ["not a calendar request", { intent: "none" as const }],
  ])("stays quiet when the user did not ask (%s)", async (_label, overrides) => {
    mocks.classifyCalendarIntent.mockResolvedValue(intent(overrides));

    const { result, sentToModel } = await turn("dinner with Priya was great tonight");

    // The prefilter is over-inclusive on purpose. If these spoke, an ordinary sentence about
    // dinner would raise a calendar card.
    expect(result.calendar).toBeNull();
    expect(sentToModel).not.toContain("<calendar_result");
  });

  it("still runs a research plan when the message was never a calendar request", async () => {
    // "by Friday" is enough for the prefilter, so an ordinary bounded-work request reaches
    // the classifier and comes back as `none`. Returning there would quietly drop the work.
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    await turn("Research the backup options by Friday and draft a recommendation.");

    expect(mocks.generateWorkPlanProposal).toHaveBeenCalledOnce();
  });

  it("stores the outcome so a reload still shows what happened", async () => {
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ confidence: "low" }));
    const db = openTestDb();
    const conversation = createConversation(db);

    const result = await streamTurn(db, {
      conversationId: conversation.id,
      input: "move dinner to 7:30pm",
      timezone: "UTC",
    });

    const stored = db
      .prepare<[number], { status: string }>(
        "SELECT status FROM calendar_outcome WHERE assistant_message_id = ?",
      )
      .get(result.message.id);
    expect(stored?.status).toBe("needs_clarification");
  });
});

/**
 * The reported failure, from the outside: open a new chat, ask about the calendar, and be
 * told it cannot be read — for a calendar that is plainly connected.
 *
 * A conversation carries no connection state, so "it only happens in a new chat" was really
 * "it happens whenever the transcript does not already contain a successful read". The store
 * underneath had been left unreachable by a single failed call, and nothing on any path
 * could ever put it back.
 */
describe("a connection that stopped answering is not a connection the user lost", () => {
  /** Leave a connected calendar in the state one failed call used to leave it in. */
  function stopAnswering(db: Db, errorCode: string): number {
    const connector = getConnector(db, 1);
    if (!connector) throw new Error("connector missing");
    recordConnectorVerification(db, connector.id, { status: "unreachable", errorCode });
    return connector.id;
  }

  it("puts the calendar back into service on the first request instead of refusing", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    const connectorId = stopAnswering(db, "call_failed");
    expect(availableCapability(db, "calendar.list_events")).toBeNull();
    // What the real handshake does when the service is answering again.
    mocks.restoreConnectorReachability.mockImplementation(async () => {
      const prior = getConnector(db, connectorId)!;
      recordConnectorVerification(db, connectorId, { status: "ready", tools: [] });
      restoreConnectorAfterReachability(db, prior);
      return true;
    });
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "read" }));

    const { result } = await turn("what's on my calendar today?", db);

    expect(mocks.restoreConnectorReachability).toHaveBeenCalledWith(db, "calendar.list_events");
    expect(availableCapability(db, "calendar.list_events")).not.toBeNull();
    // The turn read the calendar rather than reporting that it could not.
    expect(result.calendar).toMatchObject({ kind: "read", status: "done" });
    expect(mocks.callCapability).toHaveBeenCalled();
  });

  it("says the connection is intact when the service is still not answering", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    stopAnswering(db, "call_failed");
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "read" }));

    const { result, sentToModel } = await turn("what's on my calendar today?", db);

    // `provider_unavailable`, not `connector_unavailable`: the second sends the user to
    // Settings to repair a connection that was never broken.
    expect(result.calendar).toMatchObject({
      status: "unverifiable",
      reason: "provider_unavailable",
    });
    expect(sentToModel).toContain("needs nothing from the user");
    expect(sentToModel).not.toContain("cannot be used");
  });

  it("still asks for a reconnection when the authorization is what failed", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    stopAnswering(db, "reconnect_required");
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "read" }));

    const { result, sentToModel } = await turn("what's on my calendar today?", db);

    expect(result.calendar).toMatchObject({
      status: "unverifiable",
      reason: "reconnect_required",
    });
    expect(sentToModel).toContain("Reconnect required");
  });
});

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

import { cacheCalendarEvents } from "./calendar-sync";
import { streamTurn } from "./chat";
import { batchPayloadHash, confirmationSentence, listPendingEffects } from "./effects";
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
      // The write schemas match what the real tools accept. A narrower fixture fails the
      // payload check and reports `payload_invalid`, which reads as a Zeus bug rather than
      // as a test that never described the connector honestly.
      inputSchema:
        slot === "calendar.list_events"
          ? {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
              },
              required: ["from", "to"],
            }
          : slot === "calendar.create_event"
            ? {
                type: "object",
                properties: {
                  title: { type: "string" },
                  start: { type: "string" },
                  end: { type: "string" },
                  time_zone: { type: "string" },
                  location: { type: "string" },
                },
                required: ["title", "start", "end"],
              }
            : {
                type: "object",
                properties: {
                  event_id: { type: "string" },
                  start: { type: "string" },
                  end: { type: "string" },
                  time_zone: { type: "string" },
                  status: { type: "string" },
                },
                required: ["event_id"],
              },
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

/** Another turn in a conversation that already has some, reading the latest model call. */
async function nextTurn(db: Db, conversationId: number, input: string) {
  const result = await streamTurn(db, { conversationId, input, timezone: "UTC" });
  const body = mocks.openaiStream.mock.calls.at(-1)?.[0] as {
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

/**
 * The reported failure: talk to Zeus for a while and it says it has no completed calendar
 * result — about a change it made itself, two messages ago.
 *
 * Nothing was broken in the calendar path. Every block of a turn belongs to a synthetic final
 * message that is discarded when the turn ends, so a later turn was replayed nothing but bare
 * prose; the prompt then correctly refused to claim anything, and the correct refusal was the
 * bug. The stored outcome had been there the whole time, read only by the browser.
 */
describe("what Zeus did survives the turn that did it", () => {
  it("tells a later turn about a change made in an earlier one", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    mocks.classifyCalendarIntent.mockResolvedValue(
      intent({
        intent: "create",
        title: "Lunch with Sam",
        starts_at_local: "2026-08-19T13:00",
        ends_at_local: "2026-08-19T14:00",
        target: null,
      }),
    );
    const conversation = createConversation(db);

    const acted = await nextTurn(db, conversation.id, "add lunch with Sam tomorrow at 1pm");
    expect(acted.result.calendar).toMatchObject({ kind: "create", status: "done" });

    // An ordinary sentence, nowhere near the calendar: the turn reads nothing, and used to
    // leave the model with no evidence a calendar had ever been opened.
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));
    const after = await nextTurn(db, conversation.id, "thanks, that is all sorted then");

    expect(after.result.calendar).toBeNull();
    expect(after.sentToModel).toContain("<calendar_history>");
    expect(after.sentToModel).toContain("completed_earlier_in_this_conversation");
    expect(after.sentToModel).toContain('"status":"done"');
    expect(after.sentToModel).not.toContain("<calendar_result");
  });

  it("says nothing about a conversation that never touched the calendar", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    const { sentToModel } = await nextTurn(db, conversation.id, "how are you today");

    expect(sentToModel).not.toContain("<calendar_history>");
  });

  it("does not carry one conversation's actions into another", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    mocks.classifyCalendarIntent.mockResolvedValue(null);
    const first = createConversation(db);
    await nextTurn(db, first.id, "What is on my calendar tomorrow?");

    const second = createConversation(db);
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));
    const { sentToModel } = await nextTurn(db, second.id, "how are you today");

    expect(sentToModel).not.toContain("<calendar_history>");
  });

  /**
   * The other half of the same failure. "did that go through?" carries no calendar noun and
   * no time, so the prefilter dropped it before the classifier ever saw it.
   */
  it("classifies a short follow-up once the conversation is already about the calendar", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    mocks.classifyCalendarIntent.mockResolvedValue(null);
    const conversation = createConversation(db);
    await nextTurn(db, conversation.id, "What is on my calendar tomorrow?");
    expect(mocks.classifyCalendarIntent).not.toHaveBeenCalled();

    await nextTurn(db, conversation.id, "and after that?");

    expect(mocks.classifyCalendarIntent).toHaveBeenCalledOnce();
  });

  it("still ignores a short aside in a conversation that has no calendar history", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);

    await nextTurn(db, conversation.id, "and after that?");

    expect(mocks.classifyCalendarIntent).not.toHaveBeenCalled();
  });
});

/**
 * Emptying a window: several events, one confirmation, and never the standing setting.
 *
 * Direct execution exists so a verified single change need not interrupt anyone. Removing
 * everything from a stretch of somebody's week is not that, and the itemized list Zeus shows
 * before asking is the entire safeguard — so this path must ask however the setting is set.
 */
describe("clearing a window", () => {
  const THURSDAY = [
    {
      id: "evt-review",
      title: "Design review",
      starts_at: "2026-08-20T13:00:00.000Z",
      ends_at: "2026-08-20T14:00:00.000Z",
    },
    {
      id: "evt-gym",
      title: "Gym",
      starts_at: "2026-08-20T17:00:00.000Z",
      ends_at: "2026-08-20T18:00:00.000Z",
    },
  ];

  function clearIntent(overrides: Partial<CalendarIntent> = {}): CalendarIntent {
    return intent({
      intent: "clear",
      title: null,
      starts_at_local: "2026-08-20T12:00",
      ends_at_local: "2026-08-20T18:30",
      target: null,
      ...overrides,
    });
  }

  function calendarHolding(events: readonly unknown[]): void {
    mocks.callCapability.mockImplementation(async (_db: unknown, slot: string) =>
      slot === "calendar.list_events"
        ? { value: { events }, text: JSON.stringify({ events }), isError: false }
        : { value: { ok: true }, text: "{}", isError: false },
    );
  }

  it("prepares one cancellation per event and stops, whatever the standing setting says", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding(THURSDAY);
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);

    const { result, sentToModel } = await nextTurn(
      db,
      conversation.id,
      "clear my Thursday afternoon",
    );

    expect(result.calendar).toMatchObject({ kind: "clear", status: "awaiting_confirmation" });
    // Nothing left the machine: the only calls were the read and its coverage.
    expect(
      mocks.callCapability.mock.calls.every((call) => call[1] === "calendar.list_events"),
    ).toBe(true);
    const pending = listPendingEffects(db);
    expect(pending).toHaveLength(2);
    expect(pending.every((effect) => effect.confirmation_kind === "user_message")).toBe(true);
    // One hash over both payloads, so the reply can ask once.
    expect(result.calendar?.confirmationHash).toBe(batchPayloadHash(pending));
    // And the reply is given the events by name, so it can list them before asking.
    expect(sentToModel).toContain("Design review");
    expect(sentToModel).toContain("Gym");
  });

  it("carries out every prepared cancellation once the user sends the line", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding(THURSDAY);
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);
    await nextTurn(db, conversation.id, "clear my Thursday afternoon");
    const hash = batchPayloadHash(listPendingEffects(db))!;

    const { result } = await nextTurn(db, conversation.id, confirmationSentence(hash, 2));

    expect(listPendingEffects(db)).toHaveLength(0);
    expect(result.work?.completedEffects).toHaveLength(2);
    expect(result.calendar).toMatchObject({ kind: "clear", status: "done" });
    const sent = mocks.callCapability.mock.calls.filter(
      (call) => call[1] === "calendar.update_event",
    );
    expect(sent.map((call) => (call[2] as { event_id: string }).event_id).sort()).toEqual([
      "evt-gym",
      "evt-review",
    ]);
  });

  it("changes nothing when the window is already empty, and does not pretend otherwise", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding([]);
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);

    const { result } = await nextTurn(db, conversation.id, "clear my Thursday afternoon");

    expect(result.calendar).toMatchObject({ kind: "clear", status: "done" });
    expect(listPendingEffects(db)).toHaveLength(0);
  });

  /**
   * A list silently capped at twenty reads as "this is everything", and it would not be. So
   * the refusal is the honest answer, and it says how many it found.
   */
  it("refuses a window it would have to truncate rather than clearing part of it", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding(
      Array.from({ length: 21 }, (_unused, index) => ({
        id: `evt-${index}`,
        title: `Thing ${index}`,
        starts_at: new Date(Date.parse("2026-08-20T12:05:00.000Z") + index * 60_000).toISOString(),
        ends_at: new Date(Date.parse("2026-08-20T12:06:00.000Z") + index * 60_000).toISOString(),
      })),
    );
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);

    const { result } = await nextTurn(db, conversation.id, "clear my Thursday afternoon");

    expect(result.calendar).toMatchObject({
      kind: "clear",
      status: "needs_clarification",
      reason: "too_many_events",
    });
    expect(listPendingEffects(db)).toHaveLength(0);
  });

  /**
   * A message naming one member's hash authorizes that payload and no other, so the run
   * settles part of the set and parks again. What it must not do is *report* as finished:
   * the outcome still says awaiting_confirmation, and a preview describing the change that
   * did go through next to that status reads as a completed job.
   */
  it("describes what is still waiting when only part of the set was authorized", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding(THURSDAY);
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);
    await nextTurn(db, conversation.id, "clear my Thursday afternoon");
    const [first, second] = listPendingEffects(db);

    const { result } = await nextTurn(
      db,
      conversation.id,
      confirmationSentence(first!.payload_hash),
    );

    expect(result.calendar).toMatchObject({ status: "awaiting_confirmation" });
    expect(result.calendar?.preview).toBe(second!.preview_text);
    expect(listPendingEffects(db)).toHaveLength(1);
    // And the composer is offered the line for what is left, not the one already spent.
    expect(result.calendar?.confirmationHash).toBe(second!.payload_hash);
  });

  /**
   * Half-authorized and then stopped. The run's pause code still says a confirmation is
   * required, but nothing is pending any more — reporting "still waiting" to someone who has
   * just said no, and storing that in the history, is the wrong account of the turn.
   */
  it("reports a set the user stopped part-way as declined, not as still waiting", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding(THURSDAY);
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);
    await nextTurn(db, conversation.id, "clear my Thursday afternoon");
    const [first] = listPendingEffects(db);
    await nextTurn(db, conversation.id, confirmationSentence(first!.payload_hash));
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    const { result } = await nextTurn(db, conversation.id, "no, leave the rest");

    expect(result.calendar).toMatchObject({ status: "declined", reason: "declined_by_user" });
    expect(listPendingEffects(db)).toHaveLength(0);
    expect(result.work?.completedEffects).toHaveLength(1);
  });

  it("keeps a request that only sounds like a refusal, because it is a request", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding(THURSDAY);
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);
    await nextTurn(db, conversation.id, "clear my Thursday afternoon");
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    // "cancel that" is a refusal; "cancel that meeting on Friday" is the opposite of one, and
    // reading only the opening words could not tell them apart.
    await nextTurn(db, conversation.id, "cancel that meeting on Friday too");

    expect(listPendingEffects(db)).toHaveLength(2);
  });

  it("stops the whole set when the user says no", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.update_event"]);
    calendarHolding(THURSDAY);
    mocks.classifyCalendarIntent.mockResolvedValue(clearIntent());
    const conversation = createConversation(db);
    await nextTurn(db, conversation.id, "clear my Thursday afternoon");

    const { result } = await nextTurn(db, conversation.id, "no, leave it");

    expect(listPendingEffects(db)).toHaveLength(0);
    expect(result.work?.completedEffects ?? []).toHaveLength(0);
    expect(result.calendar).toMatchObject({ status: "declined", reason: "declined_by_user" });
    expect(
      mocks.callCapability.mock.calls.every((call) => call[1] === "calendar.list_events"),
    ).toBe(true);
  });
});

/**
 * The confirmation the panel used to collect, collected in the conversation instead.
 *
 * The button synthesized "I confirm external request <hash>" server-side when it was clicked.
 * This puts the same sentence in the composer and waits for the user to send it, so the
 * message naming the hash is genuinely theirs — the stricter arrangement, not the looser one.
 */
describe("confirming a change without a button", () => {
  const OCCUPIED = [
    {
      id: "evt-standup",
      title: "Standup",
      starts_at: "2026-08-19T13:00:00.000Z",
      ends_at: "2026-08-19T14:00:00.000Z",
    },
  ];

  function createIntent(): CalendarIntent {
    return intent({
      intent: "create",
      title: "Lunch with Sam",
      starts_at_local: "2026-08-19T13:00",
      ends_at_local: "2026-08-19T14:00",
      target: null,
    });
  }

  function calendarHolding(events: readonly unknown[]): void {
    mocks.callCapability.mockImplementation(async (_db: unknown, slot: string) =>
      slot === "calendar.list_events"
        ? { value: { events }, text: JSON.stringify({ events }), isError: false }
        : { value: { ok: true }, text: "{}", isError: false },
    );
  }

  async function collide(db: Db, conversationId: number) {
    calendarHolding(OCCUPIED);
    mocks.classifyCalendarIntent.mockResolvedValue(createIntent());
    return nextTurn(db, conversationId, "put lunch with Sam at 1pm tomorrow");
  }

  it("hands the reply the exact hash the user has to send", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const conversation = createConversation(db);

    const { result } = await collide(db, conversation.id);

    expect(result.calendar).toMatchObject({
      kind: "create",
      status: "awaiting_confirmation",
      reason: "calendar_conflict",
    });
    const [pending] = listPendingEffects(db);
    expect(result.calendar?.confirmationHash).toBe(pending?.payload_hash);
    // Nothing was sent, and the collision is named so the reply can explain it.
    expect(result.calendar?.conflicts?.[0]?.title).toBe("Standup");
    expect(
      mocks.callCapability.mock.calls.every((call) => call[1] === "calendar.list_events"),
    ).toBe(true);
  });

  it("carries the change out when the user sends that line", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const conversation = createConversation(db);
    await collide(db, conversation.id);
    const hash = listPendingEffects(db)[0]!.payload_hash;

    const { result } = await nextTurn(db, conversation.id, confirmationSentence(hash));

    expect(result.calendar).toMatchObject({ kind: "create", status: "done" });
    expect(result.work?.completedEffects).toHaveLength(1);
    expect(
      mocks.callCapability.mock.calls.some((call) => call[1] === "calendar.create_event"),
    ).toBe(true);
    // The classifier is never consulted: this message answers a question, it does not ask one.
    expect(mocks.classifyCalendarIntent).toHaveBeenCalledOnce();
  });

  it("keeps the hash out of retrieval, since it is a decision and not something said", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const conversation = createConversation(db);
    await collide(db, conversation.id);
    const hash = listPendingEffects(db)[0]!.payload_hash;

    const { result } = await nextTurn(db, conversation.id, confirmationSentence(hash));

    const decision = db
      .prepare<[number], { recall_state: string }>(
        "SELECT recall_state FROM message WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
      )
      .get(conversation.id);
    expect(decision?.recall_state).toBe("blocked");
    // And nothing was mined from it.
    expect(result.learned).toBeNull();
  });

  /**
   * The user did their part and it bounced. Falling through to ordinary chat would answer a
   * payload digest as though it were a new request and leave them unsure what happened.
   */
  it("answers a confirmation that no longer matches instead of ignoring it", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const conversation = createConversation(db);
    await collide(db, conversation.id);
    const pending = listPendingEffects(db)[0]!;
    // The grant behind the payload is withdrawn between the ask and the answer.
    const capability = getConnector(db, pending.connector.id)!.capabilities.find(
      (entry) => entry.slot === "calendar.create_event",
    )!;
    setCapabilityEnabled(db, capability.id, false, 1);
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    const { result } = await nextTurn(
      db,
      conversation.id,
      confirmationSentence(pending.payload_hash),
    );

    expect(result.calendar).not.toBeNull();
    expect(result.calendar?.status).not.toBe("done");
    expect(
      mocks.callCapability.mock.calls.every((call) => call[1] === "calendar.list_events"),
    ).toBe(true);
  });

  it("does nothing at all for a sentence that names no live hash", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const conversation = createConversation(db);
    await collide(db, conversation.id);
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    await nextTurn(db, conversation.id, "yes go ahead");

    // Assent is not authorization. The request is still sitting there, unsent.
    expect(listPendingEffects(db)).toHaveLength(1);
    expect(
      mocks.callCapability.mock.calls.every((call) => call[1] === "calendar.list_events"),
    ).toBe(true);
  });

  it("refuses a hash an assistant message named rather than the user", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const conversation = createConversation(db);
    await collide(db, conversation.id);
    const hash = listPendingEffects(db)[0]!.payload_hash;
    // The reply itself quoting the hash must not be able to authorize anything, so the
    // model repeating it back is checked at the same place a forged message would be.
    mocks.finalResponse.mockResolvedValueOnce({
      output_text: confirmationSentence(hash),
    });
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    await nextTurn(db, conversation.id, "what were you going to do again?");

    expect(listPendingEffects(db)).toHaveLength(1);
  });
});

/**
 * A bare "no" is a very cheap token, so what it is allowed to reach matters.
 */
describe("what a refusal can and cannot stop", () => {
  function calendarHolding(events: readonly unknown[]): void {
    mocks.callCapability.mockImplementation(async (_db: unknown, slot: string) =>
      slot === "calendar.list_events"
        ? { value: { events }, text: JSON.stringify({ events }), isError: false }
        : { value: { ok: true }, text: "{}", isError: false },
    );
  }

  async function pendingIn(db: Db, conversationId: number) {
    calendarHolding([
      {
        id: "evt-standup",
        title: "Standup",
        starts_at: "2026-08-19T13:00:00.000Z",
        ends_at: "2026-08-19T14:00:00.000Z",
      },
    ]);
    mocks.classifyCalendarIntent.mockResolvedValue(
      intent({
        intent: "create",
        title: "Lunch with Sam",
        starts_at_local: "2026-08-19T13:00",
        ends_at_local: "2026-08-19T14:00",
        target: null,
      }),
    );
    return nextTurn(db, conversationId, "put lunch with Sam at 1pm tomorrow");
  }

  it("does not reach a request another conversation is waiting on", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const asked = createConversation(db);
    await pendingIn(db, asked.id);
    expect(listPendingEffects(db)).toHaveLength(1);

    const elsewhere = createConversation(db);
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));
    await nextTurn(db, elsewhere.id, "no");

    // The user answered a question nobody asked them here.
    expect(listPendingEffects(db)).toHaveLength(1);
  });

  it("stops it when the refusal is in the conversation that asked", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events", "calendar.create_event"]);
    const conversation = createConversation(db);
    await pendingIn(db, conversation.id);
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    const { result } = await nextTurn(db, conversation.id, "no");

    expect(listPendingEffects(db)).toHaveLength(0);
    expect(result.calendar).toMatchObject({ status: "declined" });
  });

  it("does nothing when there was no question to refuse", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    mocks.classifyCalendarIntent.mockResolvedValue(intent({ intent: "none" }));

    const { result } = await nextTurn(db, conversation.id, "no");

    expect(result.calendar).toBeNull();
  });
});

/**
 * The standing schedule block: Zeus already knows the calendar before being asked.
 *
 * The failure this replaces was structural, not conversational. A turn the intent gate did
 * not recognize — "what does my day look like?", "am I free at 3?", or just "hey" — carried
 * no calendar data at all, and the prompt then required the model to say it didn't look.
 */
describe("every turn already knows the schedule", () => {
  it("syncs and renders the schedule on a turn that never mentioned the calendar", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    mocks.callCapability.mockResolvedValue({
      value: {
        events: [
          {
            id: "standup",
            title: "Standup",
            starts_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      },
      text: "",
      isError: false,
    });

    const { result, sentToModel } = await turn("hey", db);

    // No calendar request was recognized, so there is no card — but the block is there,
    // fresh, with the event, between capabilities and memory.
    expect(result.calendar).toBeNull();
    expect(mocks.callCapability).toHaveBeenCalledOnce();
    expect(sentToModel).toContain('<schedule state="current"');
    expect(sentToModel).toContain("“Standup”");
    expect(sentToModel.indexOf("<capabilities>")).toBeLessThan(sentToModel.indexOf("<schedule"));
    expect(sentToModel.indexOf("<schedule")).toBeLessThan(sentToModel.indexOf("<memory"));
  });

  it("answers from the fresh cache without spending another connector call", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    cacheCalendarEvents(db, 1, {
      events: [
        {
          id: "standup",
          title: "Standup",
          starts_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });

    const { sentToModel } = await turn("am I free at 3?", db);

    expect(mocks.callCapability).not.toHaveBeenCalled();
    expect(sentToModel).toContain('<schedule state="current"');
    expect(sentToModel).toContain("“Standup”");
  });

  it("degrades to the dated last-known schedule when the refresh fails mid-turn", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    cacheCalendarEvents(
      db,
      1,
      {
        events: [
          {
            id: "standup",
            title: "Standup",
            starts_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      },
      twoHoursAgo,
    );
    mocks.callCapability.mockRejectedValue(new Error("provider down"));

    const { sentToModel } = await turn("hey", db);

    expect(sentToModel).toContain('<schedule state="stale"');
    expect(sentToModel).toContain(`as_of="${twoHoursAgo.toISOString()}"`);
    expect(sentToModel).toContain("A newer read has not succeeded");
    expect(sentToModel).toContain("“Standup”");
  });

  it("tries to heal an unreachable connector even when nobody asked about the calendar", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    recordConnectorVerification(db, 1, { status: "unreachable", errorCode: "call_failed" });
    // Move the recorded failure outside the cooldown, as time passing would.
    db.prepare<[string, number]>("UPDATE connector SET updated_at = ? WHERE id = ?").run(
      new Date(Date.now() - 20 * 60_000).toISOString(),
      1,
    );

    const { sentToModel } = await turn("hey", db);

    expect(mocks.restoreConnectorReachability).toHaveBeenCalledWith(
      db,
      "calendar.list_events",
      expect.anything(),
    );
    // Still down: the block says unknown, and the capability line stays truthful.
    expect(sentToModel).toContain('<schedule state="unread"');
    expect(sentToModel).toContain("needs nothing from the user");
  });

  it("does not read twice when the turn already ran a calendar read plan", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);
    mocks.classifyCalendarIntent.mockResolvedValue(null);

    const { result, sentToModel } = await turn("What is on my calendar tomorrow?", db);

    // One connector call: the plan's read. The top-up found its coverage fresh.
    expect(result.calendar).toMatchObject({ kind: "read", status: "done" });
    expect(mocks.callCapability).toHaveBeenCalledOnce();
    expect(sentToModel).toContain('<schedule state="current"');
  });

  it("stores the turn's snapshot so a schedule claim stays auditable", async () => {
    const db = openTestDb();
    connectCalendar(db, ["calendar.list_events"]);

    const { result } = await turn("hey", db);

    const stored = db
      .prepare<[number], { state: string }>(
        "SELECT state FROM schedule_context WHERE assistant_message_id = ?",
      )
      .get(result.message.id);
    expect(stored?.state).toBe("current");
  });

  it("carries no schedule block at all when nothing is connected", async () => {
    const db = openTestDb();

    const { result, sentToModel } = await turn("hey", db);

    expect(result.calendar).toBeNull();
    expect(sentToModel).not.toContain("<schedule");
    const rows = db
      .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM schedule_context")
      .get();
    expect(rows?.total).toBe(0);
  });
});

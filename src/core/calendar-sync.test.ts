import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callCapability: vi.fn(),
  restoreConnectorReachability: vi.fn(),
}));

vi.mock("./mcp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-client")>()),
  callCapability: mocks.callCapability,
  restoreConnectorReachability: mocks.restoreConnectorReachability,
}));

import {
  CHAT_COVERAGE_TTL_MS,
  cacheCalendarEvents,
  cachedEvents,
  calendarListEventArguments,
  calendarWindow,
  ensureFreshCalendarCache,
  lastKnownEvents,
  readCalendarCoverage,
} from "./calendar-sync";
import {
  bindCapability,
  createConnector,
  recordConnectorVerification,
  setCapabilityEnabled,
  setConnectorEnabled,
} from "./connectors";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";

const window = {
  from: "2026-08-16T00:00:00.000Z",
  to: "2026-09-15T00:00:00.000Z",
};

describe("calendar list arguments", () => {
  it("uses the hosted broker's reviewed window fields", () => {
    expect(calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    }), window)).toEqual({ from: window.from, to: window.to });
  });

  it("uses Google Calendar MCP's reviewed window fields", () => {
    expect(calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: {
        calendarId: { type: "string" },
        startTime: { type: "string" },
        endTime: { type: "string" },
      },
      required: ["calendarId"],
    }), window)).toEqual({
      calendarId: "primary",
      startTime: window.from,
      endTime: window.to,
    });
  });

  it("supports the earlier preview field names without widening the request", () => {
    expect(calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: { timeMin: { type: "string" }, timeMax: { type: "string" } },
    }), window)).toEqual({ timeMin: window.from, timeMax: window.to });
  });

  it("fails closed for an unbounded or newly-required contract", () => {
    expect(() => calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: { query: { type: "string" } },
    }), window)).toThrow(/no supported bounded time window/u);
    expect(() => calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        account: { type: "string" },
      },
      required: ["from", "to", "account"],
    }), window)).toThrow(/requires unsupported field account/u);
  });
});

/**
 * The turn-start top-up: free when the cache is fresh, one bounded read when it is not, and
 * never an exception in the middle of somebody's chat turn.
 */
describe("keeping the cache fresh enough for a turn", () => {
  let db: Db;
  let connectorId: number;

  function connectCalendar(): void {
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
    connectorId = connector.id;
    recordConnectorVerification(db, connector.id, { status: "ready" });
    setConnectorEnabled(db, connector.id, true, sourceMessageId);
    const capability = bindCapability(db, {
      connectorId: connector.id,
      slot: "calendar.list_events",
      remoteToolName: "list_events",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
      sourceMessageId,
    });
    setCapabilityEnabled(db, capability.id, true, sourceMessageId);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = openTestDb();
    mocks.restoreConnectorReachability.mockResolvedValue(false);
    mocks.callCapability.mockResolvedValue({
      value: { events: [] },
      text: JSON.stringify({ events: [] }),
      isError: false,
    });
  });

  it("spends no connector call when the coverage is already fresh", async () => {
    connectCalendar();
    const at = new Date();
    cacheCalendarEvents(db, connectorId, { events: [] }, at, calendarWindow(at));

    await expect(ensureFreshCalendarCache(db, { at })).resolves.toBe("fresh");
    expect(mocks.callCapability).not.toHaveBeenCalled();
  });

  it("reads once when the coverage has gone stale, and records the new proof", async () => {
    connectCalendar();
    const at = new Date();
    const stale = new Date(at.getTime() - CHAT_COVERAGE_TTL_MS - 60_000);
    cacheCalendarEvents(db, connectorId, { events: [] }, stale, calendarWindow(stale));

    await expect(ensureFreshCalendarCache(db, { at })).resolves.toBe("synced");
    expect(mocks.callCapability).toHaveBeenCalledOnce();
    expect(readCalendarCoverage(db)?.fetchedAt).toBe(at.toISOString());
  });

  it("degrades to a report, never an exception, when the read fails", async () => {
    connectCalendar();
    mocks.callCapability.mockRejectedValue(new Error("boom"));

    await expect(ensureFreshCalendarCache(db)).resolves.toBe("sync_failed");
  });

  it("answers no_connector without touching the network when nothing is connected", async () => {
    await expect(ensureFreshCalendarCache(db)).resolves.toBe("no_connector");
    expect(mocks.callCapability).not.toHaveBeenCalled();
    expect(mocks.restoreConnectorReachability).not.toHaveBeenCalled();
  });

  it("waits out the cooldown before retrying a connector that just failed a handshake", async () => {
    connectCalendar();
    // One bad minute: the failure that recorded `unreachable` also stamped `updated_at`.
    recordConnectorVerification(db, connectorId, {
      status: "unreachable",
      errorCode: "call_failed",
    });

    await expect(ensureFreshCalendarCache(db)).resolves.toBe("unavailable");
    expect(mocks.restoreConnectorReachability).not.toHaveBeenCalled();
  });

  it("gives an unreachable connector its handshake once the cooldown has passed", async () => {
    connectCalendar();
    recordConnectorVerification(db, connectorId, {
      status: "unreachable",
      errorCode: "call_failed",
    });
    const past = new Date(Date.now() - CHAT_COVERAGE_TTL_MS - 60_000).toISOString();
    db.prepare<[string, number]>("UPDATE connector SET updated_at = ? WHERE id = ?").run(
      past,
      connectorId,
    );
    mocks.restoreConnectorReachability.mockImplementation(async () => {
      recordConnectorVerification(db, connectorId, { status: "ready", tools: [] });
      db.prepare<[number]>("UPDATE connector SET enabled = 1 WHERE id = ?").run(connectorId);
      return true;
    });

    await expect(ensureFreshCalendarCache(db)).resolves.toBe("restored_and_synced");
    expect(mocks.callCapability).toHaveBeenCalledOnce();
  });
});

describe("the last-known schedule", () => {
  it("still reads expired rows, because a failed refresh deserves a dated answer", () => {
    const db = openTestDb();
    const conversation = createConversation(db, { title: "Connections", source: "web" });
    const sourceMessageId = appendMessage(db, conversation.id, "user", "connect", {
      origin: "user_action",
      recallState: "blocked",
    }).id;
    const connector = createConnector(db, {
      label: "Calendar",
      transport: "stdio",
      command: "node",
      args: ["./x.js"],
      sourceMessageId,
    });
    const at = new Date("2026-08-18T14:00:00.000Z");
    const twoHoursAgo = new Date(at.getTime() - 2 * 3_600_000);
    cacheCalendarEvents(
      db,
      connector.id,
      {
        events: [
          { id: "up", title: "Upcoming", starts_at: "2026-08-18T19:00:00Z" },
          {
            id: "done",
            title: "Ended",
            starts_at: "2026-08-18T10:00:00Z",
            ends_at: "2026-08-18T11:00:00Z",
          },
        ],
      },
      twoHoursAgo,
      calendarWindow(twoHoursAgo),
    );

    // The one-hour row TTL has passed: the fail-closed reader sees nothing…
    expect(cachedEvents(db, at)).toHaveLength(0);
    // …and the render-only reader still shows the last read, minus what already ended.
    expect(lastKnownEvents(db, at).map((event) => event.external_id)).toEqual(["up"]);
  });
});

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
  bindCapability,
  createConnector,
  recordConnectorVerification,
  setCapabilityEnabled,
  setConnectorEnabled,
} from "./connectors";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import {
  CHAT_COVERAGE_TTL_MS,
  cacheEmailThreads,
  cachedThreads,
  ensureFreshEmailCache,
  readEmailCoverage,
} from "./email-sync";

/**
 * The turn-start top-up: free when the cache is fresh, one bounded read when it is not, and
 * never an exception in the middle of somebody's chat turn.
 */
describe("keeping the inbox cache fresh enough for a turn", () => {
  let db: Db;
  let connectorId: number;

  function connectGmail(): void {
    const conversation = createConversation(db, { title: "Connections", source: "web" });
    const sourceMessageId = appendMessage(db, conversation.id, "user", "connect Gmail", {
      origin: "user_action",
      recallState: "blocked",
    }).id;
    const connector = createConnector(db, {
      label: "Gmail",
      transport: "stdio",
      command: "node",
      args: ["./gmail-server.js"],
      sourceMessageId,
    });
    connectorId = connector.id;
    recordConnectorVerification(db, connector.id, { status: "ready" });
    setConnectorEnabled(db, connector.id, true, sourceMessageId);
    const capability = bindCapability(db, {
      connectorId: connector.id,
      slot: "email.search_threads",
      remoteToolName: "search_threads",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, pageSize: { type: "integer" } },
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
      value: { threads: [] },
      text: JSON.stringify({ threads: [] }),
      isError: false,
    });
  });

  it("spends no connector call when the coverage is already fresh", async () => {
    connectGmail();
    const at = new Date();
    cacheEmailThreads(db, connectorId, { threads: [] }, at);

    await expect(ensureFreshEmailCache(db, { at })).resolves.toBe("fresh");
    expect(mocks.callCapability).not.toHaveBeenCalled();
  });

  it("reads once when the coverage has gone stale, and records the new proof", async () => {
    connectGmail();
    const at = new Date();
    const stale = new Date(at.getTime() - CHAT_COVERAGE_TTL_MS - 60_000);
    cacheEmailThreads(db, connectorId, { threads: [] }, stale);

    await expect(ensureFreshEmailCache(db, { at })).resolves.toBe("synced");
    expect(mocks.callCapability).toHaveBeenCalledOnce();
    expect(readEmailCoverage(db)?.fetchedAt).toBe(at.toISOString());
  });

  it("uses the JSON sitting in the tool text when structuredContent omitted the list", async () => {
    // The failure this replaces: Google's protobuf JSON leaves `threads` off an otherwise
    // successful response, Zeus prefers that empty structuredContent, and the standing inbox
    // reports unknown even though the messages were on the wire.
    connectGmail();
    mocks.callCapability.mockResolvedValue({
      value: {},
      text: JSON.stringify({
        threads: [
          {
            id: "t1",
            messages: [
              {
                subject: "Q3 planning",
                sender: "sarah@example.com",
                date: "2026-08-20",
                labelIds: ["INBOX"],
              },
            ],
          },
        ],
      }),
      isError: false,
    });

    await expect(ensureFreshEmailCache(db)).resolves.toBe("synced");
    expect(cachedThreads(db, new Date()).map((thread) => thread.id)).toEqual(["t1"]);
    expect(readEmailCoverage(db)?.threadCount).toBe(1);
  });

  it("degrades to a report, never an exception, when the read fails", async () => {
    connectGmail();
    mocks.callCapability.mockRejectedValue(new Error("boom"));

    await expect(ensureFreshEmailCache(db)).resolves.toBe("sync_failed");
    expect(readEmailCoverage(db)).toBeNull();
  });

  it("answers no_connector without touching the network when nothing is connected", async () => {
    await expect(ensureFreshEmailCache(db)).resolves.toBe("no_connector");
    expect(mocks.callCapability).not.toHaveBeenCalled();
    expect(mocks.restoreConnectorReachability).not.toHaveBeenCalled();
  });
});

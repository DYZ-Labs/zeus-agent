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
  syncEmail,
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

    await expect(ensureFreshEmailCache(db, { at })).resolves.toEqual({
      freshness: "fresh",
      failure: null,
    });
    expect(mocks.callCapability).not.toHaveBeenCalled();
  });

  it("reads once when the coverage has gone stale, and records the new proof", async () => {
    connectGmail();
    const at = new Date();
    const stale = new Date(at.getTime() - CHAT_COVERAGE_TTL_MS - 60_000);
    cacheEmailThreads(db, connectorId, { threads: [] }, stale);

    await expect(ensureFreshEmailCache(db, { at })).resolves.toEqual({
      freshness: "synced",
      failure: null,
    });
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

    await expect(ensureFreshEmailCache(db)).resolves.toMatchObject({ freshness: "synced" });
    expect(cachedThreads(db, new Date()).map((thread) => thread.id)).toEqual(["t1"]);
    expect(readEmailCoverage(db)?.threadCount).toBe(1);
  });

  it("degrades to a report, never an exception, when the read fails", async () => {
    connectGmail();
    mocks.callCapability.mockRejectedValue(new Error("boom"));

    await expect(ensureFreshEmailCache(db)).resolves.toEqual({
      freshness: "sync_failed",
      failure: { reason: "call_failed", code: null },
    });
    expect(readEmailCoverage(db)).toBeNull();
  });

  it("answers no_connector without touching the network when nothing is connected", async () => {
    await expect(ensureFreshEmailCache(db)).resolves.toEqual({
      freshness: "no_connector",
      failure: { reason: "no_connector", code: null },
    });
    expect(mocks.callCapability).not.toHaveBeenCalled();
    expect(mocks.restoreConnectorReachability).not.toHaveBeenCalled();
  });
});

/**
 * Naming the failure, which is the whole point of this pass.
 *
 * A read that does not happen used to be one indistinguishable `null`, so the only thing a
 * turn could say was that it had not succeeded — true of an inbox nobody asked for and of
 * one Google refused, and useless in both cases. Each of these is a different next step for
 * a different person, so each has to survive as far as the turn that reports it.
 */
describe("why an inbox read did not happen", () => {
  let db: Db;

  function connectGmail(): number {
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
    return connector.id;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = openTestDb();
    mocks.restoreConnectorReachability.mockResolvedValue(false);
  });

  it("keeps the code the broker put in front of its own refusal", async () => {
    connectGmail();
    mocks.callCapability.mockResolvedValue({
      value: null,
      text: "reconnect_required: Gmail must be reconnected",
      isError: true,
      truncated: false,
    });

    await expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "tool_error",
      code: "reconnect_required",
    });
    expect(readEmailCoverage(db)).toBeNull();
  });

  it("reports a refusal with no code of its own as a tool error all the same", async () => {
    connectGmail();
    mocks.callCapability.mockResolvedValue({
      value: null,
      text: "something went wrong",
      isError: true,
      truncated: false,
    });

    await expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "tool_error",
      code: null,
    });
  });

  it("separates running out of time from a service that simply refused to answer", async () => {
    connectGmail();
    mocks.callCapability.mockRejectedValue(new Error("aborted"));
    const signal = AbortSignal.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    await expect(syncEmail(db, { signal })).resolves.toEqual({
      ok: false,
      reason: "timed_out",
      code: null,
    });
  });

  it("refuses a reply that was cut rather than recording half of it", async () => {
    connectGmail();
    // The trap this closes: a sliced JSON document fails to parse exactly as a corrupt one
    // does, and a protobuf-empty `structuredContent` beside it looks like an empty inbox.
    // Either way the honest answer is that the read did not happen.
    mocks.callCapability.mockResolvedValue({
      value: {},
      text: '{"threads":[{"id":"t1","mess',
      isError: false,
      truncated: true,
    });

    await expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "response_truncated",
      code: null,
    });
    expect(readEmailCoverage(db)).toBeNull();
  });

  it("still reads a cut reply when the structured half carried the whole list", async () => {
    connectGmail();
    mocks.callCapability.mockResolvedValue({
      value: { threads: [{ id: "t1", messages: [{ date: "2026-08-20" }] }] },
      text: "…a very long rendering that the cap cut",
      truncated: true,
      isError: false,
    });

    await expect(syncEmail(db)).resolves.toMatchObject({ ok: true });
    expect(readEmailCoverage(db)?.threadCount).toBe(1);
  });

  it("names a reply it cannot read as unreadable, not as an empty inbox", async () => {
    connectGmail();
    mocks.callCapability.mockResolvedValue({
      value: "Here are your five most recent conversations!",
      text: "Here are your five most recent conversations!",
      isError: false,
      truncated: false,
    });

    await expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "response_unreadable",
      code: null,
    });
    expect(readEmailCoverage(db)).toBeNull();
  });

  it("refuses a search contract it cannot put a bound on, before dispatching anything", async () => {
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
    recordConnectorVerification(db, connector.id, { status: "ready" });
    setConnectorEnabled(db, connector.id, true, sourceMessageId);
    const capability = bindCapability(db, {
      connectorId: connector.id,
      slot: "email.search_threads",
      remoteToolName: "search_threads",
      // No `query`, so there is no way to ask for one week rather than one mailbox.
      inputSchema: { type: "object", properties: { pageSize: { type: "integer" } } },
      sourceMessageId,
    });
    setCapabilityEnabled(db, capability.id, true, sourceMessageId);

    await expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "unsupported_contract",
      code: null,
    });
    expect(mocks.callCapability).not.toHaveBeenCalled();
  });

  it("counts a hosted Gmail row whose slots were never bound as a connector", () => {
    // Reached whenever the OAuth callback verifies the connection and then fails to
    // configure it. The capabilities block calls that connected, so this must too, or the
    // turn renders a block denying the inbox its own header affirms.
    const conversation = createConversation(db, { title: "Connections", source: "web" });
    const sourceMessageId = appendMessage(db, conversation.id, "user", "connect Gmail", {
      origin: "user_action",
      recallState: "blocked",
    }).id;
    db.exec(`
      INSERT INTO connector (label, provider, provider_connection_id, transport, url,
                             source_message_id, status, enabled, created_at, updated_at)
      VALUES ('Gmail', 'google_gmail', '12345678-1234-1234-1234-123456789abc', 'http',
              'https://broker.test/gmail/mcp/12345678-1234-1234-1234-123456789abc',
              ${sourceMessageId}, 'ready', 1, '2026-08-20T00:00:00.000Z',
              '2026-08-20T00:00:00.000Z');
    `);

    return expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "capability_unavailable",
      code: null,
    });
  });

  it("tells a connector that cannot serve a read apart from no connector at all", async () => {
    await expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "no_connector",
      code: null,
    });

    const connectorId = connectGmail();
    recordConnectorVerification(db, connectorId, {
      status: "unreachable",
      errorCode: "provider_unavailable",
    });

    await expect(syncEmail(db)).resolves.toEqual({
      ok: false,
      reason: "capability_unavailable",
      code: null,
    });
  });
});

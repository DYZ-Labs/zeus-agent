import { beforeEach, describe, expect, it } from "vitest";

import {
  availableCapability,
  availableEffectKinds,
  bindCapability,
  connectorEnvironment,
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
  recordConnectorVerification,
  setCapabilityEnabled,
  setConnectorEnabled,
  toolSchemaHash,
} from "./connectors";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";

let db: Db;
let userMessageId: number;

beforeEach(() => {
  db = openTestDb();
  const conversation = createConversation(db, { title: "Connections", source: "web" });
  userMessageId = appendMessage(db, conversation.id, "user", "connect my calendar", {
    origin: "user_action",
    recallState: "blocked",
  }).id;
});

function stdioConnector(overrides: Partial<Parameters<typeof createConnector>[1]> = {}) {
  return createConnector(db, {
    label: "Calendar",
    transport: "stdio",
    command: "node",
    args: ["./calendar-server.js"],
    sourceMessageId: userMessageId,
    ...overrides,
  });
}

function readyAndEnabled(connectorId: number): void {
  recordConnectorVerification(db, connectorId, { status: "ready" });
  setConnectorEnabled(db, connectorId, true, userMessageId);
}

describe("connectors hold configuration, never credentials", () => {
  it("refuses a secret pasted where an environment variable name belongs", () => {
    expect(() =>
      stdioConnector({ envVarNames: ["ya29.a0AfB_bySecretAccessToken"] }),
    ).toThrow(/names only, never values/u);
    expect(() => stdioConnector({ envVarNames: ["Bearer abc"] })).toThrow(/names only/u);

    const connector = stdioConnector({ envVarNames: ["CALENDAR_TOKEN"] });
    expect(connector.envVarNames).toEqual(["CALENDAR_TOKEN"]);
  });

  it("stores no column that could hold a credential value", () => {
    process.env.CALENDAR_TOKEN = "super-secret-value";
    try {
      const connector = stdioConnector({ envVarNames: ["CALENDAR_TOKEN"] });
      const row = db
        .prepare("SELECT * FROM connector WHERE id = ?")
        .get(connector.id) as Record<string, unknown>;

      expect(JSON.stringify(row)).not.toContain("super-secret-value");
      // The value is reachable only by reading the live environment, on demand.
      expect(connectorEnvironment(connector)).toEqual({
        CALENDAR_TOKEN: "super-secret-value",
      });
    } finally {
      delete process.env.CALENDAR_TOKEN;
    }
  });

  it("refuses a command that is really a shell line", () => {
    expect(() => stdioConnector({ command: "node server.js; curl evil.example" })).toThrow(
      /executable, not a shell line/u,
    );
    expect(() => stdioConnector({ command: "node $(whoami)" })).toThrow(/executable/u);
  });

  it("refuses cleartext http except on this machine", () => {
    const http = () =>
      createConnector(db, {
        label: "Remote",
        transport: "http",
        url: "http://calendar.example.com/mcp",
        sourceMessageId: userMessageId,
      });
    expect(http).toThrow(/must use https/u);

    expect(
      createConnector(db, {
        label: "Local",
        transport: "http",
        url: "http://127.0.0.1:8931/mcp",
        sourceMessageId: userMessageId,
      }).url,
    ).toContain("127.0.0.1");
    expect(
      createConnector(db, {
        label: "Hosted",
        transport: "http",
        url: "https://calendar.example.com/mcp",
        sourceMessageId: userMessageId,
      }).url,
    ).toContain("https://");
  });

  it("requires a stored user message as provenance", () => {
    const conversation = createConversation(db, { title: "Chat", source: "web" });
    const assistant = appendMessage(db, conversation.id, "assistant", "I connected it");
    expect(() => stdioConnector({ sourceMessageId: assistant.id })).toThrow(
      /stored user message/u,
    );
  });
});

describe("capability binding is a deliberate, reviewable grant", () => {
  it("takes its effect kind from the slot and starts disabled", () => {
    const connector = stdioConnector();
    const capability = bindCapability(db, {
      connectorId: connector.id,
      slot: "calendar.create_event",
      remoteToolName: "create_event",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      sourceMessageId: userMessageId,
    });

    // The remote cannot name its own effect: the slot decides.
    expect(capability.effect_kind).toBe("schedule");
    expect(capability.enabled).toBe(0);
    expect(capability.schema_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("hashes a schema independently of key order", () => {
    expect(toolSchemaHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      toolSchemaHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(toolSchemaHash({ a: 1 })).not.toBe(toolSchemaHash({ a: 2 }));
  });

  it("revokes the grant when a slot is rebound to a different tool", () => {
    const connector = stdioConnector();
    bindCapability(db, {
      connectorId: connector.id,
      slot: "calendar.create_event",
      remoteToolName: "create_event",
      inputSchema: { type: "object" },
      sourceMessageId: userMessageId,
    });
    readyAndEnabled(connector.id);
    const capability = getConnector(db, connector.id)?.capabilities[0];
    if (!capability) throw new Error("capability missing");
    setCapabilityEnabled(db, capability.id, true, userMessageId);
    expect(availableCapability(db, "calendar.create_event")).not.toBeNull();

    bindCapability(db, {
      connectorId: connector.id,
      slot: "calendar.create_event",
      remoteToolName: "create_event_v2",
      inputSchema: { type: "object" },
      sourceMessageId: userMessageId,
    });

    expect(availableCapability(db, "calendar.create_event")).toBeNull();
  });
});

describe("availability is the whole permission answer", () => {
  function boundAndEnabled(): number {
    const connector = stdioConnector();
    bindCapability(db, {
      connectorId: connector.id,
      slot: "calendar.list_events",
      remoteToolName: "list_events",
      inputSchema: { type: "object" },
      sourceMessageId: userMessageId,
    });
    readyAndEnabled(connector.id);
    const capability = getConnector(db, connector.id)?.capabilities[0];
    if (!capability) throw new Error("capability missing");
    setCapabilityEnabled(db, capability.id, true, userMessageId);
    return connector.id;
  }

  it("needs a verified, enabled connector and an enabled capability", () => {
    const connectorId = boundAndEnabled();
    expect(availableCapability(db, "calendar.list_events")).not.toBeNull();
    expect(availableEffectKinds(db)).toEqual(["external_read"]);

    setConnectorEnabled(db, connectorId, false, userMessageId);
    expect(availableCapability(db, "calendar.list_events")).toBeNull();
    expect(availableEffectKinds(db)).toEqual([]);
  });

  it("refuses to enable a connector that has not verified", () => {
    const connector = stdioConnector();
    expect(() => setConnectorEnabled(db, connector.id, true, userMessageId)).toThrow(
      /must verify/u,
    );
  });

  it("withdraws every grant when the connector stops answering", () => {
    const connectorId = boundAndEnabled();

    recordConnectorVerification(db, connectorId, {
      status: "unreachable",
      errorCode: "handshake_failed",
    });

    const connector = getConnector(db, connectorId);
    expect(connector?.enabled).toBe(0);
    expect(connector?.capabilities.every((entry) => entry.enabled === 0)).toBe(true);
    expect(availableCapability(db, "calendar.list_events")).toBeNull();
  });

  it("treats a missing environment variable as unavailable rather than trying", () => {
    const connector = stdioConnector({ envVarNames: ["ZEUS_TEST_ABSENT_TOKEN"] });
    bindCapability(db, {
      connectorId: connector.id,
      slot: "calendar.list_events",
      remoteToolName: "list_events",
      inputSchema: { type: "object" },
      sourceMessageId: userMessageId,
    });
    readyAndEnabled(connector.id);
    const capability = getConnector(db, connector.id)?.capabilities[0];
    if (!capability) throw new Error("capability missing");
    setCapabilityEnabled(db, capability.id, true, userMessageId);

    expect(availableCapability(db, "calendar.list_events")).toBeNull();
  });

  it("removes capabilities with the connector", () => {
    const connectorId = boundAndEnabled();

    expect(deleteConnector(db, connectorId)).toBe(true);
    expect(listConnectors(db)).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM connector_capability").get(),
    ).toEqual({ count: 0 });
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  assertPresetConnectorConfiguration,
  availableCapability,
  availableEffectKinds,
  bindCapability,
  configureConnectorPreset,
  connectorEnvironment,
  createConnector,
  deleteConnector,
  getConnector,
  getConnectorByPresetId,
  listConnectors,
  recordConnectorVerification,
  setCapabilityEnabled,
  setConnectorEnabled,
  toolSchemaHash,
} from "./connectors";
import { GOOGLE_CALENDAR_MCP_URL } from "./connector-catalog";
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

  it("keeps manual connectors outside catalog authentication", () => {
    const connector = stdioConnector();
    expect(connector.preset_id).toBeNull();
    expect(assertPresetConnectorConfiguration(connector)).toBeNull();
  });
});

describe("guided connector presets", () => {
  const discoveredTools = [
    discoveredTool("list_events", { type: "object", properties: { timeMin: { type: "string" } } }),
    discoveredTool("create_event", { type: "object", properties: { summary: { type: "string" } } }),
    discoveredTool("update_event", { type: "object", properties: { eventId: { type: "string" } } }),
  ];

  it("creates one sourced, verified, read-only connection from live discovery", () => {
    const connector = configureConnectorPreset(db, {
      presetId: "google-calendar-official",
      selectedSlots: ["calendar.list_events"],
      discoveredTools,
      sourceMessageId: userMessageId,
    });

    expect(connector.preset_id).toBe("google-calendar-official");
    expect(connector.url).toBe(GOOGLE_CALENDAR_MCP_URL);
    expect(connector.status).toBe("ready");
    expect(connector.enabled).toBe(1);
    expect(connector.envVarNames).toEqual([]);
    expect(connector.capabilities).toMatchObject([
      {
        slot: "calendar.list_events",
        remote_tool_name: "list_events",
        effect_kind: "external_read",
        enabled: 1,
        source_message_id: userMessageId,
      },
    ]);
    expect(getConnectorByPresetId(db, "google-calendar-official")?.id).toBe(connector.id);
  });

  it("rejects unknown presets, empty permissions, duplicates, and modified destinations", () => {
    expect(() =>
      configureConnectorPreset(db, {
        presetId: "unknown",
        selectedSlots: ["calendar.list_events"],
        discoveredTools,
        sourceMessageId: userMessageId,
      }),
    ).toThrow(/not available/u);
    expect(() =>
      configureConnectorPreset(db, {
        presetId: "google-calendar-official",
        selectedSlots: [],
        discoveredTools,
        sourceMessageId: userMessageId,
      }),
    ).toThrow(/at least one/u);

    const connector = configureConnectorPreset(db, {
      presetId: "google-calendar-official",
      selectedSlots: ["calendar.list_events"],
      discoveredTools,
      sourceMessageId: userMessageId,
    });
    expect(() =>
      configureConnectorPreset(db, {
        presetId: "google-calendar-official",
        selectedSlots: ["calendar.list_events"],
        discoveredTools,
        sourceMessageId: userMessageId,
      }),
    ).toThrow(/already connected/u);

    db.prepare("UPDATE connector SET url = 'https://attacker.example/mcp' WHERE id = ?")
      .run(connector.id);
    expect(() =>
      assertPresetConnectorConfiguration(getConnector(db, connector.id)!),
    ).toThrow(/trusted catalog/u);
  });

  it("updates the complete permission set while preserving disabled bindings", () => {
    const connector = configureConnectorPreset(db, {
      presetId: "google-calendar-official",
      selectedSlots: ["calendar.list_events"],
      discoveredTools,
      sourceMessageId: userMessageId,
    });
    const conversation = createConversation(db, { title: "Permission update", source: "web" });
    const updateSource = appendMessage(
      db,
      conversation.id,
      "user",
      "allow creating and updating events",
      { origin: "user_action", recallState: "blocked" },
    );

    const updated = configureConnectorPreset(db, {
      presetId: "google-calendar-official",
      connectorId: connector.id,
      selectedSlots: ["calendar.create_event", "calendar.update_event"],
      discoveredTools,
      sourceMessageId: updateSource.id,
    });
    const bySlot = new Map(updated.capabilities.map((capability) => [capability.slot, capability]));
    expect(bySlot.get("calendar.list_events")?.enabled).toBe(0);
    expect(bySlot.get("calendar.list_events")?.source_message_id).toBe(updateSource.id);
    expect(bySlot.get("calendar.create_event")?.enabled).toBe(1);
    expect(bySlot.get("calendar.update_event")?.enabled).toBe(1);
    expect(updated.source_message_id).toBe(updateSource.id);
  });

  it("refuses to silently accept drift in an existing live schema", () => {
    const connector = configureConnectorPreset(db, {
      presetId: "google-calendar-official",
      selectedSlots: ["calendar.list_events"],
      discoveredTools,
      sourceMessageId: userMessageId,
    });
    const drifted = [
      discoveredTool("list_events", { type: "object", properties: { changed: { type: "boolean" } } }),
    ];
    expect(() =>
      configureConnectorPreset(db, {
        presetId: "google-calendar-official",
        connectorId: connector.id,
        selectedSlots: ["calendar.list_events"],
        discoveredTools: drifted,
        sourceMessageId: userMessageId,
      }),
    ).toThrow(/changed a selected tool contract/u);
    expect(getConnector(db, connector.id)?.capabilities[0]?.enabled).toBe(1);
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

function discoveredTool(name: string, inputSchema: unknown) {
  return {
    name,
    description: null,
    inputSchema,
    schemaHash: toolSchemaHash(inputSchema),
    readOnlyHint: name === "list_events" ? true : false,
  };
}

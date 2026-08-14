import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertPresetConnectorConfiguration,
  availableCapability,
  availableEffectKinds,
  bindCapability,
  configureConnectorPreset,
  configureGoogleCalendarCapabilities,
  connectorEnvironment,
  createConnector,
  deleteConnector,
  deleteGoogleCalendarConnector,
  GOOGLE_CALENDAR_BROKER_SERVICE_KEY,
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  getConnector,
  getConnectorByPresetId,
  getGoogleCalendarConnector,
  listConnectors,
  recordConnectorVerification,
  setCapabilityEnabled,
  setConnectorEnabled,
  toolSchemaHash,
  upsertGoogleCalendarConnector,
} from "./connectors";
import { GOOGLE_CALENDAR_MCP_URL } from "./connector-catalog";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import { MIGRATIONS } from "./migrations";
import { bindAppOwner } from "./owner";
import type { WorkPlanProposal } from "./schema";
import {
  authorizeWorkPlan,
  createWorkPlan,
  listToolReceipts,
  runWorkPlan,
} from "./work-plans";

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

  it("reserves the broker service key from user-configured connectors", () => {
    expect(() =>
      stdioConnector({ envVarNames: [GOOGLE_CALENDAR_BROKER_SERVICE_KEY] }),
    ).toThrow(/reserved for a system-managed provider/u);
  });

  it("lets a connector borrow the environment only where it belongs to the user", () => {
    // One person running Zeus: the process environment is their own, and naming a variable
    // is simply how their own server is given its own token.
    expect(stdioConnector({ envVarNames: ["CALENDAR_TOKEN"] }).envVarNames).toEqual([
      "CALENDAR_TOKEN",
    ]);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    try {
      // Hosted, that same environment is the operator's. The mechanism is refused rather
      // than screened, so a name nobody thought to reserve is refused with the rest —
      // including one that looks entirely innocent next to the deployment's own secrets.
      for (const name of ["OPENAI_API_KEY", "STRIPE_SECRET_KEY", "CALENDAR_TOKEN"]) {
        expect(() =>
          createConnector(db, {
            label: `Hosted service for ${name}`,
            transport: "http",
            url: "https://calendar.example.com/mcp",
            envVarNames: [name],
            sourceMessageId: userMessageId,
          }),
        ).toThrow(/cannot borrow this deployment's environment variables/u);
      }

      // A connector that needs nothing from the environment is still perfectly ordinary.
      expect(
        createConnector(db, {
          label: "Hosted service",
          transport: "http",
          url: "https://calendar.example.com/mcp",
          sourceMessageId: userMessageId,
        }).envVarNames,
      ).toEqual([]);
    } finally {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
  });

  it("resolves nothing for a row configured before the store became one of many", () => {
    // Written while one person ran Zeus, which is when naming these was allowed. The store
    // is later opened by a hosted deployment — the case a create-time check cannot reach.
    const connector = stdioConnector({ envVarNames: ["CALENDAR_TOKEN"] });
    db.prepare("UPDATE connector SET env_var_names_json = ? WHERE id = ?").run(
      JSON.stringify(["CALENDAR_TOKEN", "OPENAI_API_KEY"]),
      connector.id,
    );
    const stored = getConnector(db, connector.id);
    if (!stored) throw new Error("connector missing");

    const operatorEnvironment = {
      CALENDAR_TOKEN: "service-token",
      OPENAI_API_KEY: "sk-the-deployments-own-key",
    };

    // Locally the names still resolve: this is the user's own environment.
    expect(connectorEnvironment(stored, operatorEnvironment)).toEqual(operatorEnvironment);

    // Hosted, the names stay visible as configuration and resolve to nothing at all.
    expect(
      connectorEnvironment(stored, {
        ...operatorEnvironment,
        NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      }),
    ).toEqual({});
    expect(stored.envVarNames).toContain("OPENAI_API_KEY");
  });

  it("refuses a connector that runs a command on a multi-account deployment", () => {
    expect(stdioConnector().transport).toBe("stdio");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    try {
      expect(() => stdioConnector()).toThrow(/only when you run Zeus yourself/u);
      // Nothing is spawned for an https connector, so hosted mode still allows one.
      expect(
        createConnector(db, {
          label: "Hosted",
          transport: "http",
          url: "https://calendar.example.com/mcp",
          sourceMessageId: userMessageId,
        }).transport,
      ).toBe("http");
    } finally {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }

    expect(stdioConnector().transport).toBe("stdio");
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

describe("the first-party Google Calendar provider", () => {
  it("upgrades existing connector rows as generic without changing old migrations", () => {
    const providerMigrationIndex = MIGRATIONS.findIndex(
      (migration) => migration.id === "025_google_calendar_provider",
    );
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, providerMigrationIndex)) {
      legacy.exec(migration.sql);
    }
    const conversation = createConversation(legacy, { title: "Legacy", source: "web" });
    const source = appendMessage(legacy, conversation.id, "user", "Connect a service", {
      origin: "user_action",
      recallState: "blocked",
    });
    const timestamp = new Date().toISOString();
    const inserted = legacy.prepare(
      `INSERT INTO connector
         (label, transport, command, args_json, cwd, url, env_var_names_json,
          discovered_tools_json, status, enabled, source_message_id, created_at, updated_at)
       VALUES ('Legacy calendar', 'stdio', 'node', '[]', NULL, NULL, '[]', '[]',
               'unverified', 0, ?, ?, ?)`,
    ).run(source.id, timestamp, timestamp);

    expect(MIGRATIONS[providerMigrationIndex]?.id).toBe("025_google_calendar_provider");
    legacy.exec(MIGRATIONS[providerMigrationIndex]!.sql);
    expect(getConnector(legacy, Number(inserted.lastInsertRowid))).toMatchObject({
      provider: "generic",
      provider_connection_id: null,
    });
    legacy.close();
  });

  it("stores only an opaque broker connection and derives capabilities from OAuth scopes", () => {
    process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY] = "a".repeat(40);
    try {
      bindAppOwner(db, { supabaseUserId: randomUUID(), email: "owner@example.com" });
      const connectionId = randomUUID();
      const connector = upsertGoogleCalendarConnector(db, {
        connectionId,
        mcpUrl: `https://calendar-dev.zeusagent.dev/mcp/${connectionId}`,
        sourceMessageId: userMessageId,
      });
      expect(connector).toMatchObject({
        provider: "google_calendar",
        provider_connection_id: connectionId,
        envVarNames: [],
      });
      expect(JSON.stringify(
        db.prepare("SELECT * FROM connector WHERE id = ?").get(connector.id),
      )).not.toContain("a".repeat(40));

      const tools = [
        tool("list_events", true),
        tool("create_event", false),
        tool("update_event", false),
      ];
      recordConnectorVerification(db, connector.id, { status: "ready", tools });
      configureGoogleCalendarCapabilities(db, {
        connectorId: connector.id,
        tools,
        scopes: [GOOGLE_CALENDAR_READ_SCOPE],
        sourceMessageId: userMessageId,
      });
      expect(getConnector(db, connector.id)?.capabilities.map((entry) => entry.slot)).toEqual([
        "calendar.list_events",
      ]);

      configureGoogleCalendarCapabilities(db, {
        connectorId: connector.id,
        tools,
        scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE],
        sourceMessageId: userMessageId,
      });
      expect(
        getConnector(db, connector.id)?.capabilities.map((entry) => entry.slot).sort(),
      ).toEqual([
        "calendar.create_event",
        "calendar.list_events",
        "calendar.update_event",
      ]);
    } finally {
      delete process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY];
    }
  });

  it("preserves a read receipt when write permission adds capabilities", async () => {
    process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY] = "d".repeat(40);
    try {
      const connector = upsertGoogleCalendarConnector(db, {
        connectionId: randomUUID(),
        mcpUrl: "https://calendar.zeusagent.dev/mcp/connection",
        sourceMessageId: userMessageId,
      });
      const tools = [
        tool("list_events", true),
        tool("create_event", false),
        tool("update_event", false),
      ];
      recordConnectorVerification(db, connector.id, { status: "ready", tools });
      configureGoogleCalendarCapabilities(db, {
        connectorId: connector.id,
        tools,
        scopes: [GOOGLE_CALENDAR_READ_SCOPE],
        sourceMessageId: userMessageId,
      });
      const readCapability = availableCapability(db, "calendar.list_events")?.capability;
      if (!readCapability) throw new Error("read capability missing");

      const proposal: WorkPlanProposal = {
        objective: "Read tomorrow's calendar",
        steps: [{
          title: "Read calendar",
          instruction: "Read the connected calendar.",
          effect_kind: "external_read",
          depends_on: [],
        }],
        allowed_effects: ["external_read"],
        completion_criteria: ["Calendar data was returned as an external artifact."],
        limits: {
          max_model_tool_calls: 2,
          max_retries_per_step: 0,
          max_duration_seconds: 60,
        },
      };
      const plan = createWorkPlan(db, {
        proposal,
        sourceMessageId: userMessageId,
        origin: "explicit_request",
      });
      authorizeWorkPlan(db, plan.plan.id, {
        planHash: plan.plan.plan_hash,
        authorizationKind: "explicit_request",
        allowedEffects: proposal.allowed_effects,
        maxModelToolCalls: plan.plan.max_model_tool_calls,
        maxRetriesPerStep: plan.plan.max_retries_per_step,
        maxDurationSeconds: plan.plan.max_duration_seconds,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        sourceMessageId: userMessageId,
      });
      const run = await runWorkPlan(db, plan.plan.id, {
        executor: async (input) => ({
          output: { event_count: 0 },
          artifacts: [{
            kind: "research_notes",
            title: input.step.title,
            content: "External calendar data — no events.",
            citations: [],
          }],
          toolCalls: 1,
          modelCalls: 0,
        }),
      });
      expect(listToolReceipts(db, run.id)[0]?.connector_capability_id).toBe(readCapability.id);

      const upgradeSource = appendMessage(
        db,
        createConversation(db, { title: "Permission upgrade", source: "web" }).id,
        "user",
        "Allow Google Calendar changes.",
        { origin: "user_action", recallState: "blocked" },
      );
      const upgraded = configureGoogleCalendarCapabilities(db, {
        connectorId: connector.id,
        tools,
        scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE],
        sourceMessageId: upgradeSource.id,
      });

      expect(
        upgraded.capabilities.find((capability) => capability.slot === "calendar.list_events")?.id,
      ).toBe(readCapability.id);
      expect(upgraded.capabilities.filter((capability) => capability.enabled === 1)).toHaveLength(3);
      expect(listToolReceipts(db, run.id)[0]?.connector_capability_id).toBe(readCapability.id);
    } finally {
      delete process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY];
    }
  });

  it("cannot be rebound or removed through generic connector actions", () => {
    process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY] = "b".repeat(40);
    try {
      const connector = upsertGoogleCalendarConnector(db, {
        connectionId: randomUUID(),
        mcpUrl: "https://calendar-dev.zeusagent.dev/mcp/connection",
        sourceMessageId: userMessageId,
      });
      expect(() => bindCapability(db, {
        connectorId: connector.id,
        slot: "calendar.list_events",
        remoteToolName: "not_the_provider_tool",
        inputSchema: {},
        sourceMessageId: userMessageId,
      })).toThrow(/verified OAuth grant/u);
      expect(deleteConnector(db, connector.id)).toBe(false);
      expect(getGoogleCalendarConnector(db)?.id).toBe(connector.id);
      expect(deleteGoogleCalendarConnector(db, connector.id)).toBe(true);
    } finally {
      delete process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY];
    }
  });

  it("uses the hosted provider when a legacy local preset also exists", () => {
    const local = configureConnectorPreset(db, {
      presetId: "google-calendar-official",
      selectedSlots: ["calendar.list_events"],
      discoveredTools: [
        discoveredTool("list_events", {
          type: "object",
          properties: { timeMin: { type: "string" } },
        }),
      ],
      sourceMessageId: userMessageId,
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY] = "c".repeat(40);
    try {
      bindAppOwner(db, { supabaseUserId: randomUUID(), email: "owner@example.com" });
      const provider = upsertGoogleCalendarConnector(db, {
        connectionId: randomUUID(),
        mcpUrl: "https://calendar.zeusagent.dev/mcp/connection",
        sourceMessageId: userMessageId,
      });
      const tools = [tool("list_events", true)];
      recordConnectorVerification(db, provider.id, { status: "ready", tools });
      configureGoogleCalendarCapabilities(db, {
        connectorId: provider.id,
        tools,
        scopes: [GOOGLE_CALENDAR_READ_SCOPE],
        sourceMessageId: userMessageId,
      });

      expect(local.id).toBeLessThan(provider.id);
      expect(availableCapability(db, "calendar.list_events")?.connector.id).toBe(provider.id);
    } finally {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY];
    }
  });
});

function tool(name: string, readOnlyHint: boolean) {
  const inputSchema = { type: "object", properties: {} };
  return {
    name,
    description: null,
    inputSchema,
    schemaHash: toolSchemaHash(inputSchema),
    readOnlyHint,
  };
}

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

  it("stops offering a stored command connector once the deployment is hosted", () => {
    boundAndEnabled();
    expect(availableCapability(db, "calendar.list_events")).not.toBeNull();

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    try {
      expect(availableCapability(db, "calendar.list_events")).toBeNull();
      expect(availableEffectKinds(db)).toEqual([]);
    } finally {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
  });

  it("treats a missing environment variable as unavailable rather than trying", () => {
    const connector = stdioConnector({ envVarNames: ["ABSENT_CALENDAR_TOKEN"] });
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

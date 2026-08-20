import { createRequire } from "node:module";
import { GOOGLE_CALENDAR_PRESET } from "./connector-catalog";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  availableCapability,
  bindCapability,
  createConnector,
  getConnector,
  setCapabilityEnabled,
  setConnectorEnabled,
} from "./connectors";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import {
  ConnectorError,
  callCapability,
  googleAdcHeaders,
  restoreConnectorReachability,
  revalidateCapabilitySchemas,
  verifyConnector,
} from "./mcp-client";

/**
 * These spawn a real stdio MCP server rather than injecting a fake transport. The parts
 * most worth protecting — that the child is launched without a shell, that it receives
 * only the environment variables the user named, and that a changed remote schema
 * withdraws the grant — only exist on the real path.
 */

let db: Db;
let userMessageId: number;
let directory: string;

// The fake server runs from a temp directory, where bare specifiers cannot resolve, so
// its imports are absolute file URLs into this repository's installed packages.
const require = createRequire(import.meta.url);
const moduleUrl = (specifier: string): string =>
  pathToFileURL(require.resolve(specifier)).href;

const CALENDAR_SERVER = `
import { McpServer } from "${moduleUrl("@modelcontextprotocol/sdk/server/mcp.js")}";
import { StdioServerTransport } from "${moduleUrl("@modelcontextprotocol/sdk/server/stdio.js")}";
import { z } from "${moduleUrl("zod")}";

const server = new McpServer({ name: "fake-calendar", version: "0.0.1" });

server.registerTool(
  "list_events",
  {
    title: "List events",
    inputSchema: { from: z.string(), to: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ from, to }) => ({
    content: [{ type: "text", text: JSON.stringify({ from, to, events: [{ id: "evt-1" }] }) }],
  }),
);

server.registerTool(
  "create_event",
  { title: "Create event", inputSchema: { title: z.string() } },
  async ({ title }) => ({
    content: [{ type: "text", text: JSON.stringify({ created: title }) }],
  }),
);

// Reports exactly what the parent handed it, so a test can assert the allowlist.
server.registerTool(
  "echo_environment",
  { title: "Echo environment", inputSchema: {} },
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        named: process.env.FAKE_CALENDAR_TOKEN ?? null,
        unrelated: process.env.FAKE_UNRELATED_SECRET ?? null,
      }),
    }],
  }),
);

await server.connect(new StdioServerTransport());
`;

// The same server, answering list_events with more text than Zeus will hold.
const OVERSIZED_SERVER = CALENDAR_SERVER.replace(
  'text: JSON.stringify({ from, to, events: [{ id: "evt-1" }] })',
  'text: JSON.stringify({ from, to, events: [{ id: "evt-1", note: "x".repeat(1_100_000) }] })',
);

// The same server with one field added to list_events, i.e. a remote that changed its
// contract after the user reviewed it.
const DRIFTED_SERVER = CALENDAR_SERVER.replace(
  "inputSchema: { from: z.string(), to: z.string() },",
  "inputSchema: { from: z.string(), to: z.string(), calendar: z.string() },",
);

beforeEach(() => {
  db = openTestDb();
  const conversation = createConversation(db, { title: "Connections", source: "web" });
  userMessageId = appendMessage(db, conversation.id, "user", "connect my calendar", {
    origin: "user_action",
    recallState: "blocked",
  }).id;
  directory = mkdtempSync(join(tmpdir(), "zeus-connector-test-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  delete process.env.FAKE_CALENDAR_TOKEN;
  delete process.env.FAKE_UNRELATED_SECRET;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
});

function calendarConnector(
  source = CALENDAR_SERVER,
  envVarNames: readonly string[] = [],
): number {
  const scriptPath = join(directory, "calendar-server.mjs");
  writeFileSync(scriptPath, source, { mode: 0o600 });
  return createConnector(db, {
    label: "Fake calendar",
    transport: "stdio",
    command: process.execPath,
    args: [scriptPath],
    // Resolve the SDK from the repository this test runs in.
    cwd: process.cwd(),
    envVarNames,
    sourceMessageId: userMessageId,
  }).id;
}

async function grant(connectorId: number, slot: Parameters<typeof bindCapability>[1]["slot"], tool: string) {
  const { tools } = await verifyConnector(db, connectorId);
  const discovered = tools.find((entry) => entry.name === tool);
  if (!discovered) throw new Error(`fake server did not expose ${tool}`);
  bindCapability(db, {
    connectorId,
    slot,
    remoteToolName: tool,
    inputSchema: discovered.inputSchema,
    sourceMessageId: userMessageId,
  });
  setConnectorEnabled(db, connectorId, true, userMessageId);
  const capability = getConnector(db, connectorId)?.capabilities.find(
    (entry) => entry.slot === slot,
  );
  if (!capability) throw new Error("capability missing after binding");
  setCapabilityEnabled(db, capability.id, true, userMessageId);
  return capability;
}

describe("reaching a connected service", () => {
  it("verifies a real server and records what it offers", async () => {
    const connectorId = calendarConnector();

    const { connector, tools } = await verifyConnector(db, connectorId);

    expect(connector.status).toBe("ready");
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_event",
      "echo_environment",
      "list_events",
    ]);
    expect(tools.find((tool) => tool.name === "list_events")?.readOnlyHint).toBe(true);
  }, 30_000);

  it("calls the bound remote tool for a slot", async () => {
    const connectorId = calendarConnector();
    await grant(connectorId, "calendar.list_events", "list_events");

    const result = await callCapability(db, "calendar.list_events", {
      from: "2026-08-14",
      to: "2026-08-21",
    });

    expect(result.isError).toBe(false);
    expect(result.value).toEqual({
      from: "2026-08-14",
      to: "2026-08-21",
      events: [{ id: "evt-1" }],
    });
  }, 30_000);

  it("hands the child only the environment variables the user named", async () => {
    process.env.FAKE_CALENDAR_TOKEN = "named-value";
    process.env.FAKE_UNRELATED_SECRET = "must-not-leak";
    const connectorId = calendarConnector(CALENDAR_SERVER, ["FAKE_CALENDAR_TOKEN"]);
    await grant(connectorId, "calendar.list_events", "echo_environment");

    const result = await callCapability(db, "calendar.list_events", {});

    expect(result.value).toEqual({ named: "named-value", unrelated: null });
  }, 30_000);

  it("refuses a slot no enabled capability provides", async () => {
    const connectorId = calendarConnector();
    await verifyConnector(db, connectorId);

    await expect(
      callCapability(db, "calendar.create_event", { title: "Dinner" }),
    ).rejects.toThrow(/No connected service currently provides/u);
  }, 30_000);

  it("brings a connection back after the server starts answering again", async () => {
    const connectorId = calendarConnector();
    await grant(connectorId, "calendar.list_events", "list_events");
    // The server stops answering while it is out of service. Before this, that was the end
    // of the connection: nothing on any path re-verified it, so every later turn reported a
    // calendar the user had plainly connected as one that could not be used.
    writeFileSync(join(directory, "calendar-server.mjs"), "process.exit(1);", { mode: 0o600 });
    await expect(verifyConnector(db, connectorId)).rejects.toBeInstanceOf(ConnectorError);
    expect(availableCapability(db, "calendar.list_events")).toBeNull();
    // The grant itself is untouched, which is what makes an unattended recovery legitimate.
    expect(getConnector(db, connectorId)?.capabilities[0]?.enabled).toBe(1);

    // The user's grant survived the outage, so there is something to restore.
    expect(await restoreConnectorReachability(db, "calendar.list_events")).toBe(false);
    writeFileSync(join(directory, "calendar-server.mjs"), CALENDAR_SERVER, { mode: 0o600 });
    expect(await restoreConnectorReachability(db, "calendar.list_events")).toBe(true);

    const result = await callCapability(db, "calendar.list_events", { from: "a", to: "b" });
    expect(result.isError).toBe(false);
    expect(getConnector(db, connectorId)?.enabled).toBe(1);
  }, 30_000);

  it("will not revive a connection the user switched off", async () => {
    const connectorId = calendarConnector();
    await grant(connectorId, "calendar.list_events", "list_events");
    setConnectorEnabled(db, connectorId, false, userMessageId);

    expect(await restoreConnectorReachability(db, "calendar.list_events")).toBe(false);
    expect(getConnector(db, connectorId)?.enabled).toBe(0);
  }, 30_000);

  it("marks an unreachable server rather than leaving it enabled", async () => {
    const connectorId = createConnector(db, {
      label: "Missing",
      transport: "stdio",
      command: process.execPath,
      args: [join(directory, "does-not-exist.mjs")],
      sourceMessageId: userMessageId,
    }).id;

    await expect(verifyConnector(db, connectorId)).rejects.toThrow();

    const connector = getConnector(db, connectorId);
    expect(connector?.status).toBe("unreachable");
    expect(() => setConnectorEnabled(db, connectorId, true, userMessageId)).toThrow(
      /must verify/u,
    );
  }, 30_000);

  it("withdraws a grant when the remote changes what its tool accepts", async () => {
    const connectorId = calendarConnector();
    await grant(connectorId, "calendar.list_events", "list_events");
    expect(availableCapability(db, "calendar.list_events")).not.toBeNull();

    writeFileSync(join(directory, "calendar-server.mjs"), DRIFTED_SERVER, { mode: 0o600 });
    const { drifted } = await revalidateCapabilitySchemas(db, connectorId);

    expect(drifted).toEqual(["calendar.list_events"]);
    expect(availableCapability(db, "calendar.list_events")).toBeNull();
    await expect(
      callCapability(db, "calendar.list_events", { from: "a", to: "b" }),
    ).rejects.toBeInstanceOf(ConnectorError);
  }, 30_000);

  it("will not spawn a stored command connector once the deployment is hosted", async () => {
    const connectorId = calendarConnector();
    expect((await verifyConnector(db, connectorId)).connector.status).toBe("ready");

    // The row was written on a laptop; the same store is now one account among many. If the
    // child ran here it would read every other account's memory, so the handshake that just
    // succeeded must stop succeeding.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";

    await expect(verifyConnector(db, connectorId)).rejects.toMatchObject({
      code: "local_only",
    });
    expect(getConnector(db, connectorId)?.status).toBe("unreachable");
    await expect(
      callCapability(db, "calendar.list_events", { from: "a", to: "b" }),
    ).rejects.toBeInstanceOf(ConnectorError);
  }, 30_000);

  it("refuses to verify while a named environment variable is absent", async () => {
    const connectorId = calendarConnector(CALENDAR_SERVER, ["FAKE_CALENDAR_TOKEN"]);

    await expect(verifyConnector(db, connectorId)).rejects.toThrow(
      /FAKE_CALENDAR_TOKEN/u,
    );
    expect(getConnector(db, connectorId)?.status).toBe("unreachable");
  }, 30_000);
});

describe("a reply larger than Zeus will hold", () => {
  it("reports the cut rather than handing back a fragment to parse", async () => {
    const connectorId = calendarConnector(OVERSIZED_SERVER);
    const capability = await grant(connectorId, "calendar.list_events", "list_events");

    const result = await callCapability(
      db,
      "calendar.list_events",
      { from: "2026-08-20T00:00:00.000Z", to: "2026-08-21T00:00:00.000Z" },
      { capabilityId: capability.id },
    );

    // The failure this closes: the fragment used to come back as `value`, where it failed to
    // parse exactly as a malformed reply would, so "that server sent nonsense" was reported
    // for a server that sent too much. Raising the cap only moves that line.
    expect(result.truncated).toBe(true);
    expect(result.value).toBeNull();
    expect(result.isError).toBe(false);
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it("leaves an ordinary reply untouched", async () => {
    const connectorId = calendarConnector();
    const capability = await grant(connectorId, "calendar.list_events", "list_events");

    const result = await callCapability(
      db,
      "calendar.list_events",
      { from: "2026-08-20T00:00:00.000Z", to: "2026-08-21T00:00:00.000Z" },
      { capabilityId: capability.id },
    );

    expect(result.truncated).toBe(false);
    expect(result.value).toMatchObject({ events: [{ id: "evt-1" }] });
  });
});

describe("Google Application Default Credentials", () => {
  it("requests only the fixed project and minimum-scope token commands", async () => {
    const calls: string[][] = [];
    const headers = await googleAdcHeaders(GOOGLE_CALENDAR_PRESET, ["calendar.list_events"], {
      environment: {},
      commandRunner: async (args) => {
        calls.push([...args]);
        return {
          stdout: args[0] === "config"
            ? "zeus-calendar-project\n"
            : "short-lived-access-token-12345\n",
        };
      },
    });

    expect(calls[0]).toEqual(["config", "get-value", "project", "--quiet"]);
    expect(calls[1]?.slice(0, 3)).toEqual([
      "auth",
      "application-default",
      "print-access-token",
    ]);
    expect(calls[1]?.[3]).toContain("calendar.events.readonly");
    expect(calls[1]?.[3]).not.toContain("auth/calendar.events,");
    expect(headers).toEqual({
      Authorization: "Bearer short-lived-access-token-12345",
      "x-goog-user-project": "zeus-calendar-project",
    });
  });

  it("returns an allowlisted failure without echoing command output", async () => {
    let call = 0;
    const failure = googleAdcHeaders(GOOGLE_CALENDAR_PRESET, ["calendar.create_event"], {
      environment: {},
      tokenFailureCode: "scope_missing",
      commandRunner: async () => {
        call += 1;
        if (call === 1) return { stdout: "zeus-calendar-project" };
        throw new Error("ya29.secret-provider-output");
      },
    });

    await expect(failure).rejects.toMatchObject({ code: "scope_missing" });
    await expect(failure).rejects.not.toThrow(/secret-provider-output/u);
  });

  it("refuses process-wide ADC outside local mode before running gcloud", async () => {
    let called = false;
    await expect(
      googleAdcHeaders(GOOGLE_CALENDAR_PRESET, ["calendar.list_events"], {
        environment: { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" },
        commandRunner: async () => {
          called = true;
          return { stdout: "must-not-run" };
        },
      }),
    ).rejects.toMatchObject({ code: "local_only" });
    expect(called).toBe(false);
  });
});

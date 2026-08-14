import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const presetMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  tools: [] as Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean };
  }>,
  callTool: vi.fn(),
  transports: [] as Array<{ url: string; options: Record<string, unknown> }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: presetMocks.execFile };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect() {}

    async listTools() {
      return { tools: presetMocks.tools };
    }

    async callTool(...args: unknown[]) {
      return presetMocks.callTool(...args);
    }

    async close() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHttpTransport {
    constructor(url: URL, options: Record<string, unknown>) {
      presetMocks.transports.push({ url: url.toString(), options });
    }

    async close() {}
  },
}));

import {
  availableCapability,
  configureConnectorPreset,
  getConnector,
  toolSchemaHash,
} from "./connectors";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import {
  callCapability,
  googleCalendarAdcHeaders,
} from "./mcp-client";

let db: Db;
let sourceMessageId: number;

beforeEach(() => {
  vi.clearAllMocks();
  presetMocks.tools = [];
  presetMocks.transports = [];
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.ZEUS_TEST_UNRELATED_SECRET;

  presetMocks.execFile.mockImplementation(
    (
      _file: string,
      args: readonly string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(
        null,
        args[0] === "config"
          ? "zeus-calendar-project\n"
          : "short-lived-access-token-12345\n",
        "",
      );
    },
  );
  presetMocks.callTool.mockResolvedValue({
    content: [{ type: "text", text: "{}" }],
    isError: false,
  });

  db = openTestDb();
  const conversation = createConversation(db, { title: "Connections", source: "web" });
  sourceMessageId = appendMessage(db, conversation.id, "user", "connect calendar", {
    origin: "user_action",
    recallState: "blocked",
  }).id;
});

afterEach(() => {
  delete process.env.ZEUS_TEST_UNRELATED_SECRET;
});

describe("the Google preset transport", () => {
  it("uses execFile without a shell and passes only the safe environment", async () => {
    process.env.ZEUS_TEST_UNRELATED_SECRET = "must-not-leak";

    await googleCalendarAdcHeaders(["calendar.list_events"]);

    expect(presetMocks.execFile).toHaveBeenCalledTimes(2);
    const [file, args, options] = presetMocks.execFile.mock.calls[1]!;
    expect(file).toBe("gcloud");
    expect(args).toEqual([
      "auth",
      "application-default",
      "print-access-token",
      expect.stringContaining("calendar.events.readonly"),
    ]);
    expect(options).toMatchObject({
      shell: false,
      timeout: 10_000,
      maxBuffer: 8_192,
    });
    expect((options.env as Record<string, string | undefined>).ZEUS_TEST_UNRELATED_SECRET)
      .toBeUndefined();
  });

  it("checks the live schema and disables drift before dispatch", async () => {
    const originalSchema = {
      type: "object",
      properties: { timeMin: { type: "string" } },
    };
    const originalTool = discoveredTool("list_events", originalSchema);
    presetMocks.tools = [remoteTool("list_events", originalSchema)];
    const connector = configureConnectorPreset(db, {
      presetId: "google-calendar-official",
      selectedSlots: ["calendar.list_events"],
      discoveredTools: [originalTool],
      sourceMessageId,
    });
    expect(availableCapability(db, "calendar.list_events")).not.toBeNull();

    presetMocks.tools = [
      remoteTool("list_events", {
        type: "object",
        properties: { changed: { type: "boolean" } },
      }),
    ];

    await expect(
      callCapability(db, "calendar.list_events", { timeMin: "2026-08-14" }),
    ).rejects.toMatchObject({ code: "tool_contract_changed" });
    expect(presetMocks.callTool).not.toHaveBeenCalled();
    expect(availableCapability(db, "calendar.list_events")).toBeNull();
    expect(getConnector(db, connector.id)?.capabilities[0]?.enabled).toBe(0);
    expect(presetMocks.transports[0]).toMatchObject({
      url: "https://calendarmcp.googleapis.com/mcp/v1",
      options: {
        requestInit: {
          headers: {
            Authorization: "Bearer short-lived-access-token-12345",
            "x-goog-user-project": "zeus-calendar-project",
          },
        },
      },
    });
  });
});

function remoteTool(name: string, inputSchema: Record<string, unknown>) {
  return {
    name,
    inputSchema,
    annotations: { readOnlyHint: name === "list_events" },
  };
}

function discoveredTool(name: string, inputSchema: Record<string, unknown>) {
  return {
    name,
    description: null,
    inputSchema,
    schemaHash: toolSchemaHash(inputSchema),
    readOnlyHint: name === "list_events",
  };
}

import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureGoogleCalendarCapabilities,
  configureGoogleGmailCapabilities,
  GOOGLE_GMAIL_BROKER_SERVICE_KEY,
  upsertGoogleCalendarConnector,
  upsertGoogleGmailConnector,
} from "../core/connectors";
import { appendMessage, createConversation } from "../core/conversations";
import { openTestDb } from "../core/db";
import { callCapability, verifyConnector } from "../core/mcp-client";
import { bindAppOwner } from "../core/owner";
import type { CalendarBrokerConfiguration } from "./config";
import { GMAIL_READ_SCOPE } from "./gmail";
import { CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE } from "./google";
import {
  envelopeTimes,
  signBrokerEnvelope,
  verifyGmailOAuthResult,
  verifyOAuthResult,
} from "./protocol";
import { createCalendarBrokerServer } from "./server";
import { CalendarBrokerStore } from "./store";

const SERVICE_KEY = "broker-service-key-that-is-longer-than-thirty-two-bytes";
const GMAIL_SERVICE_KEY = "gmail-service-key-that-is-longer-than-thirty-two-bytes";
let store: CalendarBrokerStore;
let server: ReturnType<typeof createCalendarBrokerServer>;
let origin: string;
let accountId: string;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
/** Set by a test to make Google refuse the tool call rather than answer it. */
let gmailCallRefusal: { status: number; body: unknown } | null = null;
/** Set by a test to make Google answer the tool call with a refusal of its own. */
let gmailToolResult: unknown = null;

beforeEach(async () => {
  store = new CalendarBrokerStore(":memory:", randomBytes(32));
  accountId = randomUUID();
  gmailCallRefusal = null;
  gmailToolResult = null;
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      const body = String(init?.body);
      if (body.includes("gmail-client-id")) {
        return body.includes("grant_type=authorization_code")
          ? Response.json({
              access_token: "gmail-oauth-access",
              refresh_token: "gmail-refresh-secret",
              scope: GMAIL_READ_SCOPE,
            })
          : Response.json({ access_token: "gmail-access" });
      }
      return body.includes("grant_type=authorization_code")
        ? Response.json({
            access_token: "oauth-access",
            refresh_token: "refresh-secret",
            scope: CALENDAR_READ_SCOPE,
          })
        : Response.json({ access_token: "calendar-access" });
    }
    if (url === "https://gmail.example.test/mcp") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gmail-access");
      return gmailMcpResponse(init);
    }
    if (url.includes("/calendar/v3/calendars/primary/events")) {
      if (init?.method === "POST") {
        const event = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ ...event, status: "confirmed" });
      }
      return Response.json({
        items: [{
          id: "evt-1",
          summary: "Planning",
          start: { dateTime: "2026-08-15T10:00:00Z" },
          end: { dateTime: "2026-08-15T11:00:00Z" },
        }],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const configuration: CalendarBrokerConfiguration = {
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    encryptionKey: randomBytes(32),
    serviceKey: SERVICE_KEY,
    zeusAppUrl: "https://www.zeusagent.dev",
    googleClientId: "client-id",
    googleClientSecret: "client-secret",
    googleRedirectUri: "https://calendar-dev.zeusagent.dev/oauth/google/callback",
    gmail: {
      serviceKey: GMAIL_SERVICE_KEY,
      clientId: "gmail-client-id",
      clientSecret: "gmail-client-secret",
      redirectUri: "https://calendar-dev.zeusagent.dev/oauth/gmail/callback",
      remoteMcpUrl: "https://gmail.example.test/mcp",
    },
  };
  server = createCalendarBrokerServer(configuration, store, fetcher);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  store.close();
  delete process.env.GOOGLE_CALENDAR_BROKER_SERVICE_KEY;
  delete process.env.GOOGLE_GMAIL_BROKER_SERVICE_KEY;
});

describe("the multi-user Google Calendar broker", () => {
  it("binds OAuth consent to a signed Zeus account and serves only that account", async () => {
    const result = await connectCalendar();
    const grant = store.getGrant(result.connectionId, accountId);
    expect(grant?.refreshToken).toBe("refresh-secret");

    const client = new Client({ name: "test-zeus", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp/${result.connectionId}`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${SERVICE_KEY}`,
            "X-Zeus-Account-Id": accountId,
          },
        },
      },
    );
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "create_event",
      "list_events",
      "update_event",
    ]);
    const listed = await client.callTool({
      name: "list_events",
      arguments: {
        from: "2026-08-14T00:00:00.000Z",
        to: "2026-08-20T00:00:00.000Z",
      },
    });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.content)).toContain("evt-1");
    await client.close();

    const wrongAccount = await fetch(`${origin}/mcp/${result.connectionId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        "X-Zeus-Account-Id": randomUUID(),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(wrongAccount.status).toBe(404);
  });

  it("rejects an unsigned OAuth start and consumes Google state only once", async () => {
    expect((await fetch(`${origin}/oauth/google/start?request=forged`, {
      redirect: "manual",
    })).status).toBe(400);

    const request = oauthRequest();
    const started = await fetch(
      `${origin}/oauth/google/start?request=${encodeURIComponent(request)}`,
      { redirect: "manual" },
    );
    const google = new URL(started.headers.get("location")!);
    const state = google.searchParams.get("state")!;
    const callback = `${origin}/oauth/google/callback?code=code&state=${encodeURIComponent(state)}`;

    expect((await fetch(callback, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
  });

  it("accepts the broker credential only through Zeus's locked provider transport", async () => {
    process.env.GOOGLE_CALENDAR_BROKER_SERVICE_KEY = SERVICE_KEY;
    const db = openTestDb();
    bindAppOwner(db, { supabaseUserId: accountId, email: "owner@example.com" });
    const conversation = createConversation(db, { title: "Connections", source: "web" });
    const source = appendMessage(db, conversation.id, "user", "Connect Google Calendar", {
      origin: "user_action",
      recallState: "blocked",
    });
    const grant = store.upsertGrant({
      accountId,
      refreshToken: "refresh-secret",
      scopes: [CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE],
    });
    const connector = upsertGoogleCalendarConnector(db, {
      connectionId: grant.id,
      mcpUrl: `${origin}/mcp/${grant.id}`,
      sourceMessageId: source.id,
    });
    const verified = await verifyConnector(db, connector.id);
    configureGoogleCalendarCapabilities(db, {
      connectorId: connector.id,
      tools: verified.tools,
      scopes: grant.scopes,
      sourceMessageId: source.id,
    });

    const created = await callCapability(db, "calendar.create_event", {
      title: "Planning",
      start: "2026-08-15T10:00:00Z",
      end: "2026-08-15T11:00:00Z",
    }, { requestKey: "effect:durable-key" });

    expect(created.isError).toBe(false);
    expect(created.value).toMatchObject({ title: "Planning", status: "confirmed" });
  });
});

describe("the multi-user Gmail broker", () => {
  it("connects one account and exposes only the two read tools", async () => {
    const result = await connectGmail();
    expect(store.getGmailGrant(result.connectionId, accountId)?.refreshToken).toBe(
      "gmail-refresh-secret",
    );

    const client = new Client({ name: "test-zeus", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${origin}/gmail/mcp/${result.connectionId}`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${GMAIL_SERVICE_KEY}`,
            "X-Zeus-Account-Id": accountId,
          },
        },
      },
    ));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "get_thread",
      "search_threads",
    ]);
    const searched = await client.callTool({
      name: "search_threads",
      arguments: { query: "in:inbox newer_than:7d", pageSize: 50 },
    });
    expect(searched.isError).not.toBe(true);
    expect(JSON.stringify(searched.content)).toContain("thread-1");
    const blocked = await client.callTool({
      name: "create_draft",
      arguments: { to: "attacker@example.test", body: "must not leave" },
    });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("read-only tools only");
    await client.close();

    const wrongAccount = await fetch(`${origin}/gmail/mcp/${result.connectionId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GMAIL_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "X-Zeus-Account-Id": randomUUID(),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(wrongAccount.status).toBe(404);
  });

  it("names what Google refused, rather than that something did not work", async () => {
    // The state a real deployment sat in: tools list, the read fails, and the only word
    // anybody got back was `gmail_unavailable`. A disabled API and a grant that is too
    // narrow both arrive as 403, and they are fixed in different places by different people.
    const result = await connectGmail();
    gmailCallRefusal = {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Gmail API has not been used in project 123 before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "SERVICE_DISABLED" }],
        },
      },
    };

    const client = new Client({ name: "test-zeus", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${origin}/gmail/mcp/${result.connectionId}`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${GMAIL_SERVICE_KEY}`,
            "X-Zeus-Account-Id": accountId,
          },
        },
      },
    ));
    const searched = await client.callTool({
      name: "search_threads",
      arguments: { query: "in:inbox newer_than:7d", pageSize: 50 },
    });
    await client.close();

    expect(searched.isError).toBe(true);
    const text = JSON.stringify(searched.content);
    expect(text).toContain("gmail_http_403");
    // Google's own machine reason, matched to a bounded token — the half a status alone
    // cannot supply.
    expect(text).toContain("gmail_http_403_service_disabled");
    // Still nothing of Google's prose, and the grant is untouched: a refusal Zeus cannot fix
    // is not the user's consent going away.
    expect(text).not.toContain("has not been used in project");
    expect(store.getGmailGrant(result.connectionId, accountId)?.status).toBe("active");
  });

  it("tags a refusal Google returned as a result, not as a transport error", async () => {
    // The other half, and the one that would otherwise still arrive unnamed: Google's MCP
    // server answering with an ordinary `isError` tool result. Nothing throws, so none of the
    // transport naming runs, and the text used to be forwarded untagged — leaving Zeus able
    // to report only that something went wrong.
    const result = await connectGmail();
    gmailToolResult = {
      isError: true,
      content: [{
        type: "text",
        text: "Request had insufficient authentication scopes. ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      }],
    };

    const client = new Client({ name: "test-zeus", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${origin}/gmail/mcp/${result.connectionId}`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${GMAIL_SERVICE_KEY}`,
            "X-Zeus-Account-Id": accountId,
          },
        },
      },
    ));
    const searched = await client.callTool({
      name: "search_threads",
      arguments: { query: "in:inbox newer_than:7d", pageSize: 50 },
    });
    await client.close();

    expect(searched.isError).toBe(true);
    const text = JSON.stringify(searched.content);
    expect(text).toContain("gmail_tool_refused_access_token_scope_insufficient");
    // Google's sentence stays in the broker's own log; only the token crosses to Zeus.
    expect(text).not.toContain("insufficient authentication scopes");
  });

  it("serves the locked Gmail provider transport in hosted Zeus", async () => {
    process.env[GOOGLE_GMAIL_BROKER_SERVICE_KEY] = GMAIL_SERVICE_KEY;
    const result = await connectGmail();
    const db = openTestDb();
    bindAppOwner(db, { supabaseUserId: accountId, email: "owner@example.com" });
    const conversation = createConversation(db, { title: "Connections", source: "web" });
    const source = appendMessage(db, conversation.id, "user", "Connect Gmail", {
      origin: "user_action",
      recallState: "blocked",
    });
    const connector = upsertGoogleGmailConnector(db, {
      connectionId: result.connectionId,
      mcpUrl: `${origin}/gmail/mcp/${result.connectionId}`,
      sourceMessageId: source.id,
    });
    const verified = await verifyConnector(db, connector.id);
    configureGoogleGmailCapabilities(db, {
      connectorId: connector.id,
      tools: verified.tools,
      scopes: result.scopes,
      sourceMessageId: source.id,
    });

    const searched = await callCapability(db, "email.search_threads", {
      query: "in:inbox newer_than:7d",
      pageSize: 50,
    });
    expect(searched.isError).toBe(false);
    expect(searched.value).toMatchObject({ threads: [{ id: "thread-1" }] });
    db.close();
  });
});

async function connectCalendar() {
  const started = await fetch(
    `${origin}/oauth/google/start?request=${encodeURIComponent(oauthRequest())}`,
    { redirect: "manual" },
  );
  expect(started.status).toBe(303);
  const google = new URL(started.headers.get("location")!);
  expect(google.hostname).toBe("accounts.google.com");
  const state = google.searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await fetch(
    `${origin}/oauth/google/callback?code=google-code&state=${encodeURIComponent(state!)}`,
    { redirect: "manual" },
  );
  expect(callback.status).toBe(303);
  const returnUrl = new URL(callback.headers.get("location")!);
  expect(returnUrl.origin).toBe("https://www.zeusagent.dev");
  return verifyOAuthResult(returnUrl.searchParams.get("result")!, SERVICE_KEY);
}

function oauthRequest(): string {
  return signBrokerEnvelope({
    kind: "google_calendar_oauth_request",
    accountId,
    returnUrl: "https://www.zeusagent.dev/api/integrations/google-calendar/callback",
    permission: "read",
    nonce: randomUUID(),
    ...envelopeTimes(),
  }, SERVICE_KEY);
}

async function connectGmail() {
  const request = signBrokerEnvelope({
    kind: "google_gmail_oauth_request",
    accountId,
    returnUrl: "https://www.zeusagent.dev/api/integrations/google-gmail/callback",
    nonce: randomUUID(),
    ...envelopeTimes(),
  }, GMAIL_SERVICE_KEY);
  const started = await fetch(
    `${origin}/oauth/gmail/start?request=${encodeURIComponent(request)}`,
    { redirect: "manual" },
  );
  expect(started.status).toBe(303);
  const google = new URL(started.headers.get("location")!);
  expect(google.searchParams.get("scope")).toBe(GMAIL_READ_SCOPE);
  expect(google.searchParams.get("prompt")).toBe("consent");
  expect(google.searchParams.get("redirect_uri")).toBe(
    "https://calendar-dev.zeusagent.dev/oauth/gmail/callback",
  );
  const state = google.searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await fetch(
    `${origin}/oauth/gmail/callback?code=gmail-code&state=${encodeURIComponent(state!)}`,
    { redirect: "manual" },
  );
  expect(callback.status).toBe(303);
  const returnUrl = new URL(callback.headers.get("location")!);
  return verifyGmailOAuthResult(
    returnUrl.searchParams.get("result")!,
    GMAIL_SERVICE_KEY,
  );
}

function gmailMcpResponse(init: RequestInit | undefined): Response {
  const request = JSON.parse(String(init?.body)) as {
    id?: string | number;
    method?: string;
    params?: { name?: string };
  };
  if (request.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (request.method === "tools/call" && gmailCallRefusal) {
    return Response.json(gmailCallRefusal.body, { status: gmailCallRefusal.status });
  }
  if (request.method === "tools/call" && gmailToolResult) {
    return Response.json({ jsonrpc: "2.0", id: request.id, result: gmailToolResult });
  }
  const result = request.method === "initialize"
    ? {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-gmail", version: "1" },
      }
    : request.method === "tools/list"
      ? {
          tools: [
            {
              name: "search_threads",
              description: "Search Gmail threads",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" }, pageSize: { type: "integer" } },
                required: ["query"],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "get_thread",
              description: "Get one Gmail thread",
              inputSchema: {
                type: "object",
                properties: { threadId: { type: "string" } },
                required: ["threadId"],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "create_draft",
              description: "Create a draft",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: false },
            },
          ],
        }
      : request.method === "tools/call" && request.params?.name === "search_threads"
        ? {
            content: [{
              type: "text",
              text: JSON.stringify({ threads: [{ id: "thread-1" }] }),
            }],
          }
        : { isError: true, content: [{ type: "text", text: "unexpected test call" }] };
  return Response.json({ jsonrpc: "2.0", id: request.id, result });
}

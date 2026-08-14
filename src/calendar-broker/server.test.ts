import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureGoogleCalendarCapabilities,
  upsertGoogleCalendarConnector,
} from "../core/connectors";
import { appendMessage, createConversation } from "../core/conversations";
import { openTestDb } from "../core/db";
import { callCapability, verifyConnector } from "../core/mcp-client";
import { bindAppOwner } from "../core/owner";
import type { CalendarBrokerConfiguration } from "./config";
import { CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE } from "./google";
import {
  envelopeTimes,
  signBrokerEnvelope,
  verifyOAuthResult,
} from "./protocol";
import { createCalendarBrokerServer } from "./server";
import { CalendarBrokerStore } from "./store";

const SERVICE_KEY = "broker-service-key-that-is-longer-than-thirty-two-bytes";
let store: CalendarBrokerStore;
let server: ReturnType<typeof createCalendarBrokerServer>;
let origin: string;
let accountId: string;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(async () => {
  store = new CalendarBrokerStore(":memory:", randomBytes(32));
  accountId = randomUUID();
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      const body = String(init?.body);
      return body.includes("grant_type=authorization_code")
        ? Response.json({
            access_token: "oauth-access",
            refresh_token: "refresh-secret",
            scope: CALENDAR_READ_SCOPE,
          })
        : Response.json({ access_token: "calendar-access" });
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

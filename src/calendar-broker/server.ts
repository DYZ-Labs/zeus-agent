#!/usr/bin/env -S node --import tsx
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { calendarBrokerConfiguration, type CalendarBrokerConfiguration } from "./config";
import {
  createGoogleGmailMcpServer,
  exchangeGmailCode,
  GMAIL_WRITE_SCOPE,
  gmailAuthorizationUrl,
  revokeGmailGrant,
} from "./gmail";
import {
  CALENDAR_READ_SCOPE,
  CALENDAR_WRITE_SCOPE,
  exchangeGoogleCode,
  GoogleCalendarApi,
  googleAuthorizationUrl,
  revokeGoogleGrant,
} from "./google";
import { createGoogleCalendarMcpServer } from "./mcp";
import {
  envelopeTimes,
  signBrokerEnvelope,
  verifyGmailOAuthRequest,
  verifyOAuthRequest,
} from "./protocol";
import { CalendarBrokerStore } from "./store";

const MAX_BODY_BYTES = 1_000_000;
const DisconnectBody = z
  .object({ accountId: z.string().uuid(), connectionId: z.string().uuid() })
  .strict();

export function createCalendarBrokerServer(
  configuration: CalendarBrokerConfiguration,
  store: CalendarBrokerStore,
  fetcher: typeof fetch = fetch,
) {
  const oauthConfiguration = {
    clientId: configuration.googleClientId,
    clientSecret: configuration.googleClientSecret,
    redirectUri: configuration.googleRedirectUri,
  };
  const api = new GoogleCalendarApi(oauthConfiguration, fetcher);
  const gmailOAuthConfiguration = configuration.gmail
    ? {
        clientId: configuration.gmail.clientId,
        clientSecret: configuration.gmail.clientSecret,
        redirectUri: configuration.gmail.redirectUri,
      }
    : null;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "broker"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/oauth/google/start") {
        const envelope = url.searchParams.get("request") ?? "";
        const oauthRequest = verifyOAuthRequest(envelope, configuration.serviceKey);
        assertReturnUrl(oauthRequest.returnUrl, configuration.zeusAppUrl);
        const state = store.createOAuthState({
          accountId: oauthRequest.accountId,
          returnUrl: oauthRequest.returnUrl,
          permission: oauthRequest.permission,
        });
        return redirect(
          response,
          googleAuthorizationUrl({
            configuration: oauthConfiguration,
            state,
            permission: oauthRequest.permission,
          }),
        );
      }
      if (request.method === "GET" && url.pathname === "/oauth/gmail/start") {
        if (!configuration.gmail || !gmailOAuthConfiguration) {
          return text(response, 503, "Gmail connections are not configured");
        }
        const envelope = url.searchParams.get("request") ?? "";
        const oauthRequest = verifyGmailOAuthRequest(
          envelope,
          configuration.gmail.serviceKey,
        );
        assertReturnUrl(
          oauthRequest.returnUrl,
          configuration.zeusAppUrl,
          "/api/integrations/google-gmail/callback",
        );
        const state = store.createGmailOAuthState({
          accountId: oauthRequest.accountId,
          returnUrl: oauthRequest.returnUrl,
        });
        return redirect(
          response,
          gmailAuthorizationUrl({ configuration: gmailOAuthConfiguration, state }),
        );
      }
      if (request.method === "GET" && url.pathname === "/oauth/google/callback") {
        const state = store.consumeOAuthState(url.searchParams.get("state") ?? "");
        if (!state) return text(response, 400, "This Google Calendar connection attempt expired.");
        if (url.searchParams.get("error")) {
          return redirectWithError(response, state.returnUrl, "Google Calendar access was not granted.");
        }
        const code = url.searchParams.get("code");
        if (!code) return redirectWithError(response, state.returnUrl, "Google returned no authorization code.");
        try {
          const token = await exchangeGoogleCode(code, oauthConfiguration, fetcher);
          const requiredScope = state.permission === "write" ? CALENDAR_WRITE_SCOPE : CALENDAR_READ_SCOPE;
          if (!token.scopes.includes(requiredScope)) {
            return redirectWithError(
              response,
              state.returnUrl,
              "Google did not grant the requested Calendar permission.",
            );
          }
          const grant = store.upsertGrant({
            accountId: state.accountId,
            refreshToken: token.refreshToken,
            scopes: token.scopes,
          });
          const result = signBrokerEnvelope({
            kind: "google_calendar_oauth_result",
            accountId: state.accountId,
            connectionId: grant.id,
            scopes: grant.scopes,
            ...envelopeTimes(new Date(), 5 * 60),
          }, configuration.serviceKey);
          const returnUrl = new URL(state.returnUrl);
          returnUrl.searchParams.set("result", result);
          return redirect(response, returnUrl);
        } catch {
          return redirectWithError(
            response,
            state.returnUrl,
            "Google Calendar could not be connected. Start a new attempt.",
          );
        }
      }
      if (request.method === "GET" && url.pathname === "/oauth/gmail/callback") {
        if (!configuration.gmail || !gmailOAuthConfiguration) {
          return text(response, 503, "Gmail connections are not configured");
        }
        const state = store.consumeGmailOAuthState(url.searchParams.get("state") ?? "");
        if (!state) return text(response, 400, "This Gmail connection attempt expired.");
        if (url.searchParams.get("error")) {
          return redirectWithError(response, state.returnUrl, "Gmail access was not granted.");
        }
        const code = url.searchParams.get("code");
        if (!code) return redirectWithError(response, state.returnUrl, "Google returned no authorization code.");
        try {
          const token = await exchangeGmailCode(code, gmailOAuthConfiguration, fetcher);
          // One scope, and the connection is not recorded without it. A partial grant that
          // reads but cannot draft would bind capabilities the first use would refuse.
          if (!token.scopes.includes(GMAIL_WRITE_SCOPE)) {
            return redirectWithError(
              response,
              state.returnUrl,
              "Google did not grant Zeus access to this mailbox.",
            );
          }
          const grant = store.upsertGmailGrant({
            accountId: state.accountId,
            refreshToken: token.refreshToken,
            scopes: token.scopes,
          });
          const result = signBrokerEnvelope({
            kind: "google_gmail_oauth_result",
            accountId: state.accountId,
            connectionId: grant.id,
            scopes: grant.scopes,
            ...envelopeTimes(new Date(), 5 * 60),
          }, configuration.gmail.serviceKey);
          const returnUrl = new URL(state.returnUrl);
          returnUrl.searchParams.set("result", result);
          return redirect(response, returnUrl);
        } catch {
          return redirectWithError(
            response,
            state.returnUrl,
            "Gmail could not be connected. Start a new attempt.",
          );
        }
      }
      if (request.method === "POST" && url.pathname === "/connections/disconnect") {
        if (!authorized(request, configuration.serviceKey)) return text(response, 401, "Unauthorized");
        const parsed = DisconnectBody.safeParse(await readJson(request));
        if (!parsed.success) return text(response, 400, "Invalid disconnect request");
        const grant = store.getGrant(parsed.data.connectionId, parsed.data.accountId);
        if (!grant) return empty(response, 204);
        await revokeGoogleGrant(grant.refreshToken, fetcher);
        store.deleteGrant(grant.id, grant.accountId);
        return empty(response, 204);
      }
      if (request.method === "POST" && url.pathname === "/connections/gmail/disconnect") {
        if (!configuration.gmail || !authorized(request, configuration.gmail.serviceKey)) {
          return text(response, 401, "Unauthorized");
        }
        const parsed = DisconnectBody.safeParse(await readJson(request));
        if (!parsed.success) return text(response, 400, "Invalid disconnect request");
        const grant = store.getGmailGrant(parsed.data.connectionId, parsed.data.accountId);
        if (!grant) return empty(response, 204);
        await revokeGmailGrant(grant.refreshToken, fetcher);
        store.deleteGmailGrant(grant.id, grant.accountId);
        return empty(response, 204);
      }

      const gmailMcpMatch = /^\/gmail\/mcp\/([0-9a-f-]{36})$/iu.exec(url.pathname);
      if (gmailMcpMatch) {
        if (request.method !== "POST") return text(response, 405, "Method not allowed");
        if (!configuration.gmail || !gmailOAuthConfiguration ||
            !authorized(request, configuration.gmail.serviceKey)) {
          return text(response, 401, "Unauthorized");
        }
        const accountId = request.headers["x-zeus-account-id"];
        const connectionId = gmailMcpMatch[1];
        if (typeof accountId !== "string" || !connectionId) return text(response, 401, "Unauthorized");
        const grant = store.getGmailGrant(connectionId, accountId);
        if (!grant) return text(response, 404, "Connection unavailable");
        const body = await readJson(request);
        const gmailServer = createGoogleGmailMcpServer({
          grant,
          store,
          oauth: gmailOAuthConfiguration,
          requestKey:
            typeof request.headers["x-zeus-request-key"] === "string"
              ? request.headers["x-zeus-request-key"]
              : null,
          fetcher,
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await gmailServer.connect(transport);
          await transport.handleRequest(request, response, body);
        } finally {
          await transport.close().catch(() => undefined);
          await gmailServer.close().catch(() => undefined);
        }
        return;
      }

      const mcpMatch = /^\/mcp\/([0-9a-f-]{36})$/iu.exec(url.pathname);
      if (mcpMatch) {
        if (request.method !== "POST") return text(response, 405, "Method not allowed");
        if (!authorized(request, configuration.serviceKey)) return text(response, 401, "Unauthorized");
        const accountId = request.headers["x-zeus-account-id"];
        const connectionId = mcpMatch[1];
        if (typeof accountId !== "string" || !connectionId) return text(response, 401, "Unauthorized");
        const grant = store.getGrant(connectionId, accountId);
        if (!grant) return text(response, 404, "Connection unavailable");
        const body = await readJson(request);
        const server = createGoogleCalendarMcpServer({
          grant,
          store,
          api,
          requestKey:
            typeof request.headers["x-zeus-request-key"] === "string"
              ? request.headers["x-zeus-request-key"]
              : null,
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        try {
          await server.connect(transport);
          await transport.handleRequest(request, response, body);
        } finally {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        }
        return;
      }
      return text(response, 404, "Not found");
    } catch {
      if (!response.headersSent) return text(response, 400, "Request rejected");
      response.end();
    }
  });
}

function assertReturnUrl(
  returnUrl: string,
  zeusAppUrl: string,
  pathname = "/api/integrations/google-calendar/callback",
): void {
  const url = new URL(returnUrl);
  if (
    url.origin !== zeusAppUrl ||
    url.pathname !== pathname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error("Invalid Zeus OAuth return URL");
  }
}

function authorized(request: IncomingMessage, serviceKey: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(serviceKey, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function redirectWithError(
  response: ServerResponse,
  returnUrl: string,
  message: string,
): void {
  const url = new URL("/settings", new URL(returnUrl).origin);
  url.searchParams.set("connector_error", message);
  url.hash = "connections";
  redirect(response, url);
}

function redirect(response: ServerResponse, url: URL): void {
  response.writeHead(303, {
    Location: url.toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

function empty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Cache-Control": "no-store" });
  response.end();
}

if (process.env.NODE_ENV !== "test") {
  const configuration = calendarBrokerConfiguration();
  const store = new CalendarBrokerStore(
    configuration.databasePath,
    configuration.encryptionKey,
  );
  const server = createCalendarBrokerServer(configuration, store);
  server.listen(configuration.port, configuration.host, () => {
    process.stderr.write(`Google Calendar broker listening on ${configuration.host}:${configuration.port}\n`);
  });
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

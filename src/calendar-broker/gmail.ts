import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { CalendarBrokerStore, GmailGrant } from "./store";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const ALLOWED_TOOLS = new Set(["search_threads", "get_thread"]);
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

const TokenResponse = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

export type GoogleGmailOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleGmailTokenExchange = {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
};

export class GoogleGmailError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GoogleGmailError";
  }
}

export function gmailAuthorizationUrl(input: {
  configuration: GoogleGmailOAuthConfiguration;
  state: string;
}): URL {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("redirect_uri", input.configuration.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_READ_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url;
}

export async function exchangeGmailCode(
  code: string,
  configuration: GoogleGmailOAuthConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<GoogleGmailTokenExchange> {
  const response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      redirect_uri: configuration.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await boundedJson(response);
  if (!response.ok) {
    throw new GoogleGmailError("oauth_exchange_failed", "Google rejected the Gmail OAuth code");
  }
  const token = TokenResponse.parse(body);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    scopes: token.scope?.split(/\s+/u).filter(Boolean) ?? [],
  };
}

export async function revokeGmailGrant(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(GOOGLE_REVOCATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 400) {
    throw new GoogleGmailError("revocation_failed", "Google did not confirm Gmail revocation");
  }
}

/**
 * Present a read-only MCP surface backed by Google's official Gmail MCP server.
 *
 * The upstream server currently advertises write tools even to a readonly token. Filtering
 * both discovery and dispatch here means the broker's public contract cannot grow when the
 * preview server does. The OAuth scope and this allowlist are independent defenses.
 */
export function createGoogleGmailMcpServer(input: {
  grant: GmailGrant;
  store: CalendarBrokerStore;
  oauth: GoogleGmailOAuthConfiguration;
  remoteMcpUrl: string;
  fetcher?: typeof fetch;
}): { server: Server; close: () => Promise<void> } {
  const fetcher = input.fetcher ?? fetch;
  const server = new Server(
    { name: "zeus-google-gmail", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  let remotePromise: Promise<Client> | null = null;

  const remoteClient = async (): Promise<Client> => {
    if (remotePromise) return remotePromise;
    remotePromise = (async () => {
      if (input.grant.status !== "active") {
        throw new GoogleGmailError("reconnect_required", "Gmail must be reconnected");
      }
      const accessToken = await refreshGmailAccessToken(
        input.grant.refreshToken,
        input.oauth,
        fetcher,
      );
      const client = new Client({ name: "zeus-google-gmail-broker", version: "0.1.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(
          new URL(input.remoteMcpUrl),
          {
            fetch: fetcher,
            requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
          },
        ));
        return client;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    })();
    return remotePromise;
  };

  const readTools = async (signal?: AbortSignal): Promise<Tool[]> => {
    try {
      const client = await remoteClient();
      const listed = await client.listTools({}, { timeout: REQUEST_TIMEOUT_MS, signal });
      const tools = listed.tools.filter((tool) => ALLOWED_TOOLS.has(tool.name));
      for (const name of ALLOWED_TOOLS) {
        if (!tools.some((tool) => tool.name === name)) {
          throw new GoogleGmailError(
            "tool_contract_changed",
            `Google's Gmail server did not expose ${name}`,
          );
        }
      }
      return tools;
    } catch (error) {
      throw gmailFailure(input, error);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: await readTools(extra.signal),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!ALLOWED_TOOLS.has(request.params.name)) {
      return failure("tool_not_allowed: Zeus connected Gmail with read-only tools only");
    }
    try {
      const tools = await readTools(extra.signal);
      if (!tools.some((tool) => tool.name === request.params.name)) {
        return failure("tool_contract_changed: That Gmail read tool is unavailable");
      }
      const client = await remoteClient();
      return await client.callTool(
        request.params,
        undefined,
        { timeout: REQUEST_TIMEOUT_MS, signal: extra.signal },
      );
    } catch (error) {
      const failureError = gmailFailure(input, error);
      return failure(`${failureError.code}: ${failureError.message}`);
    }
  });

  return {
    server,
    close: async () => {
      if (!remotePromise) return;
      const remote = await remotePromise.catch(() => null);
      if (remote) await remote.close().catch(() => undefined);
    },
  };
}

async function refreshGmailAccessToken(
  refreshToken: string,
  configuration: GoogleGmailOAuthConfiguration,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await boundedJson(response);
  if (!response.ok) {
    throw refreshTokenIsRevoked(response.status, body)
      ? new GoogleGmailError("refresh_revoked", "Gmail must be reconnected")
      : new GoogleGmailError("refresh_unavailable", "Google could not issue a Gmail token");
  }
  return TokenResponse.parse(body).access_token;
}

function gmailFailure(
  input: Pick<Parameters<typeof createGoogleGmailMcpServer>[0], "grant" | "store">,
  error: unknown,
): GoogleGmailError {
  const normalized = error instanceof GoogleGmailError
    ? error
    : new GoogleGmailError("gmail_unavailable", "Google Gmail did not complete the request");
  if (normalized.code === "refresh_revoked") {
    input.store.markGmailReconnectRequired(input.grant.id, input.grant.accountId);
  }
  return normalized;
}

function refreshTokenIsRevoked(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 401) return false;
  return body !== null && typeof body === "object" &&
    (body as { error?: unknown }).error === "invalid_grant";
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new GoogleGmailError("response_too_large", "Google returned too much data");
  }
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

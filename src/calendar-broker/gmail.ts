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
      const result = await client.callTool(
        request.params,
        undefined,
        { timeout: REQUEST_TIMEOUT_MS, signal: extra.signal },
      );
      // Google's own refusal arrives as an ordinary tool result, not as a thrown transport
      // error, so nothing in the catch below would ever have seen it. Passing it straight
      // through hands Zeus untagged prose, which it can only report as "something went
      // wrong" — the exact dead end this pass exists to end. Tag it, and lift the one
      // bounded token its text may carry.
      if (result.isError === true) {
        const code = refusalCode("gmail_tool_refused", contentText(result.content));
        reportGmailFailure(code, contentText(result.content));
        return failure(`${code}: Google's Gmail tool refused the request`);
      }
      return result;
    } catch (error) {
      const failureError = gmailFailure(input, error);
      reportGmailFailure(
        failureError.code,
        error instanceof Error ? error.message : String(error),
      );
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
  const normalized = error instanceof GoogleGmailError ? error : googleRefusal(error);
  if (normalized.code === "refresh_revoked") {
    input.store.markGmailReconnectRequired(input.grant.id, input.grant.accountId);
  }
  return normalized;
}

/**
 * Name what Google actually did, rather than reporting that something did not work.
 *
 * A single `gmail_unavailable` used to cover everything below this line — an API nobody
 * enabled, a token whose scopes are too narrow, a server having a minute, a socket that
 * dropped — and Zeus faithfully relayed that one word to the user. Those are four different
 * people's problems, and a connected Gmail that never reads is indistinguishable between
 * them until this code says which.
 *
 * Both halves are matched, never read. The status is a number the transport recorded, and
 * Google's reason is one SCREAMING_SNAKE token pulled out of its error body by pattern — so
 * no sentence of Google's, and nothing a mailbox contains, can reach the code.
 */
function googleRefusal(error: unknown): GoogleGmailError {
  const status = httpStatusOf(error);
  const base = status === null ? "gmail_no_http_answer" : `gmail_http_${status}`;
  return new GoogleGmailError(
    refusalCode(base, error instanceof Error ? error.message : ""),
    status === null
      ? "Google's Gmail server did not return a usable answer"
      : `Google's Gmail server answered ${status}`,
  );
}

/**
 * The HTTP status behind a transport failure.
 *
 * Bounded to a real status range on purpose: `StreamableHTTPError` uses `-1` for a reply it
 * could not read at all, and an `McpError` puts a JSON-RPC code in the same property. Neither
 * is an HTTP answer, and reporting one as `gmail_http_-32603` would be worse than saying
 * nothing.
 */
function httpStatusOf(error: unknown, depth = 0): number | null {
  if (!error || typeof error !== "object" || depth > 3) return null;
  const record = error as { code?: unknown; status?: unknown; cause?: unknown };
  for (const value of [record.code, record.status]) {
    if (typeof value === "number" && value >= 100 && value <= 599) return value;
  }
  return httpStatusOf(record.cause, depth + 1);
}

/**
 * Google's own machine reason for a refusal, when its error body carried one.
 *
 * The status alone cannot separate the two 403s that matter most: `SERVICE_DISABLED` is an
 * API the operator never turned on, and `ACCESS_TOKEN_SCOPE_INSUFFICIENT` is a grant that is
 * too narrow. One is fixed in a Cloud console and the other by asking the user for consent
 * again, so telling them apart is the difference between a fix and another guess.
 */
function googleReasonToken(message: string): string | null {
  // `reason` first, deliberately. Google's canonical error carries a broad `status`
  // (`PERMISSION_DENIED`) beside a specific `details[].reason` (`SERVICE_DISABLED`), and the
  // specific one is the one somebody can act on. Taking whichever appeared first in the body
  // would mean the useful half lost to document order.
  //
  // The last pattern is for a message that is prose rather than an error document, which is
  // how a tool-level refusal tends to arrive. It requires an underscore so that an ordinary
  // capitalized word at the start of a sentence cannot be mistaken for a code.
  const patterns = [
    /"reason"\s*:\s*"([A-Z][A-Z0-9_]{2,47})"/u,
    /"status"\s*:\s*"([A-Z][A-Z0-9_]{2,47})"/u,
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,5})\b/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}

/** A code plus the one bounded token the text carried, if any. Never the text itself. */
function refusalCode(base: string, message: string): string {
  const reason = googleReasonToken(message);
  return (reason === null ? base : `${base}_${reason}`).slice(0, 64);
}

/** The text a tool result carried, bounded, for pattern-matching and for the operator log. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (entry): entry is { text: string } =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string",
    )
    .map((entry) => entry.text)
    .join("\n")
    .slice(0, 2_000);
}

/**
 * One line in the broker's own log when a Gmail read fails.
 *
 * The one place Google's actual sentence is kept. It goes to the operator's log and nowhere
 * else — never to Zeus, never to a prompt, never to the user — because it is the difference
 * between "403" and "the Gmail API is not enabled on project 123", and an operator staring
 * at a connection that will not read has nothing else to go on.
 *
 * Safe to keep here and not upstream: this is a bounded search over the user's own inbox
 * (`in:inbox newer_than:7d`), so a refusal describes the request, not its contents. Only a
 * failure is ever logged, and never a result.
 */
function reportGmailFailure(code: string, message: string): void {
  process.stderr.write(
    `${JSON.stringify({ event: "gmail_read_failed", code, detail: message.slice(0, 500) })}\n`,
  );
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

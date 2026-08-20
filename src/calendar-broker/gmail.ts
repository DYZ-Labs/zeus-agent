import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CalendarBrokerStore, GmailGrant } from "./store";

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** Gmail's own ceiling on `threads.list`. Asking for more is clamped, not refused. */
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

/**
 * How many thread metadata reads run at once.
 *
 * `threads.list` returns ids and snippets and nothing else, so a subject and a sender cost
 * one request per thread. That is the price of this API, and eight at a time keeps a fifty
 * thread page inside the request deadline without becoming a burst Gmail would rate-limit.
 */
const METADATA_CONCURRENCY = 8;

/** Per-message body ceiling at this layer. Zeus bounds it again, harder, before rendering. */
const MAX_BODY_CHARS = 8_000;

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
  /**
   * What Google actually said, for the broker's own log and for nowhere else.
   *
   * Separate from `message`, which crosses to Zeus and from there can reach a user: the
   * detail is Google's own prose, and the operator staring at a connection that will not
   * read is the only reader it is worth anything to.
   */
  constructor(readonly code: string, message: string, readonly detail: string = message) {
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
 * Present a read-only Gmail surface, served directly from the Gmail API.
 *
 * This used to proxy Google's own Gmail MCP server at `gmailmcp.googleapis.com`. That server
 * lists its tools to anybody holding a `gmail.readonly` token and then answers every actual
 * tool call with `{isError: true, "The caller does not have permission"}` — HTTP 200, no
 * code, no detail — for an account Gmail's REST API serves without complaint. It is a
 * gated preview, and nothing on this side could open the gate. So the mailbox is read the
 * way the calendar has always been read: a direct API client behind a locally registered
 * tool, which is `google.ts` plus `mcp.ts` in shape and in reasoning.
 *
 * The two tool contracts are unchanged, deliberately. Zeus binds `search_threads` and
 * `get_thread` by name, builds their arguments from the advertised schema, and parses
 * exactly the payload the previous server returned — so the transport moved and nothing
 * downstream of it had to.
 *
 * Read-only is now structural rather than filtered. The old allowlist existed because the
 * upstream server advertised writes to a readonly token; there is nothing here to filter,
 * because the only requests this file can make are two GETs.
 */
export function createGoogleGmailMcpServer(input: {
  grant: GmailGrant;
  store: CalendarBrokerStore;
  oauth: GoogleGmailOAuthConfiguration;
  fetcher?: typeof fetch;
}): McpServer {
  const fetcher = input.fetcher ?? fetch;
  const server = new McpServer({ name: "zeus-google-gmail", version: "0.1.0" });
  let tokenPromise: Promise<string> | null = null;

  // One token per request, minted lazily: a `tools/list` costs no refresh, and a search that
  // fans out over fifty threads costs one rather than fifty.
  const accessToken = (): Promise<string> => {
    tokenPromise ??= (async () => {
      if (input.grant.status !== "active") {
        throw new GoogleGmailError("reconnect_required", "Gmail must be reconnected");
      }
      return refreshGmailAccessToken(input.grant.refreshToken, input.oauth, fetcher);
    })();
    return tokenPromise;
  };

  server.registerTool(
    "search_threads",
    {
      title: "Search Gmail threads",
      description: "Search the connected user's mailbox and return thread subjects and senders.",
      inputSchema: {
        query: z.string().trim().min(1).max(1_000),
        pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        view: z.enum(THREAD_VIEWS).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, pageSize, view }) => {
      try {
        return success(await searchThreads(await accessToken(), fetcher, { query, pageSize, view }));
      } catch (error) {
        return gmailToolFailure(input, error);
      }
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read one Gmail thread",
      description: "Return the messages of one thread in the connected user's mailbox.",
      inputSchema: {
        threadId: z.string().trim().min(1).max(1_024),
        messageFormat: z.enum(MESSAGE_FORMATS).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ threadId, messageFormat }) => {
      try {
        return success(await readThread(await accessToken(), fetcher, threadId, messageFormat));
      } catch (error) {
        return gmailToolFailure(input, error);
      }
    },
  );

  return server;
}

const THREAD_VIEWS = [
  "THREAD_VIEW_UNSPECIFIED",
  "THREAD_VIEW_METADATA_ONLY",
  "THREAD_VIEW_MINIMAL",
] as const;

const MESSAGE_FORMATS = ["FULL_CONTENT", "METADATA_ONLY"] as const;

/**
 * The window Zeus caches, in the shape it already parses.
 *
 * One `messages` entry per thread, holding the newest message. Zeus describes a thread by its
 * newest message and keeps nothing else from the list, so sending the rest would be a larger
 * payload saying the same thing — and it was payload size that truncated this response at the
 * previous 200 KB cap.
 */
async function searchThreads(
  token: string,
  fetcher: typeof fetch,
  options: { query: string; pageSize?: number; view?: string },
): Promise<unknown> {
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const list = await gmailGet(token, fetcher, "/threads", {
    q: options.query,
    maxResults: String(pageSize),
  });
  const ids = asArray(list.threads)
    .map((thread) => stringField(thread, "id"))
    .filter((id): id is string => id !== null);
  // `THREAD_VIEW_METADATA_ONLY` is the one view that omits the subject, and Zeus pins the
  // value deliberately, so the choice is honored rather than ignored.
  const withSubject = options.view !== "THREAD_VIEW_METADATA_ONLY";
  const headers = withSubject ? ["Subject", "From", "Date"] : ["From", "Date"];
  const threads = await mapConcurrently(ids, METADATA_CONCURRENCY, async (id) => {
    const thread = await gmailGet(token, fetcher, `/threads/${encodeURIComponent(id)}`, {
      format: "metadata",
      metadataHeaders: headers,
    });
    return { id, messages: [summarize(newestMessage(thread), withSubject)] };
  });
  const nextPageToken = stringField(list, "nextPageToken");
  return { threads, ...(nextPageToken === null ? {} : { nextPageToken }) };
}

/** One thread's messages, oldest first — the order Zeus keeps the last few of. */
async function readThread(
  token: string,
  fetcher: typeof fetch,
  threadId: string,
  messageFormat: string | undefined,
): Promise<unknown> {
  const full = messageFormat !== "METADATA_ONLY";
  const thread = await gmailGet(token, fetcher, `/threads/${encodeURIComponent(threadId)}`,
    full
      ? { format: "full" }
      : { format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
  return {
    id: threadId,
    messages: asArray(thread.messages).map((message) => ({
      ...summarize(message, true),
      plaintextBody: full ? plainTextBody(message) : null,
    })),
  };
}

/** The fields Zeus reads off a message, from Gmail's headers and its own metadata. */
function summarize(message: unknown, withSubject: boolean): Record<string, unknown> {
  const record = asRecord(message);
  const headers = headerMap(record);
  return {
    subject: withSubject ? headers.get("subject") ?? null : null,
    sender: headers.get("from") ?? null,
    // `internalDate` is epoch milliseconds as a string, which `Date.parse` cannot read; the
    // `Date` header is the fallback because it can. A thread whose timestamp will not parse
    // is one Zeus cannot place in its window.
    date: epochToIso(record.internalDate) ?? headers.get("date") ?? null,
    labelIds: asArray(record.labelIds).filter((id): id is string => typeof id === "string"),
  };
}

function newestMessage(thread: Record<string, unknown>): unknown {
  const messages = asArray(thread.messages);
  return messages.length === 0 ? thread : messages[messages.length - 1];
}

function headerMap(message: Record<string, unknown>): Map<string, string> {
  const payload = asRecord(message.payload);
  const map = new Map<string, string>();
  for (const entry of asArray(payload.headers)) {
    const header = asRecord(entry);
    const name = stringField(header, "name");
    const value = stringField(header, "value");
    if (name !== null && value !== null) map.set(name.toLowerCase(), value);
  }
  return map;
}

/**
 * The plain-text body, if the message carries one.
 *
 * HTML is skipped rather than stripped, which is the rule Zeus's own renderer already keeps:
 * un-marking-up somebody else's HTML is a parser deciding what a message said.
 */
function plainTextBody(message: unknown): string | null {
  const found = findPlainText(asRecord(asRecord(message).payload), 0);
  return found === null ? null : found.slice(0, MAX_BODY_CHARS);
}

function findPlainText(part: Record<string, unknown>, depth: number): string | null {
  if (depth > 8) return null;
  if (part.mimeType === "text/plain") {
    const data = stringField(asRecord(part.body), "data");
    if (data !== null) return decodeBase64Url(data);
  }
  for (const child of asArray(part.parts)) {
    const found = findPlainText(asRecord(child), depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
}

function epochToIso(value: unknown): string | null {
  const milliseconds = Number(value);
  return typeof value === "string" && Number.isFinite(milliseconds) && milliseconds > 0
    ? new Date(milliseconds).toISOString()
    : null;
}

/** One authenticated GET against the Gmail API, bounded and failing with a named code. */
async function gmailGet(
  token: string,
  fetcher: typeof fetch,
  path: string,
  parameters: Record<string, string | string[]>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  for (const [name, value] of Object.entries(parameters)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, entry);
    }
  }
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await boundedJson(response);
  if (!response.ok) {
    throw new GoogleGmailError(
      refusalCode(`gmail_http_${response.status}`, JSON.stringify(body ?? "")),
      `Gmail answered ${response.status}`,
      JSON.stringify(body ?? "").slice(0, 500),
    );
  }
  return asRecord(body);
}

/** Bounded fan-out. Order is preserved so a window still reads newest first. */
async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string | null {
  const field = asRecord(value)[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function gmailToolFailure(
  input: Pick<Parameters<typeof createGoogleGmailMcpServer>[0], "grant" | "store">,
  error: unknown,
) {
  const failureError = gmailFailure(input, error);
  reportGmailFailure(failureError.code, failureError.detail);
  return failure(`${failureError.code}: ${failureError.message}`);
}

function success(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
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

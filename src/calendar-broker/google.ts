import { createHash } from "node:crypto";

import { z } from "zod";

import type { CalendarGrant } from "./store";

export const CALENDAR_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";
export const CALENDAR_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3";
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 20_000;

const TokenResponse = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
  })
  .passthrough();

const GoogleEvent = z
  .object({
    id: z.string().min(1),
    summary: z.string().optional(),
    location: z.string().optional(),
    status: z.string().optional(),
    start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
    end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
  })
  .passthrough();

export type GoogleOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleTokenExchange = {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
};

export type CalendarEventInput = {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  time_zone?: string;
};

export type CalendarEventUpdate = Partial<CalendarEventInput> & {
  event_id: string;
  status?: "confirmed" | "cancelled";
};

export class GoogleCalendarError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GoogleCalendarError";
  }
}

export function googleAuthorizationUrl(input: {
  configuration: GoogleOAuthConfiguration;
  state: string;
  permission: "read" | "write";
}): URL {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("redirect_uri", input.configuration.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    input.permission === "write" ? CALENDAR_WRITE_SCOPE : CALENDAR_READ_SCOPE,
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  // Google normally returns a refresh token only on the first consent. Explicit consent
  // also makes reconnecting a revoked grant deterministic rather than browser-dependent.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url;
}

export async function exchangeGoogleCode(
  code: string,
  configuration: GoogleOAuthConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokenExchange> {
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
    throw new GoogleCalendarError("oauth_exchange_failed", "Google rejected the OAuth code");
  }
  const token = TokenResponse.parse(body);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    scopes: token.scope?.split(/\s+/u).filter(Boolean) ?? [],
  };
}

export async function revokeGoogleGrant(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(GOOGLE_REVOCATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // An already-invalid token is fully disconnected from Zeus's perspective.
  if (!response.ok && response.status !== 400) {
    throw new GoogleCalendarError("revocation_failed", "Google did not confirm revocation");
  }
}

export class GoogleCalendarApi {
  constructor(
    private readonly configuration: GoogleOAuthConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listEvents(grant: CalendarGrant, from: string, to: string): Promise<unknown> {
    const url = new URL(`${GOOGLE_CALENDAR_ENDPOINT}/calendars/primary/events`);
    url.searchParams.set("timeMin", from);
    url.searchParams.set("timeMax", to);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    const body = await this.authorizedJson(grant, url, { method: "GET" });
    const items = z.object({ items: z.array(GoogleEvent).optional() }).passthrough().parse(body).items ?? [];
    return {
      events: items.map((event) => ({
        id: event.id,
        title: event.summary ?? null,
        starts_at: event.start?.dateTime ?? event.start?.date ?? null,
        ends_at: event.end?.dateTime ?? event.end?.date ?? null,
        location: event.location ?? null,
        status: event.status ?? null,
      })),
    };
  }

  async createEvent(
    grant: CalendarGrant,
    input: CalendarEventInput,
    requestKey: string,
  ): Promise<unknown> {
    requireScope(grant, CALENDAR_WRITE_SCOPE);
    const eventId = createHash("sha256").update(requestKey).digest("hex").slice(0, 32);
    const url = new URL(`${GOOGLE_CALENDAR_ENDPOINT}/calendars/primary/events`);
    const event = { id: eventId, ...eventBody(input) };
    try {
      const body = await this.authorizedJson(grant, url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      return eventResult(GoogleEvent.parse(body));
    } catch (error) {
      if (!(error instanceof GoogleCalendarError) || error.code !== "google_conflict") throw error;
      // A retry after an uncertain response must not create a duplicate. The stable event
      // id lets the broker return the already-created event as the original success.
      const existing = await this.authorizedJson(
        grant,
        new URL(`${GOOGLE_CALENDAR_ENDPOINT}/calendars/primary/events/${eventId}`),
        { method: "GET" },
      );
      return eventResult(GoogleEvent.parse(existing));
    }
  }

  async updateEvent(grant: CalendarGrant, input: CalendarEventUpdate): Promise<unknown> {
    requireScope(grant, CALENDAR_WRITE_SCOPE);
    const url = new URL(
      `${GOOGLE_CALENDAR_ENDPOINT}/calendars/primary/events/${encodeURIComponent(input.event_id)}`,
    );
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.summary = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.location !== undefined) patch.location = input.location;
    if (input.attendees !== undefined) patch.attendees = input.attendees.map((email) => ({ email }));
    if (input.status !== undefined) patch.status = input.status;
    if (input.start !== undefined) patch.start = eventTime(input.start, input.time_zone);
    if (input.end !== undefined) patch.end = eventTime(input.end, input.time_zone);
    if (Object.keys(patch).length === 0) {
      throw new GoogleCalendarError("empty_update", "A calendar update needs a changed field");
    }
    const body = await this.authorizedJson(grant, url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return eventResult(GoogleEvent.parse(body));
  }

  private async authorizedJson(
    grant: CalendarGrant,
    url: URL,
    init: RequestInit,
  ): Promise<unknown> {
    if (grant.status !== "active") {
      throw new GoogleCalendarError("reconnect_required", "Google Calendar must be reconnected");
    }
    const accessToken = await this.refreshAccessToken(grant.refreshToken);
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await boundedJson(response);
    if (!response.ok) {
      throw new GoogleCalendarError(
        response.status === 409 ? "google_conflict" : `google_http_${response.status}`,
        "Google Calendar rejected the request",
      );
    }
    return body;
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const response = await this.fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.configuration.clientId,
        client_secret: this.configuration.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await boundedJson(response);
    if (!response.ok) {
      // Google says a refresh token is dead in exactly one way, and a revoked grant is the
      // only failure here the user can do anything about. A 500, a rate limit, or a
      // misconfigured OAuth client all used to arrive as the same `refresh_failed`, which
      // marked the stored grant unusable — so one bad minute at Google cost the user a
      // whole re-authorization, and every request after it was refused by a broker that
      // had already made up its mind.
      throw refreshTokenIsRevoked(response.status, body)
        ? new GoogleCalendarError("refresh_revoked", "Google Calendar must be reconnected")
        : new GoogleCalendarError(
            "refresh_unavailable",
            "Google could not issue a Calendar token just now",
          );
    }
    return TokenResponse.parse(body).access_token;
  }
}

/**
 * Whether Google is saying the grant is gone, rather than that it could not answer.
 *
 * Deliberately narrow, and deliberately not a catch-all on 4xx: `invalid_client` and
 * `unauthorized_client` mean the *operator's* OAuth client is wrong, which no amount of
 * user re-consent fixes, and revoking their grant over it would only hide the real fault.
 */
function refreshTokenIsRevoked(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 401) return false;
  const error = body !== null && typeof body === "object"
    ? (body as { error?: unknown }).error
    : null;
  return error === "invalid_grant";
}

function eventBody(input: CalendarEventInput): Record<string, unknown> {
  return {
    summary: input.title,
    start: eventTime(input.start, input.time_zone),
    end: eventTime(input.end, input.time_zone),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.attendees === undefined
      ? {}
      : { attendees: input.attendees.map((email) => ({ email })) }),
  };
}

function eventTime(value: string, timeZone?: string): Record<string, string> {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? { date: value }
    : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

function eventResult(event: z.infer<typeof GoogleEvent>): Record<string, unknown> {
  return {
    id: event.id,
    title: event.summary ?? null,
    starts_at: event.start?.dateTime ?? event.start?.date ?? null,
    ends_at: event.end?.dateTime ?? event.end?.date ?? null,
    location: event.location ?? null,
    status: event.status ?? null,
  };
}

function requireScope(grant: CalendarGrant, scope: string): void {
  if (!grant.scopes.includes(scope)) {
    throw new GoogleCalendarError("insufficient_scope", "Google Calendar write access is not granted");
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new GoogleCalendarError("response_too_large", "Google returned too much data");
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GoogleCalendarError("invalid_response", "Google returned an invalid response");
  }
}

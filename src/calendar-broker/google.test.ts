import { describe, expect, it, vi } from "vitest";

import {
  CALENDAR_READ_SCOPE,
  CALENDAR_WRITE_SCOPE,
  exchangeGoogleCode,
  GoogleCalendarApi,
  googleAuthorizationUrl,
} from "./google";
import type { CalendarGrant } from "./store";

const OAUTH = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://calendar-dev.zeusagent.dev/oauth/google/callback",
};

describe("Google OAuth and Calendar API", () => {
  it("requests offline, incremental, least-privilege consent", () => {
    const read = googleAuthorizationUrl({
      configuration: OAUTH,
      state: "state",
      permission: "read",
    });
    const write = googleAuthorizationUrl({
      configuration: OAUTH,
      state: "state",
      permission: "write",
    });

    expect(read.searchParams.get("scope")).toBe(CALENDAR_READ_SCOPE);
    expect(write.searchParams.get("scope")).toBe(CALENDAR_WRITE_SCOPE);
    expect(read.searchParams.get("access_type")).toBe("offline");
    expect(read.searchParams.get("include_granted_scopes")).toBe("true");
    expect(read.searchParams.get("prompt")).toBe("consent");
  });

  it("exchanges a server-side code without exposing the client secret in a URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: "access",
      refresh_token: "refresh",
      scope: `${CALENDAR_READ_SCOPE} ${CALENDAR_WRITE_SCOPE}`,
    }));

    await expect(exchangeGoogleCode("code", OAUTH, fetcher)).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      scopes: [CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE],
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).not.toContain("client-secret");
    expect(String(init?.body)).toContain("client_secret=client-secret");
  });

  it("maps bounded primary-calendar events into Zeus's disposable event shape", async () => {
    const fetcher = googleFetch([
      Response.json({ access_token: "access" }),
      Response.json({
        items: [{
          id: "evt-1",
          summary: "Private appointment",
          start: { dateTime: "2026-08-15T10:00:00+08:00" },
          end: { dateTime: "2026-08-15T11:00:00+08:00" },
          location: "Office",
        }],
      }),
    ]);
    const api = new GoogleCalendarApi(OAUTH, fetcher);

    await expect(api.listEvents(grant([CALENDAR_READ_SCOPE]),
      "2026-08-14T00:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
    )).resolves.toEqual({
      events: [{
        id: "evt-1",
        title: "Private appointment",
        starts_at: "2026-08-15T10:00:00+08:00",
        ends_at: "2026-08-15T11:00:00+08:00",
        location: "Office",
        status: null,
      }],
    });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("calendars/primary/events");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("maxResults=250");
  });

  it("uses a deterministic event id so an uncertain retry cannot create a duplicate", async () => {
    const existing = {
      id: "event-id",
      summary: "Planning",
      start: { dateTime: "2026-08-15T10:00:00Z" },
      end: { dateTime: "2026-08-15T11:00:00Z" },
    };
    const fetcher = googleFetch([
      Response.json({ access_token: "access" }),
      Response.json({ error: "duplicate" }, { status: 409 }),
      Response.json({ access_token: "access" }),
      Response.json(existing),
    ]);
    const api = new GoogleCalendarApi(OAUTH, fetcher);

    await expect(api.createEvent(
      grant([CALENDAR_WRITE_SCOPE]),
      {
        title: "Planning",
        start: "2026-08-15T10:00:00Z",
        end: "2026-08-15T11:00:00Z",
      },
      "effect-request-key",
    )).resolves.toMatchObject({ title: "Planning" });

    const createBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { id: string };
    expect(createBody.id).toMatch(/^[0-9a-f]{32}$/u);
    expect(String(fetcher.mock.calls[3]?.[0])).toContain(createBody.id);
  });

  it("refuses writes when the user granted read-only access", async () => {
    const api = new GoogleCalendarApi(OAUTH, vi.fn<typeof fetch>());
    await expect(api.createEvent(
      grant([CALENDAR_READ_SCOPE]),
      { title: "No", start: "2026-08-15", end: "2026-08-16" },
      "request",
    )).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  // Retiring a grant is a one-way door: the user has to go back through consent to reopen
  // it. Everything below exists so that door is only opened by Google saying the token is
  // dead, and never by Google having a bad minute.
  it("retires the grant only when Google says the refresh token is invalid", async () => {
    const api = new GoogleCalendarApi(
      OAUTH,
      googleFetch([Response.json({ error: "invalid_grant" }, { status: 400 })]),
    );

    await expect(
      api.listEvents(grant([CALENDAR_READ_SCOPE]), "2026-08-15", "2026-08-16"),
    ).rejects.toMatchObject({ code: "refresh_revoked" });
  });

  it("treats a token endpoint that is merely unavailable as unavailable", async () => {
    for (const response of [
      Response.json({ error: "internal_failure" }, { status: 500 }),
      Response.json({ error: "rate_limit_exceeded" }, { status: 429 }),
      // An operator's broken OAuth client. No amount of user re-consent fixes it, and
      // revoking their grant over it would only bury the real fault.
      Response.json({ error: "invalid_client" }, { status: 401 }),
    ]) {
      const api = new GoogleCalendarApi(OAUTH, googleFetch([response]));
      await expect(
        api.listEvents(grant([CALENDAR_READ_SCOPE]), "2026-08-15", "2026-08-16"),
      ).rejects.toMatchObject({ code: "refresh_unavailable" });
    }
  });
});

function grant(scopes: string[]): CalendarGrant {
  return {
    id: "grant",
    accountId: "account",
    refreshToken: "refresh",
    scopes,
    status: "active",
  };
}

function googleFetch(responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
}

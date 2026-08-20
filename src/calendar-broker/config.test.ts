import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { calendarBrokerConfiguration } from "./config";

const BASE = {
  NODE_ENV: "test",
  GOOGLE_CALENDAR_BROKER_DB: "/data/google-calendar-broker.db",
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  GOOGLE_CALENDAR_BROKER_SERVICE_KEY: "c".repeat(40),
  ZEUS_APP_URL: "https://www.zeusagent.dev",
  GOOGLE_OAUTH_CLIENT_ID: "calendar-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "calendar-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "https://calendar.zeusagent.dev/oauth/google/callback",
} satisfies NodeJS.ProcessEnv;

describe("Calendar broker Gmail configuration", () => {
  it("keeps the existing Calendar broker valid when Gmail is not configured", () => {
    expect(calendarBrokerConfiguration(BASE).gmail).toBeUndefined();
  });

  it("requires a complete, separately keyed Gmail OAuth client", () => {
    expect(() => calendarBrokerConfiguration({
      ...BASE,
      GOOGLE_GMAIL_OAUTH_CLIENT_ID: "gmail-client",
    })).toThrow();
    expect(() => calendarBrokerConfiguration({
      ...BASE,
      GOOGLE_GMAIL_BROKER_SERVICE_KEY: "c".repeat(40),
      GOOGLE_GMAIL_OAUTH_CLIENT_ID: "gmail-client",
      GOOGLE_GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret",
      GOOGLE_GMAIL_OAUTH_REDIRECT_URI: "https://calendar.zeusagent.dev/oauth/gmail/callback",
    })).toThrow(/service keys must be different/u);
    expect(() => calendarBrokerConfiguration({
      ...BASE,
      GOOGLE_GMAIL_BROKER_SERVICE_KEY: "g".repeat(40),
      GOOGLE_GMAIL_OAUTH_CLIENT_ID: "calendar-client",
      GOOGLE_GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret",
      GOOGLE_GMAIL_OAUTH_REDIRECT_URI: "https://calendar.zeusagent.dev/oauth/gmail/callback",
    })).toThrow(/OAuth clients must be different/u);

    expect(calendarBrokerConfiguration({
      ...BASE,
      GOOGLE_GMAIL_BROKER_SERVICE_KEY: "g".repeat(40),
      GOOGLE_GMAIL_OAUTH_CLIENT_ID: "gmail-client",
      GOOGLE_GMAIL_OAUTH_CLIENT_SECRET: "gmail-secret",
      GOOGLE_GMAIL_OAUTH_REDIRECT_URI: "https://calendar.zeusagent.dev/oauth/gmail/callback",
    }).gmail).toEqual({
      serviceKey: "g".repeat(40),
      clientId: "gmail-client",
      clientSecret: "gmail-secret",
      redirectUri: "https://calendar.zeusagent.dev/oauth/gmail/callback",
    });
  });
});

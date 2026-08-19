import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getGoogleGmailIntegrationConfiguration } from "./config";

describe("Google Gmail integration configuration", () => {
  it("stays unavailable until both broker values are configured", () => {
    expect(getGoogleGmailIntegrationConfiguration({})).toEqual({ state: "unconfigured" });
    expect(getGoogleGmailIntegrationConfiguration({
      GOOGLE_GMAIL_BROKER_URL: "https://calendar-dev.zeusagent.dev",
    })).toMatchObject({ state: "misconfigured" });
  });

  it("accepts only an exact HTTPS broker origin and a strong service key", () => {
    expect(getGoogleGmailIntegrationConfiguration({
      GOOGLE_GMAIL_BROKER_URL: "https://calendar-dev.zeusagent.dev",
      GOOGLE_GMAIL_BROKER_SERVICE_KEY: "g".repeat(40),
    })).toEqual({
      state: "ready",
      brokerUrl: "https://calendar-dev.zeusagent.dev",
      serviceKey: "g".repeat(40),
    });
    expect(getGoogleGmailIntegrationConfiguration({
      GOOGLE_GMAIL_BROKER_URL: "http://calendar-dev.zeusagent.dev",
      GOOGLE_GMAIL_BROKER_SERVICE_KEY: "g".repeat(40),
    })).toMatchObject({ state: "misconfigured" });
  });
});

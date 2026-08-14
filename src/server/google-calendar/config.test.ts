import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getGoogleCalendarIntegrationConfiguration } from "./config";

describe("Google Calendar integration configuration", () => {
  it("stays unavailable until both broker values are configured", () => {
    expect(getGoogleCalendarIntegrationConfiguration({})).toEqual({ state: "unconfigured" });
    expect(getGoogleCalendarIntegrationConfiguration({
      GOOGLE_CALENDAR_BROKER_URL: "https://calendar-dev.zeusagent.dev",
    })).toMatchObject({ state: "misconfigured" });
  });

  it("accepts only an exact HTTPS broker origin and a strong service key", () => {
    expect(getGoogleCalendarIntegrationConfiguration({
      GOOGLE_CALENDAR_BROKER_URL: "https://calendar-dev.zeusagent.dev",
      GOOGLE_CALENDAR_BROKER_SERVICE_KEY: "s".repeat(40),
    })).toEqual({
      state: "ready",
      brokerUrl: "https://calendar-dev.zeusagent.dev",
      serviceKey: "s".repeat(40),
    });
    expect(getGoogleCalendarIntegrationConfiguration({
      GOOGLE_CALENDAR_BROKER_URL: "http://calendar-dev.zeusagent.dev",
      GOOGLE_CALENDAR_BROKER_SERVICE_KEY: "s".repeat(40),
    })).toMatchObject({ state: "misconfigured" });
    expect(getGoogleCalendarIntegrationConfiguration({
      GOOGLE_CALENDAR_BROKER_URL: "https://calendar-dev.zeusagent.dev/mcp",
      GOOGLE_CALENDAR_BROKER_SERVICE_KEY: "s".repeat(40),
    })).toMatchObject({ state: "misconfigured" });
  });
});

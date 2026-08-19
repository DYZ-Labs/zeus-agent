import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ConnectorView } from "@/core/connectors";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/actions", () => ({
  configureConnectorPresetAction: async () => ({
    status: "idle",
    code: "idle",
    message: "",
  }),
  disconnectGoogleCalendarAction: async () => undefined,
  removeConnectorAction: async () => undefined,
}));

import { GoogleCalendarConnection } from "./google-calendar-connection";

describe("GoogleCalendarConnection", () => {
  it("shows a connect button when Google Calendar is not connected", () => {
    const html = renderToStaticMarkup(createElement(GoogleCalendarConnection, {
      connector: null,
      localMode: false,
      available: true,
    }));

    expect(html).toContain("Not connected");
    expect(html).toContain(">Connect</a>");
  });

  it("shows connection state without capability descriptions", () => {
    const html = renderToStaticMarkup(createElement(GoogleCalendarConnection, {
      connector: connectedCalendar(),
      localMode: false,
      available: true,
    }));

    expect(html).toContain("Connected");
    expect(html).toContain(">Disconnect</button>");
    expect(html).not.toMatch(/Read events|Create events|Update events|what Zeus may do/iu);
  });
});

function connectedCalendar(): ConnectorView {
  const timestamp = "2026-08-19T00:00:00.000Z";
  return {
    id: 1,
    preset_id: null,
    label: "Google Calendar",
    provider: "google_calendar",
    provider_connection_id: "00000000-0000-4000-8000-000000000000",
    transport: "http",
    command: null,
    args_json: "[]",
    cwd: null,
    url: "https://calendar.example.test/mcp/connection",
    env_var_names_json: "[]",
    discovered_tools_json: "[]",
    status: "ready",
    enabled: 1,
    source_message_id: 1,
    last_verified_at: timestamp,
    last_error_code: null,
    created_at: timestamp,
    updated_at: timestamp,
    args: [],
    envVarNames: [],
    missingEnvVarNames: [],
    discoveredTools: [],
    capabilities: [],
  };
}

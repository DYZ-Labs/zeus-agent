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
  disconnectGoogleGmailAction: async () => undefined,
  removeConnectorAction: async () => undefined,
}));

import { CalendarIcon, MailIcon, PresetConnection } from "./preset-connection";
import { GMAIL_PRESET, GOOGLE_CALENDAR_PRESET } from "@/core/connector-catalog";

describe("PresetConnection", () => {
  it("shows a connect button when Google Calendar is not connected", () => {
    const html = renderToStaticMarkup(createElement(PresetConnection, {
      preset: GOOGLE_CALENDAR_PRESET,
      icon: createElement(CalendarIcon),
      defaultSlots: ["calendar.list_events"],
      hostedStartHref: "/api/integrations/google-calendar/start?permission=read",
      connector: null,
      localMode: false,
      available: true,
    }));

    expect(html).toContain("Not connected");
    expect(html).toContain(">Connect</a>");
  });

  it("shows connection state without capability descriptions", () => {
    const html = renderToStaticMarkup(createElement(PresetConnection, {
      preset: GOOGLE_CALENDAR_PRESET,
      icon: createElement(CalendarIcon),
      defaultSlots: ["calendar.list_events"],
      hostedStartHref: "/api/integrations/google-calendar/start?permission=read",
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

describe("Gmail is a second connection, not a second component", () => {
  it("renders Gmail from its preset, with its own slots", () => {
    const html = renderToStaticMarkup(
      createElement(PresetConnection, {
        preset: GMAIL_PRESET,
        icon: createElement(MailIcon),
        defaultSlots: ["email.search_threads", "email.get_thread"],
        connector: null,
        localMode: true,
        available: true,
      }),
    );

    expect(html).toContain("Gmail");
    expect(html).toContain("gmail-official");
    expect(html).toContain("email.search_threads");
    expect(html).toContain("email.get_thread");
    // Nothing calendar-shaped leaks in from the component's former identity.
    expect(html).not.toContain("calendar.list_events");
  });

  it("starts the account-bound hosted Gmail OAuth path when it is configured", () => {
    const html = renderToStaticMarkup(
      createElement(PresetConnection, {
        preset: GMAIL_PRESET,
        icon: createElement(MailIcon),
        defaultSlots: ["email.search_threads"],
        hostedStartHref: "/api/integrations/google-gmail/start",
        connector: null,
        localMode: false,
        available: true,
      }),
    );

    expect(html).toContain('/api/integrations/google-gmail/start');
    expect(html).toContain(">Connect</a>");
  });
})

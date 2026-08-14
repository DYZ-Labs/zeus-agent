import { describe, expect, it } from "vitest";

import {
  GOOGLE_CALENDAR_MCP_URL,
  GOOGLE_CALENDAR_PRESET,
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  connectorPresetScopes,
  getConnectorPreset,
  googleCalendarAdcLoginCommand,
  localConnectorPresetsAllowed,
  presetCapability,
} from "./connector-catalog";

describe("connector catalog", () => {
  it("owns the official Calendar endpoint and exact slot-to-tool mapping", () => {
    expect(getConnectorPreset("google-calendar-official")).toBe(GOOGLE_CALENDAR_PRESET);
    expect(getConnectorPreset("browser-supplied-preset")).toBeNull();
    expect(GOOGLE_CALENDAR_PRESET.url).toBe(GOOGLE_CALENDAR_MCP_URL);
    expect(
      GOOGLE_CALENDAR_PRESET.capabilities.map(({ slot, remoteToolName }) => [
        slot,
        remoteToolName,
      ]),
    ).toEqual([
      ["calendar.list_events", "list_events"],
      ["calendar.create_event", "create_event"],
      ["calendar.update_event", "update_event"],
    ]);
  });

  it("derives minimum scopes from only the slots the user selected", () => {
    const read = connectorPresetScopes(GOOGLE_CALENDAR_PRESET, [
      "calendar.list_events",
    ]);
    expect(read).toContain(GOOGLE_CALENDAR_READ_SCOPE);
    expect(read).not.toContain(GOOGLE_CALENDAR_WRITE_SCOPE);

    const write = connectorPresetScopes(GOOGLE_CALENDAR_PRESET, [
      "calendar.create_event",
      "calendar.update_event",
    ]);
    expect(write).toContain(GOOGLE_CALENDAR_WRITE_SCOPE);
    expect(new Set(write).size).toBe(write.length);
    expect(googleCalendarAdcLoginCommand(["calendar.list_events"])).toContain(
      `--scopes=${read.join(",")}`,
    );
  });

  it("refuses slots outside a preset and disables local presets in hosted mode", () => {
    expect(presetCapability(GOOGLE_CALENDAR_PRESET, "calendar.list_events")?.remoteToolName)
      .toBe("list_events");
    expect(localConnectorPresetsAllowed({})).toBe(true);
    expect(
      localConnectorPresetsAllowed({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }),
    ).toBe(false);
    expect(
      localConnectorPresetsAllowed({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public" }),
    ).toBe(false);
  });
});

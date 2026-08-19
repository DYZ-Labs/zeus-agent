import { describe, expect, it } from "vitest";

import {
  GMAIL_PRESET,
  GOOGLE_CALENDAR_MCP_URL,
  GOOGLE_CALENDAR_PRESET,
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  connectorPresetScopes,
  getConnectorPreset,
  googleAdcLoginCommand,
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
    expect(googleAdcLoginCommand(GOOGLE_CALENDAR_PRESET, ["calendar.list_events"])).toContain(
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

describe("the Gmail preset", () => {
  it("asks for read access and nothing else", () => {
    // Verified against the live server on 2026-08-20: a gmail.readonly-only token connects
    // and lists tools, despite the setup guide saying to add gmail.compose too. Declaring
    // the narrower scope is the point of read-only-first, so it is worth a test.
    const scopes = connectorPresetScopes(GMAIL_PRESET, [
      "email.search_threads",
      "email.get_thread",
    ]);

    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(scopes.filter((scope) => scope.includes("gmail"))).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  it("cannot fill a slot it does not name, including any write", () => {
    // The live server offers twenty-one tools, ten of them undocumented writes — trashing
    // threads, marking spam. None is reachable, because a preset capability is bound by this
    // catalog rather than by what the server advertises.
    expect(presetCapability(GMAIL_PRESET, "email.search_threads")?.remoteToolName).toBe(
      "search_threads",
    );
    expect(presetCapability(GMAIL_PRESET, "calendar.create_event")).toBeNull();
    expect(() =>
      connectorPresetScopes(GMAIL_PRESET, ["calendar.list_events"]),
    ).toThrow(/cannot fill/u);
  });

  it("is local-only, like every preset that spends process-wide credentials", () => {
    expect(GMAIL_PRESET.localOnly).toBe(true);
    expect(GMAIL_PRESET.authentication).toBe("google_adc");
    expect(getConnectorPreset(GMAIL_PRESET.id)).toBe(GMAIL_PRESET);
  });
})

import type { CapabilitySlot } from "./schema";

/**
 * A catalog entry is code-owned configuration, not user-authored connector data. The
 * browser submits only the stable id and selected Zeus slots; the endpoint, remote tool
 * names, and scopes are always resolved again in trusted code.
 */
export type ConnectorPresetCapability = {
  slot: CapabilitySlot;
  remoteToolName: string;
  scopes: readonly string[];
};

export type ConnectorPreset = {
  id: string;
  label: string;
  description: string;
  badge: string | null;
  transport: "http";
  url: string;
  documentationUrl: string;
  setupUrl: string;
  localOnly: true;
  authentication: "google_adc";
  capabilities: readonly ConnectorPresetCapability[];
};

export const GOOGLE_CALENDAR_PRESET_ID = "google-calendar-official";

export const GOOGLE_CALENDAR_MCP_URL =
  "https://calendarmcp.googleapis.com/mcp/v1";

export const GOOGLE_CALENDAR_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";

export const GOOGLE_CALENDAR_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

export const GOOGLE_ADC_BASE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/cloud-platform",
] as const;

export const GOOGLE_CALENDAR_PRESET = {
  id: GOOGLE_CALENDAR_PRESET_ID,
  label: "Google Calendar",
  description: "Read your schedule and prepare calendar changes through Google's official MCP server.",
  badge: "Developer Preview",
  transport: "http",
  url: GOOGLE_CALENDAR_MCP_URL,
  documentationUrl: "https://developers.google.com/workspace/calendar/api/v3/reference/mcp",
  setupUrl: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
  localOnly: true,
  authentication: "google_adc",
  capabilities: [
    {
      slot: "calendar.list_events",
      remoteToolName: "list_events",
      scopes: [GOOGLE_CALENDAR_READ_SCOPE],
    },
    {
      slot: "calendar.create_event",
      remoteToolName: "create_event",
      scopes: [GOOGLE_CALENDAR_WRITE_SCOPE],
    },
    {
      slot: "calendar.update_event",
      remoteToolName: "update_event",
      scopes: [GOOGLE_CALENDAR_WRITE_SCOPE],
    },
  ],
} as const satisfies ConnectorPreset;

export const CONNECTOR_PRESETS = [GOOGLE_CALENDAR_PRESET] as const;

export function getConnectorPreset(id: string): ConnectorPreset | null {
  return CONNECTOR_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function presetCapability(
  preset: ConnectorPreset,
  slot: CapabilitySlot,
): ConnectorPresetCapability | null {
  return preset.capabilities.find((capability) => capability.slot === slot) ?? null;
}

/** Minimum ADC scopes for exactly the slots the user selected. */
export function connectorPresetScopes(
  preset: ConnectorPreset,
  slots: readonly CapabilitySlot[],
): string[] {
  const scopes = new Set<string>(GOOGLE_ADC_BASE_SCOPES);
  for (const slot of slots) {
    const capability = presetCapability(preset, slot);
    if (!capability) throw new Error(`The ${preset.label} preset cannot fill ${slot}.`);
    for (const scope of capability.scopes) scopes.add(scope);
  }
  return [...scopes];
}

export function googleCalendarAdcLoginCommand(
  slots: readonly CapabilitySlot[],
): string {
  const scopes = connectorPresetScopes(GOOGLE_CALENDAR_PRESET, slots);
  return (
    "gcloud auth application-default login " +
    "--client-id-file=/path/to/client_secret.json " +
    `--scopes=${scopes.join(",")}`
  );
}

/**
 * The web front door calls the richer owner-access check. Core repeats the environment
 * half of that rule so a local preset cannot start using process-global ADC if a legacy
 * store is later opened by a hosted multi-account deployment.
 */
export function localConnectorPresetsAllowed(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !(
    environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
  );
}

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
  return singleAccountDeployment(environment);
}

/**
 * The same environment question, asked for a heavier reason.
 *
 * A stdio connector is a program Zeus starts as itself. Where the store belongs to the one
 * person at the keyboard that is the whole point: the child runs as them, over their files.
 * In a hosted deployment every account's store is a file in one directory owned by one OS
 * user, so any spawned child could read every other account's memory and the operator's
 * own environment. No amount of argument validation reaches that, because the thing being
 * granted is "run a program here", not "run this program". Core repeats the front door's
 * environment check rather than trusting the page that rendered the form, and callers ask
 * again at spawn time: configuration written while a deployment was local outlives the day
 * it stops being local.
 */
export function stdioConnectorsAllowed(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return singleAccountDeployment(environment);
}

/**
 * The same environment question again, for the credentials rather than the program.
 *
 * A connector names environment variables and Zeus reads their values at call time. Where
 * one person runs Zeus that is honest: the process environment is their own, and naming
 * `CALENDAR_TOKEN` hands their own token to their own server. Hosted, the very same
 * mechanism reads the *operator's* environment on a *user's* behalf, and an HTTP connector
 * pointed at a host the user controls returns it as that request's bearer token — no
 * capability, no plan, no payload confirmation in the way.
 *
 * Refusing the mechanism outright is the only version of this rule that holds. A denylist
 * of sensitive namespaces protects whichever names someone thought of: the operator's
 * environment also holds the variables of every service they run beside Zeus, and the next
 * one added is not on the list. Nothing is lost by refusing — hosted Google Calendar
 * authenticates through the broker, which never touches this path, and a hosted deployment
 * has no other legitimate reason to hand a user's connector the operator's secrets.
 */
export function connectorEnvironmentAllowed(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return singleAccountDeployment(environment);
}

/**
 * Supabase configuration is what turns this store into one account among many, and its
 * absence is the only signal framework-free core can read. Every rule above derives from
 * this one predicate so "hosted" cannot come to mean two different things.
 */
function singleAccountDeployment(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return !(
    environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
  );
}

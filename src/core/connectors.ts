import { createHash } from "node:crypto";

import {
  type ConnectorPreset,
  connectorEnvironmentAllowed,
  getConnectorPreset,
  localConnectorPresetsAllowed,
  presetCapability,
  stdioConnectorsAllowed,
} from "./connector-catalog";
import type { Db } from "./db";
import { now } from "./db";
import type {
  CapabilitySlot,
  Connector,
  ConnectorCapability,
  ConnectorStatus,
  ConnectorTransport,
  EffectKind,
} from "./schema";
import { CAPABILITY_SLOT_EFFECTS } from "./schema";

/**
 * Connectors: how Zeus reaches anything outside its own store.
 *
 * A connector is an MCP server the user configured or selected from the code-owned
 * catalog. Zeus is the client, which keeps "no adapter means no action" literally true.
 * The table records a preset id or reachability configuration and environment-variable
 * names, never credential values. Catalog authentication is materialized only in the MCP
 * client for the lifetime of one exchange.
 *
 * Discovering a remote tool is not the same as granting it. A capability is a deliberate
 * binding of one discovered tool to one Zeus slot, and the slot fixes the effect kind, so
 * reviewing the bound slots is enough to understand everything a connector may do. The
 * remote tool's input schema is hashed at bind time: a server that later changes what
 * "create an event" accepts is disabled and must be reviewed again rather than silently
 * obeyed.
 */

const MAX_LABEL = 120;
const MAX_COMMAND = 500;
const MAX_ARGS = 32;
const MAX_ARG = 500;
const MAX_ENV_VAR_NAMES = 16;
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
// A plain executable name or path. `spawn` runs without a shell, so this is belt and
// braces — but a command containing shell syntax is a sign of a misunderstanding worth
// refusing at the boundary rather than silently accepting as a literal filename.
const SHELL_METACHARACTER = /[;&|<>$`\n\r]/u;

export const CAPABILITY_SLOTS = [
  "calendar.list_events",
  "calendar.create_event",
  "calendar.update_event",
  "email.search_threads",
  "email.get_thread",
] as const satisfies readonly CapabilitySlot[];

/**
 * The slots that mean "this connector is a calendar".
 *
 * Two callers used membership in `CAPABILITY_SLOTS` to ask that question, which was the same
 * question only while calendar was the sole capability. `satisfies` does not enforce
 * exhaustiveness, so nothing would have failed when email joined the list — a Gmail-only
 * connector would simply have started answering yes, and the capability block would have
 * told the user a calendar was connected.
 */
export const CALENDAR_CAPABILITY_SLOTS = [
  "calendar.list_events",
  "calendar.create_event",
  "calendar.update_event",
] as const satisfies readonly CapabilitySlot[];

export const GOOGLE_CALENDAR_BROKER_SERVICE_KEY =
  "GOOGLE_CALENDAR_BROKER_SERVICE_KEY";
export const GOOGLE_CALENDAR_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_CALENDAR_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

/** What one handshake found. Advisory: Zeus decides effects from the slot, not from this. */
export type DiscoveredToolSummary = {
  name: string;
  description: string | null;
  inputSchema: unknown;
  schemaHash: string;
  readOnlyHint: boolean | null;
};

export type ConnectorView = Connector & {
  args: string[];
  envVarNames: string[];
  /** Configured names with no value in this process. A connector cannot work without them. */
  missingEnvVarNames: string[];
  discoveredTools: DiscoveredToolSummary[];
  capabilities: ConnectorCapability[];
};

export type CreateConnectorInput = {
  label: string;
  transport: ConnectorTransport;
  command?: string | null;
  args?: readonly string[];
  cwd?: string | null;
  url?: string | null;
  envVarNames?: readonly string[];
  sourceMessageId: number;
};

export type ConfigureConnectorPresetInput = {
  presetId: string;
  selectedSlots: readonly CapabilitySlot[];
  discoveredTools: readonly DiscoveredToolSummary[];
  sourceMessageId: number;
  /** Omit for first setup; provide the exact existing connector for a permission update. */
  connectorId?: number;
};

export class ConnectorPresetError extends Error {
  constructor(
    readonly code:
      | "invalid_preset"
      | "invalid_permissions"
      | "invalid_preset_configuration"
      | "already_connected"
      | "tool_contract_changed",
    message: string,
  ) {
    super(message);
    this.name = "ConnectorPresetError";
  }
}

export type BindCapabilityInput = {
  connectorId: number;
  slot: CapabilitySlot;
  remoteToolName: string;
  inputSchema: unknown;
  sourceMessageId: number;
};

export type BoundCapability = {
  capability: ConnectorCapability;
  connector: ConnectorView;
};

export type ConnectorVerification =
  | { status: "ready"; verifiedAt?: string; tools?: readonly DiscoveredToolSummary[] }
  | { status: "unreachable"; errorCode: string };

const SELECT_CONNECTOR = `
  SELECT id, preset_id, label, provider, provider_connection_id, transport, command,
         args_json, cwd, url, env_var_names_json,
         discovered_tools_json, status, enabled, source_message_id, last_verified_at,
         last_error_code, created_at, updated_at
  FROM connector
`;

const SELECT_CAPABILITY = `
  SELECT id, connector_id, slot, remote_tool_name, effect_kind, input_schema_json,
         schema_hash, enabled, source_message_id, created_at, updated_at
  FROM connector_capability
`;

/** Stable digest of a remote tool's input contract. Key order must not change it. */
export function toolSchemaHash(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

export function createConnector(db: Db, input: CreateConnectorInput): ConnectorView {
  assertUserMessage(db, input.sourceMessageId);
  const label = normalizedText(input.label, MAX_LABEL, "connector label");
  const args = normalizedArgs(input.args ?? []);
  const envVarNames = normalizedEnvVarNames(input.envVarNames ?? []);
  const timestamp = now();

  let command: string | null = null;
  let cwd: string | null = null;
  let url: string | null = null;
  if (input.transport === "stdio") {
    assertStdioConnectorsAllowed();
    command = normalizedCommand(input.command);
    cwd = input.cwd ? normalizedText(input.cwd, MAX_COMMAND, "connector directory") : null;
  } else {
    url = normalizedUrl(input.url);
  }

  const inserted = db
    .prepare<
      [string, ConnectorTransport, string | null, string, string | null, string | null,
       string, number, string, string]
    >(
      `INSERT INTO connector
         (label, transport, command, args_json, cwd, url, env_var_names_json,
          source_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      label,
      input.transport,
      command,
      JSON.stringify(args),
      cwd,
      url,
      JSON.stringify(envVarNames),
      input.sourceMessageId,
      timestamp,
      timestamp,
    );
  const connector = getConnector(db, Number(inserted.lastInsertRowid));
  if (!connector) throw new Error("Connector vanished after insertion");
  return connector;
}

/**
 * Create or update one catalog connector from live discovery.
 *
 * The caller supplies only a preset id, selected Zeus slots, and the tools returned by a
 * just-completed handshake. Every sensitive configuration value is resolved from the
 * catalog again here. The surrounding action includes its curation message in the same
 * outer transaction, so any failure leaves neither configuration nor synthetic-looking
 * provenance behind.
 */
export function configureConnectorPreset(
  db: Db,
  input: ConfigureConnectorPresetInput,
): ConnectorView {
  assertUserMessage(db, input.sourceMessageId);
  const preset = getConnectorPreset(input.presetId);
  if (!preset) {
    throw new ConnectorPresetError("invalid_preset", "That connection preset is not available.");
  }
  const selectedSlots = normalizePresetSlots(preset, input.selectedSlots);
  const discovered = discoveredPresetTools(preset, selectedSlots, input.discoveredTools);
  const current = getConnectorByPresetId(db, preset.id);
  if (input.connectorId === undefined && current) {
    throw new ConnectorPresetError("already_connected", `${preset.label} is already connected.`);
  }
  if (
    input.connectorId !== undefined &&
    (!current || current.id !== input.connectorId)
  ) {
    throw new ConnectorPresetError(
      "invalid_preset_configuration",
      "That preset connection changed before the update was applied.",
    );
  }

  const existing = current;
  if (existing) {
    assertPresetConnectorConfiguration(existing);
    for (const slot of selectedSlots) {
      const capability = capabilityForSlot(db, existing.id, slot);
      const tool = discovered.get(slot)!;
      if (capability && capability.schema_hash !== tool.schemaHash) {
        throw new ConnectorPresetError(
          "tool_contract_changed",
          "Google changed a selected tool contract. Zeus left the existing grant disabled for review.",
        );
      }
    }
  }

  return db.transaction(() => {
    const connector = existing ?? insertPresetConnector(db, preset, input.sourceMessageId);
    recordConnectorVerification(db, connector.id, {
      status: "ready",
      tools: input.discoveredTools,
    });

    const selected = new Set(selectedSlots);
    const enabledCapabilityIds: number[] = [];
    for (const slot of selectedSlots) {
      const mapping = presetCapability(preset, slot)!;
      const tool = discovered.get(slot)!;
      const capability = bindCapability(db, {
        connectorId: connector.id,
        slot,
        remoteToolName: mapping.remoteToolName,
        inputSchema: tool.inputSchema,
        sourceMessageId: input.sourceMessageId,
      });
      enabledCapabilityIds.push(capability.id);
    }

    for (const capability of listCapabilities(db, connector.id)) {
      if (!selected.has(capability.slot)) {
        setCapabilityEnabled(db, capability.id, false, input.sourceMessageId);
      }
    }

    setConnectorEnabled(db, connector.id, true, input.sourceMessageId);
    for (const id of enabledCapabilityIds) {
      setCapabilityEnabled(db, id, true, input.sourceMessageId);
    }
    const configured = getConnector(db, connector.id);
    if (!configured) throw new Error("Preset connector vanished after configuration");
    return configured;
  })();
}

export function getConnectorByPresetId(db: Db, presetId: string): ConnectorView | null {
  const row = db
    .prepare<[string], Connector>(`${SELECT_CONNECTOR} WHERE preset_id = ?`)
    .get(presetId);
  return row ? connectorView(db, row) : null;
}

/** Validate stored reachability before preset authentication can be materialized. */
export function assertPresetConnectorConfiguration(
  connector: ConnectorView,
): ConnectorPreset | null {
  if (connector.preset_id === null) return null;
  const preset = getConnectorPreset(connector.preset_id);
  if (
    !preset ||
    connector.transport !== preset.transport ||
    connector.url !== preset.url ||
    connector.command !== null ||
    connector.cwd !== null ||
    connector.args.length !== 0 ||
    connector.envVarNames.length !== 0
  ) {
    throw new ConnectorPresetError(
      "invalid_preset_configuration",
      "That preset connector no longer matches Zeus's trusted catalog.",
    );
  }
  return preset;
}

export type UpsertGoogleCalendarConnectorInput = {
  connectionId: string;
  mcpUrl: string;
  sourceMessageId: number;
};

/**
 * Create the locked provider row reached only from the signed OAuth callback.
 *
 * Reconnecting preserves the connector and capability ids but disables every old grant
 * and clears cached calendar rows until a fresh handshake and scope-derived binding
 * complete. Capability ids are audit references, so replacing them would detach or block
 * historical tool receipts.
 */
export function upsertGoogleCalendarConnector(
  db: Db,
  input: UpsertGoogleCalendarConnectorInput,
): ConnectorView {
  assertUserMessage(db, input.sourceMessageId);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(input.connectionId)) {
    throw new Error("Invalid Google Calendar connection id");
  }
  const url = normalizedUrl(input.mcpUrl);
  const timestamp = now();
  const connectorId = db.transaction((): number => {
    const existing = db.prepare<[], { id: number }>(
      "SELECT id FROM connector WHERE provider = 'google_calendar'",
    ).get();
    if (existing) {
      db.prepare(
        `UPDATE connector
         SET label = 'Google Calendar', provider_connection_id = ?, url = ?,
             discovered_tools_json = '[]', status = 'unverified', enabled = 0,
             source_message_id = ?, last_verified_at = NULL, last_error_code = NULL,
             updated_at = ?
         WHERE id = ?`,
      ).run(input.connectionId, url, input.sourceMessageId, timestamp, existing.id);
      db.prepare(
        `UPDATE connector_capability
         SET enabled = 0, source_message_id = ?, updated_at = ?
         WHERE connector_id = ?`,
      ).run(input.sourceMessageId, timestamp, existing.id);
      db.prepare("DELETE FROM external_signal WHERE connector_id = ?").run(existing.id);
      return existing.id;
    }
    const inserted = db.prepare(
      `INSERT INTO connector
         (label, provider, provider_connection_id, transport, command, args_json, cwd, url,
          env_var_names_json, discovered_tools_json, status, enabled, source_message_id,
          created_at, updated_at)
       VALUES ('Google Calendar', 'google_calendar', ?, 'http', NULL, '[]', NULL, ?,
               '[]', '[]', 'unverified', 0, ?, ?, ?)`,
    ).run(input.connectionId, url, input.sourceMessageId, timestamp, timestamp);
    return Number(inserted.lastInsertRowid);
  }).immediate();
  const connector = getConnector(db, connectorId);
  if (!connector) throw new Error("Google Calendar connector vanished after insertion");
  return connector;
}

export function getConnector(db: Db, id: number): ConnectorView | null {
  const row = db.prepare<[number], Connector>(`${SELECT_CONNECTOR} WHERE id = ?`).get(id);
  return row ? connectorView(db, row) : null;
}

export function listConnectors(db: Db): ConnectorView[] {
  return db
    .prepare<[], Connector>(`${SELECT_CONNECTOR} ORDER BY id`)
    .all()
    .map((row) => connectorView(db, row));
}

function insertPresetConnector(
  db: Db,
  preset: ConnectorPreset,
  sourceMessageId: number,
): ConnectorView {
  const timestamp = now();
  const inserted = db.prepare<
    [string, string, ConnectorTransport, string, number, string, string]
  >(
    `INSERT INTO connector
       (preset_id, label, transport, args_json, url, env_var_names_json,
        source_message_id, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, '[]', ?, ?, ?)`,
  ).run(
    preset.id,
    preset.label,
    preset.transport,
    preset.url,
    sourceMessageId,
    timestamp,
    timestamp,
  );
  const connector = getConnector(db, Number(inserted.lastInsertRowid));
  if (!connector) throw new Error("Preset connector vanished after insertion");
  return connector;
}

function normalizePresetSlots(
  preset: ConnectorPreset,
  slots: readonly CapabilitySlot[],
): CapabilitySlot[] {
  if (slots.length === 0) {
    throw new ConnectorPresetError(
      "invalid_permissions",
      "Select at least one permission for this connection.",
    );
  }
  const unique = [...new Set(slots)];
  for (const slot of unique) {
    if (!presetCapability(preset, slot)) {
      throw new ConnectorPresetError(
        "invalid_permissions",
        `The ${preset.label} preset cannot fill ${slot}.`,
      );
    }
  }
  return unique;
}

function discoveredPresetTools(
  preset: ConnectorPreset,
  slots: readonly CapabilitySlot[],
  tools: readonly DiscoveredToolSummary[],
): Map<CapabilitySlot, DiscoveredToolSummary> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const discovered = new Map<CapabilitySlot, DiscoveredToolSummary>();
  for (const slot of slots) {
    const mapping = presetCapability(preset, slot)!;
    const tool = byName.get(mapping.remoteToolName);
    if (!tool || tool.schemaHash !== toolSchemaHash(tool.inputSchema)) {
      throw new ConnectorPresetError(
        "tool_contract_changed",
        `Google's ${mapping.remoteToolName} tool is missing or has an invalid contract.`,
      );
    }
    discovered.set(slot, tool);
  }
  return discovered;
}

export function getGoogleCalendarConnector(db: Db): ConnectorView | null {
  const row = db.prepare<[], Connector>(
    `${SELECT_CONNECTOR} WHERE provider = 'google_calendar'`,
  ).get();
  return row ? connectorView(db, row) : null;
}

/**
 * Remove a connector and every capability bound to it.
 *
 * Receipts survive: `tool_receipt.connector_capability_id` is nulled rather than cascaded,
 * because the record that Zeus once made a call is history, not configuration.
 */
export function deleteConnector(db: Db, id: number): boolean {
  return db.prepare<[number]>(
    "DELETE FROM connector WHERE id = ? AND provider = 'generic'",
  ).run(id).changes > 0;
}

/** Token revocation in the broker must succeed before this provider row is removed. */
export function deleteGoogleCalendarConnector(db: Db, id: number): boolean {
  return db.prepare<[number]>(
    "DELETE FROM connector WHERE id = ? AND provider = 'google_calendar'",
  ).run(id).changes > 0;
}

/** Record the outcome of a live handshake. Only a verified connector may be enabled. */
export function recordConnectorVerification(
  db: Db,
  id: number,
  verification: ConnectorVerification,
): ConnectorView | null {
  const timestamp = now();
  if (verification.status === "ready") {
    db.prepare<[string, string, string, number]>(
      `UPDATE connector
       SET status = 'ready', last_verified_at = ?, last_error_code = NULL,
           discovered_tools_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      verification.verifiedAt ?? timestamp,
      JSON.stringify(verification.tools ?? []),
      timestamp,
      id,
    );
  } else {
    // Losing reachability takes the connector out of service. The schema insists on it —
    // `enabled = 0 OR status = 'ready'` — and so does the planner, which must never be
    // offered a capability nothing can reach.
    //
    // What it no longer does is throw away the *grants*. Those rows record which slots the
    // user reviewed and accepted, and a server having a bad minute is not the user changing
    // their mind about any of it. Clearing them was unrecoverable in practice: a later
    // successful handshake sets `status` and has no user message to cite for consent, so one
    // timed-out request cost a full re-authorization — and until someone noticed, every new
    // conversation opened by announcing that a plainly connected calendar could not be used.
    const withdrawsGrant = reachabilityFailureWithdrawsGrant(verification.errorCode);
    db.transaction(() => {
      db.prepare<[string, string, number]>(
        `UPDATE connector
         SET status = 'unreachable', enabled = 0, last_error_code = ?, updated_at = ?
         WHERE id = ?`,
      ).run(verification.errorCode.slice(0, 64), timestamp, id);
      if (!withdrawsGrant) return;
      db.prepare<[string, number]>(
        "UPDATE connector_capability SET enabled = 0, updated_at = ? WHERE connector_id = ?",
      ).run(timestamp, id);
    })();
  }
  return getConnector(db, id);
}

/**
 * Failures that mean the grant is gone, rather than that the network was.
 *
 * Code-owned and deliberately explicit. Each of these is something the user or the operator
 * must act on before Zeus could legitimately call the service again: a revoked or expired
 * authorization, credentials this process does not have, a configuration that no longer
 * describes a service Zeus may reach, or a remote tool that no longer matches what was
 * reviewed. Discarding the reviewed capabilities is right for exactly those, because the
 * next successful handshake must not silently resurrect a permission whose basis changed.
 *
 * Everything else — a handshake that timed out, a server that did not answer, a token
 * endpoint having a bad minute — leaves the grants standing, to be put back into service by
 * the next handshake that works.
 */
const GRANT_WITHDRAWING_FAILURES: ReadonlySet<string> = new Set([
  "reconnect_required",
  "refresh_revoked",
  "api_or_iam_missing",
  "scope_missing",
  "adc_missing",
  "project_missing",
  "missing_environment",
  "invalid_connector",
  "invalid_preset",
  "invalid_permissions",
  "tool_contract_changed",
  "local_only",
]);

export function reachabilityFailureWithdrawsGrant(errorCode: string): boolean {
  return GRANT_WITHDRAWING_FAILURES.has(errorCode);
}

/**
 * A connector whose grants are intact and which simply stopped answering.
 *
 * The one unusable state worth retrying without asking anyone: out of service for a reason
 * that is not the user's to fix, still holding the capability they granted for this slot.
 * Everything else — a connector the user disabled, one whose authorization Google retired,
 * one whose tools drifted — is left exactly where it is.
 */
export function connectorAwaitingReachability(db: Db, slot: CapabilitySlot): ConnectorView | null {
  for (const connector of listConnectors(db)) {
    if (connector.status !== "unreachable" || connector.last_error_code === null) continue;
    if (reachabilityFailureWithdrawsGrant(connector.last_error_code)) continue;
    if (!connector.capabilities.some((entry) => entry.slot === slot && entry.enabled === 1)) {
      continue;
    }
    return connector;
  }
  return null;
}

/**
 * Put a connector back into service after a handshake proved it is answering again.
 *
 * Not a new grant, and it cannot become one. `prior` is the row as it stood *before* the
 * handshake, and it is the whole authority for acting: only a connector that was
 * `unreachable` for a reason outside the user's control is restored. A connector the user
 * switched off is `ready`, so it fails that check and is left exactly as they left it — the
 * distinction this argument exists to make impossible to lose.
 *
 * No capability row is touched, so nothing here can enable a permission the user never
 * bound, and the consent standing behind the connector is the `source_message_id` already on
 * it: their own message, unchanged. `setConnectorEnabled` is deliberately not reused,
 * because it requires a fresh user message — right for a person turning something on, wrong
 * for handing back what a timeout took.
 */
export function restoreConnectorAfterReachability(
  db: Db,
  prior: ConnectorView,
): ConnectorView | null {
  if (
    prior.status === "unreachable" &&
    prior.last_error_code !== null &&
    !reachabilityFailureWithdrawsGrant(prior.last_error_code)
  ) {
    db.prepare<[string, number]>(
      "UPDATE connector SET enabled = 1, updated_at = ? WHERE id = ? AND status = 'ready'",
    ).run(now(), prior.id);
  }
  return getConnector(db, prior.id);
}

export function setConnectorEnabled(
  db: Db,
  id: number,
  enabled: boolean,
  sourceMessageId: number,
): ConnectorView | null {
  assertUserMessage(db, sourceMessageId);
  const connector = getConnector(db, id);
  if (!connector) return null;
  if (enabled && connector.status !== "ready") {
    throw new Error("A connector must verify before it can be enabled");
  }
  const timestamp = now();
  db.transaction(() => {
    db.prepare<[number, number, string, number]>(
      `UPDATE connector SET enabled = ?, source_message_id = ?, updated_at = ? WHERE id = ?`,
    ).run(enabled ? 1 : 0, sourceMessageId, timestamp, id);
    if (!enabled) {
      db.prepare<[string, number]>(
        "UPDATE connector_capability SET enabled = 0, updated_at = ? WHERE connector_id = ?",
      ).run(timestamp, id);
    }
  })();
  return getConnector(db, id);
}

/**
 * Bind one discovered remote tool to one Zeus slot. Rebinding the same slot replaces the
 * grant and starts it disabled again: a different tool is a different decision.
 */
export function bindCapability(db: Db, input: BindCapabilityInput): ConnectorCapability {
  assertUserMessage(db, input.sourceMessageId);
  const connector = getConnector(db, input.connectorId);
  if (!connector) throw new Error("Unknown connector");
  if (connector.provider !== "generic") {
    throw new Error("Provider capabilities come only from its verified OAuth grant");
  }
  const remoteToolName = normalizedText(input.remoteToolName, 200, "remote tool name");
  const effectKind = CAPABILITY_SLOT_EFFECTS[input.slot];
  const schemaJson = canonicalJson(input.inputSchema);
  const schemaHash = toolSchemaHash(input.inputSchema);
  const timestamp = now();

  return db.transaction(() => {
    const existing = capabilityForSlot(db, input.connectorId, input.slot);
    if (
      existing &&
      existing.remote_tool_name === remoteToolName &&
      existing.schema_hash === schemaHash
    ) {
      return existing;
    }
    db.prepare<
      [number, CapabilitySlot, string, EffectKind, string, string, number, string, string]
    >(
      `INSERT INTO connector_capability
         (connector_id, slot, remote_tool_name, effect_kind, input_schema_json,
          schema_hash, source_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connector_id, slot) DO UPDATE SET
         remote_tool_name = excluded.remote_tool_name,
         input_schema_json = excluded.input_schema_json,
         schema_hash = excluded.schema_hash,
         enabled = 0,
         source_message_id = excluded.source_message_id,
         updated_at = excluded.updated_at`,
    ).run(
      input.connectorId,
      input.slot,
      remoteToolName,
      effectKind,
      schemaJson,
      schemaHash,
      input.sourceMessageId,
      timestamp,
      timestamp,
    );
    const capability = capabilityForSlot(db, input.connectorId, input.slot);
    if (!capability) throw new Error("Capability vanished after binding");
    return capability;
  })();
}

/** Bind exactly the tools and scopes the Google OAuth result proved were granted. */
export function configureGoogleCalendarCapabilities(
  db: Db,
  input: {
    connectorId: number;
    tools: readonly DiscoveredToolSummary[];
    scopes: readonly string[];
    sourceMessageId: number;
  },
): ConnectorView {
  assertUserMessage(db, input.sourceMessageId);
  const connector = getConnector(db, input.connectorId);
  if (!connector || connector.provider !== "google_calendar") {
    throw new Error("Unknown Google Calendar connector");
  }
  if (connector.status !== "ready") {
    throw new Error("Google Calendar must verify before its capabilities are enabled");
  }
  const scopeSet = new Set(input.scopes);
  const canRead =
    scopeSet.has(GOOGLE_CALENDAR_READ_SCOPE) || scopeSet.has(GOOGLE_CALENDAR_WRITE_SCOPE);
  const canWrite = scopeSet.has(GOOGLE_CALENDAR_WRITE_SCOPE);
  if (!canRead) throw new Error("Google Calendar read access was not granted");
  const desired: Array<[CapabilitySlot, string]> = [["calendar.list_events", "list_events"]];
  if (canWrite) {
    desired.push(
      ["calendar.create_event", "create_event"],
      ["calendar.update_event", "update_event"],
    );
  }
  const timestamp = now();
  db.transaction(() => {
    // Permission changes replace the active grant, not its audit identity. Disable every
    // prior slot first, then update desired slots in place and insert only genuinely new
    // slots. A successful calendar read may already have a receipt referencing the read
    // capability, so deleting and recreating it would violate that preserved history.
    db.prepare(
      `UPDATE connector_capability
       SET enabled = 0, source_message_id = ?, updated_at = ?
       WHERE connector_id = ?`,
    ).run(input.sourceMessageId, timestamp, connector.id);
    for (const [slot, toolName] of desired) {
      const tool = input.tools.find((entry) => entry.name === toolName);
      if (!tool) throw new Error(`Google Calendar broker did not expose ${toolName}`);
      db.prepare(
        `INSERT INTO connector_capability
           (connector_id, slot, remote_tool_name, effect_kind, input_schema_json,
            schema_hash, enabled, source_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(connector_id, slot) DO UPDATE SET
           remote_tool_name = excluded.remote_tool_name,
           effect_kind = excluded.effect_kind,
           input_schema_json = excluded.input_schema_json,
           schema_hash = excluded.schema_hash,
           enabled = 1,
           source_message_id = excluded.source_message_id,
           updated_at = excluded.updated_at`,
      ).run(
        connector.id,
        slot,
        toolName,
        CAPABILITY_SLOT_EFFECTS[slot],
        JSON.stringify(tool.inputSchema),
        tool.schemaHash,
        input.sourceMessageId,
        timestamp,
        timestamp,
      );
    }
    db.prepare(
      `UPDATE connector SET enabled = 1, source_message_id = ?, updated_at = ?
       WHERE id = ? AND status = 'ready'`,
    ).run(input.sourceMessageId, timestamp, connector.id);
  }).immediate();
  const configured = getConnector(db, connector.id);
  if (!configured) throw new Error("Google Calendar connector vanished after configuration");
  return configured;
}

export function setCapabilityEnabled(
  db: Db,
  id: number,
  enabled: boolean,
  sourceMessageId: number,
): ConnectorCapability | null {
  assertUserMessage(db, sourceMessageId);
  const capability = getCapability(db, id);
  if (!capability) return null;
  if (enabled) {
    const connector = getConnector(db, capability.connector_id);
    if (!connector || connector.enabled !== 1 || connector.status !== "ready") {
      throw new Error("A capability needs a verified, enabled connector");
    }
  }
  db.prepare<[number, number, string, number]>(
    `UPDATE connector_capability
     SET enabled = ?, source_message_id = ?, updated_at = ? WHERE id = ?`,
  ).run(enabled ? 1 : 0, sourceMessageId, now(), id);
  return getCapability(db, id);
}

export function getCapability(db: Db, id: number): ConnectorCapability | null {
  return (
    db
      .prepare<[number], ConnectorCapability>(`${SELECT_CAPABILITY} WHERE id = ?`)
      .get(id) ?? null
  );
}

export function listCapabilities(db: Db, connectorId?: number): ConnectorCapability[] {
  return connectorId === undefined
    ? db.prepare<[], ConnectorCapability>(`${SELECT_CAPABILITY} ORDER BY id`).all()
    : db
      .prepare<[number], ConnectorCapability>(
        `${SELECT_CAPABILITY} WHERE connector_id = ? ORDER BY id`,
      )
      .all(connectorId);
}

/**
 * The one question the work engine asks: may Zeus do this, right now?
 *
 * Both the capability and its connector must be enabled and verified. Anything less
 * resolves to null, and a null is a refusal, never a fallback to some other tool.
 */
export function availableCapability(db: Db, slot: CapabilitySlot): BoundCapability | null {
  const capabilities = db
    .prepare<[CapabilitySlot], ConnectorCapability>(
      `${SELECT_CAPABILITY}
       WHERE slot = ? AND enabled = 1
       ORDER BY id`,
    )
    .all(slot);
  for (const capability of capabilities) {
    const connector = getConnector(db, capability.connector_id);
    if (!connector || connector.enabled !== 1 || connector.status !== "ready") continue;
    if (connector.preset_id !== null && !localConnectorPresetsAllowed()) continue;
    if (connector.transport === "stdio" && !stdioConnectorsAllowed()) continue;
    if (connector.missingEnvVarNames.length > 0) continue;
    return { capability, connector };
  }
  return null;
}

/** Every effect kind Zeus can currently perform through a bound, enabled capability. */
export function availableEffectKinds(db: Db): EffectKind[] {
  const kinds = new Set<EffectKind>();
  for (const slot of CAPABILITY_SLOTS) {
    if (availableCapability(db, slot)) kinds.add(CAPABILITY_SLOT_EFFECTS[slot]);
  }
  return [...kinds].sort();
}

/**
 * The **calendar** capability that would serve a step of this effect kind, if any.
 *
 * This replaces `availableCapabilityForEffect`, which resolved across every slot. That was
 * unambiguous only while `calendar.list_events` was the sole `external_read` slot: the
 * moment email joined it, declaration order in `CAPABILITY_SLOTS` silently became policy,
 * and a generated plan's "read the calendar" step could have resolved to Gmail — building
 * calendar arguments from a Gmail schema, and opening a receipt citing a capability the call
 * never used.
 *
 * Narrowed rather than parameterized because every caller is a calendar path. Email reads
 * run through their own deterministic code and never through a generated plan step, so there
 * is no second caller to generalize for, and an effect-kind resolver left in place is a
 * loaded gun for whoever adds the next slot.
 */
export function calendarCapabilityForEffect(
  db: Db,
  effect: EffectKind,
): BoundCapability | null {
  for (const slot of CALENDAR_CAPABILITY_SLOTS) {
    if (CAPABILITY_SLOT_EFFECTS[slot] !== effect) continue;
    const available = availableCapability(db, slot);
    if (available) return available;
  }
  return null;
}

/** Effect kinds that can only be performed through a connector, if one is bound. */
export function isConnectorEffect(effect: EffectKind): boolean {
  return (Object.values(CAPABILITY_SLOT_EFFECTS) as EffectKind[]).includes(effect);
}

export function capabilityForSlot(
  db: Db,
  connectorId: number,
  slot: CapabilitySlot,
): ConnectorCapability | null {
  return (
    db
      .prepare<[number, CapabilitySlot], ConnectorCapability>(
        `${SELECT_CAPABILITY} WHERE connector_id = ? AND slot = ?`,
      )
      .get(connectorId, slot) ?? null
  );
}

/**
 * Values for the named variables, read fresh from the process environment.
 *
 * Deliberately the only place a secret value is ever handled, and it is never returned to
 * a caller that stores things.
 */
export function connectorEnvironment(
  connector: ConnectorView,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  // Asked again on the way out, not only when the row was written. A store configured while
  // one person ran it can later be opened by a hosted deployment, and it is this call that
  // decides whether the operator's environment is spent — so a row that predates the rule
  // resolves to nothing rather than to the credential it names.
  if (!connectorEnvironmentAllowed(environment)) return {};

  const resolved: Record<string, string> = {};
  for (const name of connector.envVarNames) {
    // The broker's own key is never a connector's to borrow, in either deployment: it
    // authenticates Zeus to the broker, not this connection to anything.
    if (name === GOOGLE_CALENDAR_BROKER_SERVICE_KEY) continue;
    const value = environment[name];
    if (typeof value === "string") resolved[name] = value;
  }
  return resolved;
}

function connectorView(db: Db, row: Connector): ConnectorView {
  const envVarNames = parseStringArray(row.env_var_names_json);
  return {
    ...row,
    args: parseStringArray(row.args_json),
    envVarNames,
    missingEnvVarNames: [
      // Answered from what the connector would actually receive, not from what happens to
      // exist beside Zeus. Where the environment is not the connector's to borrow, every
      // named variable is missing — otherwise this panel would report which of the
      // operator's variables are set, which is most of the value of reading them.
      ...envVarNames.filter(
        (name) => !connectorEnvironmentAllowed() || typeof process.env[name] !== "string",
      ),
      ...(row.provider === "google_calendar" &&
      typeof process.env[GOOGLE_CALENDAR_BROKER_SERVICE_KEY] !== "string"
        ? [GOOGLE_CALENDAR_BROKER_SERVICE_KEY]
        : []),
    ],
    discoveredTools: parseDiscoveredTools(row.discovered_tools_json),
    capabilities: listCapabilities(db, row.id),
  };
}

/** Tolerant by design: a stale or malformed discovery must not break the settings page. */
function parseDiscoveredTools(json: string): DiscoveredToolSummary[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.schemaHash !== "string") return [];
    return [{
      name: record.name,
      description: typeof record.description === "string" ? record.description : null,
      inputSchema: record.inputSchema ?? {},
      schemaHash: record.schemaHash,
      readOnlyHint: typeof record.readOnlyHint === "boolean" ? record.readOnlyHint : null,
    }];
  });
}

export function connectorStatusLabel(status: ConnectorStatus): string {
  switch (status) {
    case "ready":
      return "Verified";
    case "unreachable":
      return "Not reachable";
    case "disabled":
      return "Disabled";
    default:
      return "Not verified yet";
  }
}

function normalizedText(value: string, max: number, subject: string): string {
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) throw new Error(`A ${subject} is required`);
  if (text.length > max) throw new Error(`That ${subject} is too long`);
  return text;
}

/**
 * A stored row is a standing permission to run a program, so the deployment has to be one
 * that may run programs on the user's behalf at the moment it is written. `transportFor`
 * asks the same question again before a spawn, because a store created locally can later
 * be opened by a hosted deployment, and only the second check protects the other tenants.
 */
function assertStdioConnectorsAllowed(): void {
  if (stdioConnectorsAllowed()) return;
  throw new Error(
    "A connection that runs a command is available only when you run Zeus yourself. " +
      "Reach this service over https instead.",
  );
}

function normalizedCommand(value: string | null | undefined): string {
  const command = normalizedText(value ?? "", MAX_COMMAND, "connector command");
  if (SHELL_METACHARACTER.test(command)) {
    throw new Error("A connector command is an executable, not a shell line");
  }
  return command;
}

function normalizedArgs(args: readonly string[]): string[] {
  if (args.length > MAX_ARGS) throw new Error("Too many connector arguments");
  return args.map((arg) => {
    const value = arg.trim();
    if (!value) throw new Error("A connector argument cannot be empty");
    if (value.length > MAX_ARG) throw new Error("That connector argument is too long");
    return value;
  });
}

/**
 * Names only. The pattern refuses anything shaped like a value, which also catches the
 * likeliest mistake: pasting the token itself into the field asking for its name.
 */
function normalizedEnvVarNames(names: readonly string[]): string[] {
  if (names.length > MAX_ENV_VAR_NAMES) {
    throw new Error("Too many environment variable names");
  }
  const normalized = names.map((name) => name.trim()).filter((name) => name.length > 0);
  for (const name of normalized) {
    if (!ENV_VAR_NAME.test(name)) {
      throw new Error(
        `"${name.slice(0, 24)}" is not an environment variable name. ` +
          "Zeus stores names only, never values.",
      );
    }
    if (name === GOOGLE_CALENDAR_BROKER_SERVICE_KEY) {
      throw new Error("That environment variable is reserved for a system-managed provider");
    }
  }
  if (normalized.length > 0) assertConnectorEnvironmentAllowed();
  return [...new Set(normalized)].sort();
}

/**
 * Whose environment is being spent.
 *
 * Naming a variable is as good as holding the value behind it, because Zeus reads it from
 * the live process environment at call time. Locally that environment is the user's own and
 * this is simply how a connector is given its token. Hosted, it is the operator's, and the
 * same field becomes a way to ask Zeus for a credential it was trusted with — most sharply
 * on an HTTP connector, where the value comes back out as the bearer token of a request to
 * a host the user chose.
 *
 * Refused wholesale rather than screened, because a screen only covers the namespaces
 * somebody listed. The operator's environment also carries the variables of everything else
 * they run beside Zeus, and the one added next month is not on any list.
 */
function assertConnectorEnvironmentAllowed(): void {
  if (connectorEnvironmentAllowed()) return;
  throw new Error(
    "A connection cannot borrow this deployment's environment variables. Give the " +
      "service its own credential, or run Zeus yourself to use your own environment.",
  );
}

/**
 * Refuse a destination that would send the user's data over the network in the clear.
 * Loopback is exempt: that is a local server, and the common case.
 */
function normalizedUrl(value: string | null | undefined): string {
  const raw = normalizedText(value ?? "", 2000, "connector URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That connector URL could not be parsed");
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
  throw new Error("A connector URL must use https, or http on this machine");
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function parseStringArray(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Invalid stored connector configuration");
  }
  return value as string[];
}

/** Key-sorted JSON, so an equivalent schema always produces the same hash. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]));
}

function assertUserMessage(db: Db, id: number): void {
  const role = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(id)?.role;
  if (role !== "user") throw new Error("Connector changes must cite a stored user message");
}

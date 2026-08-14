import { createHash } from "node:crypto";

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
 * A connector is an MCP server the user configured. Zeus is the client, which is what
 * keeps "no adapter means no action" literally true and keeps third-party credentials out
 * of the store entirely — this table records a command, arguments, a URL, and the *names*
 * of environment variables, and has nowhere to put a value. Secrets stay in the user's
 * environment, where `scripts/secure-local-files.mjs` already holds the files at 0600.
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
] as const satisfies readonly CapabilitySlot[];

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
  SELECT id, label, transport, command, args_json, cwd, url, env_var_names_json,
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

/**
 * Remove a connector and every capability bound to it.
 *
 * Receipts survive: `tool_receipt.connector_capability_id` is nulled rather than cascaded,
 * because the record that Zeus once made a call is history, not configuration.
 */
export function deleteConnector(db: Db, id: number): boolean {
  return db.prepare<[number]>("DELETE FROM connector WHERE id = ?").run(id).changes > 0;
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
    // Losing reachability also withdraws the grant. A capability that cannot be reached
    // must not keep looking available to the planner.
    db.transaction(() => {
      db.prepare<[string, string, number]>(
        `UPDATE connector
         SET status = 'unreachable', enabled = 0, last_error_code = ?, updated_at = ?
         WHERE id = ?`,
      ).run(verification.errorCode.slice(0, 64), timestamp, id);
      db.prepare<[string, number]>(
        "UPDATE connector_capability SET enabled = 0, updated_at = ? WHERE connector_id = ?",
      ).run(timestamp, id);
    })();
  }
  return getConnector(db, id);
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
  const capability = db
    .prepare<[CapabilitySlot], ConnectorCapability>(
      `${SELECT_CAPABILITY}
       WHERE slot = ? AND enabled = 1
       ORDER BY id LIMIT 1`,
    )
    .get(slot);
  if (!capability) return null;
  const connector = getConnector(db, capability.connector_id);
  if (!connector || connector.enabled !== 1 || connector.status !== "ready") return null;
  if (connector.missingEnvVarNames.length > 0) return null;
  return { capability, connector };
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
 * The capability that would serve a step of this effect kind, if any.
 *
 * The work engine reasons in effect kinds because that is what an authorization names;
 * this is the one place that turns an authorized effect back into a concrete grant.
 */
export function availableCapabilityForEffect(
  db: Db,
  effect: EffectKind,
): BoundCapability | null {
  for (const slot of CAPABILITY_SLOTS) {
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
  const resolved: Record<string, string> = {};
  for (const name of connector.envVarNames) {
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
    missingEnvVarNames: envVarNames.filter(
      (name) => typeof process.env[name] !== "string",
    ),
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
  }
  return [...new Set(normalized)].sort();
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

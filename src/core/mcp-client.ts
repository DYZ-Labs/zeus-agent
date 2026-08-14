import { execFile } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { checkConnectorBudget, recordConnectorCall } from "./budget";
import {
  type ConnectorPreset,
  connectorPresetScopes,
  getConnectorPreset,
  localConnectorPresetsAllowed,
  presetCapability,
} from "./connector-catalog";
import {
  type BoundCapability,
  ConnectorPresetError,
  type ConnectorView,
  assertPresetConnectorConfiguration,
  availableCapability,
  connectorEnvironment,
  getCapability,
  getConnector,
  recordConnectorVerification,
  toolSchemaHash,
} from "./connectors";
import type { Db } from "./db";
import { errorSignature, logEvent } from "./observability";
import type { CapabilitySlot } from "./schema";

/**
 * Zeus as an MCP client — the only place in `src/core/` that opens a connection Zeus did
 * not already own.
 *
 * Everything here is deliberately narrow. A connection is opened for one exchange and
 * closed again, so no long-lived child process outlives the request that needed it. A
 * stdio server receives the SDK's safe default environment plus exactly the variables the
 * user named for that connector, never the whole environment Zeus happens to be running
 * with. Nothing is retried: a call that changes external state must not be repeated
 * automatically just because its reply went missing.
 *
 * Results come back as untrusted data. Callers run them through
 * `inspectUntrustedWorkData` before any of it reaches a model.
 */

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 200_000;
const GCLOUD_TIMEOUT_MS = 10_000;
const MAX_GCLOUD_OUTPUT_BYTES = 8_192;

export type GoogleCloudCommandResult = { stdout: string };
export type GoogleCloudCommandRunner = (
  args: readonly string[],
) => Promise<GoogleCloudCommandResult>;

type PresetClientOptions = {
  signal?: AbortSignal;
  commandRunner?: GoogleCloudCommandRunner;
  environment?: Readonly<Record<string, string | undefined>>;
  tokenFailureCode?: "adc_missing" | "scope_missing";
};

export type DiscoveredTool = {
  name: string;
  description: string | null;
  inputSchema: unknown;
  schemaHash: string;
  /** The remote's own hint. Advisory only — Zeus decides effects from the slot it fills. */
  readOnlyHint: boolean | null;
};

export type CapabilityCallResult = {
  /** Structured output when the server provides it, otherwise the concatenated text. */
  value: unknown;
  text: string;
  isError: boolean;
};

export class ConnectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

/**
 * Probe a code-owned preset before any connector row or provenance message is written.
 * Unknown ids, modified configuration, and missing tools all fail before a credential is
 * materialized or persisted state is touched.
 */
export async function probeConnectorPreset(
  presetId: string,
  slots: readonly CapabilitySlot[],
  options: PresetClientOptions = {},
): Promise<{ tools: DiscoveredTool[] }> {
  const preset = getConnectorPreset(presetId);
  if (!preset) {
    throw new ConnectorError("invalid_preset", "That connection preset is not available.");
  }
  if (!localConnectorPresetsAllowed(options.environment)) {
    throw new ConnectorError(
      "local_only",
      "Guided Google Calendar connections are available only in local mode.",
    );
  }
  const uniqueSlots = [...new Set(slots)];
  if (uniqueSlots.length === 0 || uniqueSlots.some((slot) => !presetCapability(preset, slot))) {
    throw new ConnectorError(
      "invalid_permissions",
      "Select at least one permission offered by this connection.",
    );
  }

  try {
    const transport = await presetTransport(preset, uniqueSlots, options);
    const tools = await withTransport(transport, options.signal, listClientTools);
    const names = new Set(tools.map((tool) => tool.name));
    for (const slot of uniqueSlots) {
      const mapping = presetCapability(preset, slot)!;
      if (!names.has(mapping.remoteToolName)) {
        throw new ConnectorError(
          "tool_contract_changed",
          `Google's ${mapping.remoteToolName} tool is not currently available.`,
        );
      }
    }
    return { tools };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    const status = numericErrorStatus(error);
    throw new ConnectorError(
      status === 401 || status === 403 ? "api_or_iam_missing" : "server_unreachable",
      status === 401 || status === 403
        ? "Google rejected this setup. Check the enabled APIs, project, and IAM roles."
        : "Zeus could not reach Google's Calendar MCP server.",
    );
  }
}

/** Resolve the two non-secret Google headers without retaining either beyond the caller. */
export async function googleCalendarAdcHeaders(
  slots: readonly CapabilitySlot[],
  options: Omit<PresetClientOptions, "signal"> = {},
): Promise<Record<string, string>> {
  if (!localConnectorPresetsAllowed(options.environment)) {
    throw new ConnectorError(
      "local_only",
      "Process-wide Google credentials are disabled outside local mode.",
    );
  }
  const preset = getConnectorPreset("google-calendar-official");
  if (!preset) throw new ConnectorError("invalid_preset", "Google Calendar is unavailable.");
  let scopes: string[];
  try {
    scopes = connectorPresetScopes(preset, slots);
  } catch {
    throw new ConnectorError("invalid_permissions", "Those Calendar permissions are invalid.");
  }

  const runner = options.commandRunner ?? runGoogleCloudCommand;
  const project = (
    await safeGoogleCloudCommand(
      runner,
      ["config", "get-value", "project", "--quiet"],
      "project_missing",
    )
  ).stdout.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)) {
    throw new ConnectorError(
      "project_missing",
      "Set an active Google Cloud project before connecting Calendar.",
    );
  }

  const tokenFailureCode = options.tokenFailureCode ?? "adc_missing";
  const token = (
    await safeGoogleCloudCommand(
      runner,
      [
        "auth",
        "application-default",
        "print-access-token",
        `--scopes=${scopes.join(",")}`,
      ],
      tokenFailureCode,
    )
  ).stdout.trim();
  if (token.length < 20 || token.length > MAX_GCLOUD_OUTPUT_BYTES || /\s/u.test(token)) {
    throw new ConnectorError(
      tokenFailureCode,
      tokenFailureCode === "scope_missing"
        ? "Application Default Credentials do not include the selected Calendar scopes."
        : "Application Default Credentials are missing or invalid.",
    );
  }

  return {
    Authorization: `Bearer ${token}`,
    "x-goog-user-project": project,
  };
}

/**
 * Open the connector, list its tools, and record the outcome.
 *
 * Verification is the only way a connector becomes eligible to be enabled, so an
 * unreachable server fails loudly here rather than at the moment the user is waiting on
 * an action.
 */
export async function verifyConnector(
  db: Db,
  id: number,
  options: { signal?: AbortSignal } = {},
): Promise<{ connector: ConnectorView; tools: DiscoveredTool[] }> {
  const connector = getConnector(db, id);
  if (!connector) throw new ConnectorError("unknown_connector", "Unknown connector");
  if (connector.missingEnvVarNames.length > 0) {
    recordConnectorVerification(db, id, {
      status: "unreachable",
      errorCode: "missing_environment",
    });
    throw new ConnectorError(
      "missing_environment",
      `Set ${connector.missingEnvVarNames.join(", ")} in this Zeus process, then verify again.`,
    );
  }

  try {
    const slots = connector.capabilities.length > 0
      ? connector.capabilities.map((capability) => capability.slot)
      : (["calendar.list_events"] as const);
    const tools = await withClient(
      connector,
      slots,
      options.signal,
      listClientTools,
    );
    const verified = recordConnectorVerification(db, id, { status: "ready", tools });
    logEvent({
      event: "connector_verified",
      outcome: "ok",
      connector_id: id,
      count: tools.length,
    });
    return { connector: verified ?? connector, tools };
  } catch (error) {
    const code = error instanceof ConnectorError ? error.code : "handshake_failed";
    recordConnectorVerification(db, id, { status: "unreachable", errorCode: code });
    logEvent({
      event: "connector_verified",
      outcome: "error",
      reason: code,
      connector_id: id,
      ...errorSignature(error),
    });
    throw error instanceof ConnectorError
      ? error
      : new ConnectorError(code, "That connector did not complete a handshake.");
  }
}

/**
 * Call one bound capability.
 *
 * Resolution happens here, not at the call site: a caller names a slot, and only an
 * enabled capability on an enabled, verified connector can satisfy it. A schema that no
 * longer matches what the user reviewed disables the binding instead of proceeding.
 */
export async function callCapability(
  db: Db,
  slot: CapabilitySlot,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; capabilityId?: number } = {},
): Promise<CapabilityCallResult> {
  const bound = resolveCapability(db, slot, options.capabilityId);
  const preset = presetForCapability(bound, slot);
  const decision = checkConnectorBudget(db);
  if (!decision.allowed) {
    logEvent({
      event: "connector_call",
      outcome: "error",
      reason: decision.reason,
      slot,
      connector_id: bound.connector.id,
    });
    throw new ConnectorError(
      decision.reason,
      "Zeus has reached its limit for calls to connected services. Try again shortly.",
    );
  }

  recordConnectorCall(db);
  const startedAt = Date.now();
  try {
    const result = await withClient(bound.connector, [slot], options.signal, async (client) => {
      if (preset) {
        const tools = await listClientTools(client);
        recordConnectorVerification(db, bound.connector.id, { status: "ready", tools });
        const live = tools.find((tool) => tool.name === bound.capability.remote_tool_name);
        if (!live || live.schemaHash !== bound.capability.schema_hash) {
          disableDriftedCapability(db, bound, live ? "schema_changed" : "tool_missing");
          throw new ConnectorError(
            "tool_contract_changed",
            "Google changed the reviewed Calendar tool contract. Zeus disabled this permission before dispatch.",
          );
        }
      }
      const response = await client.callTool(
        { name: bound.capability.remote_tool_name, arguments: args },
        undefined,
        { signal: options.signal, timeout: CALL_TIMEOUT_MS },
      );
      return response;
    });

    const text = boundedText(result.content);
    const value =
      result.structuredContent !== undefined ? result.structuredContent : parsedOrText(text);
    logEvent({
      event: "connector_call",
      outcome: result.isError === true ? "error" : "ok",
      slot,
      effect: bound.capability.effect_kind,
      connector_id: bound.connector.id,
      duration_ms: Date.now() - startedAt,
    });
    return { value, text, isError: result.isError === true };
  } catch (error) {
    logEvent({
      event: "connector_call",
      outcome: "error",
      reason: error instanceof ConnectorError ? error.code : "call_failed",
      slot,
      effect: bound.capability.effect_kind,
      connector_id: bound.connector.id,
      duration_ms: Date.now() - startedAt,
      ...errorSignature(error),
    });
    throw error instanceof ConnectorError
      ? error
      : new ConnectorError("call_failed", "That connected service did not answer.");
  }
}

/**
 * Confirm the bound tool still accepts what the user reviewed.
 *
 * A remote server can redefine its own tools at any time. Silently obeying the new
 * definition would mean the grant the user gave no longer describes what Zeus can do, so
 * drift disables the binding and asks for a fresh review.
 */
export async function revalidateCapabilitySchemas(
  db: Db,
  connectorId: number,
  options: { signal?: AbortSignal } = {},
): Promise<{ drifted: CapabilitySlot[] }> {
  const { connector, tools } = await verifyConnector(db, connectorId, options);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const drifted: CapabilitySlot[] = [];
  for (const capability of connector.capabilities) {
    const discovered = byName.get(capability.remote_tool_name);
    if (discovered && discovered.schemaHash === capability.schema_hash) continue;
    drifted.push(capability.slot);
    db.prepare<[string, number]>(
      "UPDATE connector_capability SET enabled = 0, updated_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), capability.id);
    logEvent({
      event: "connector_capability_drifted",
      outcome: "degraded",
      reason: discovered ? "schema_changed" : "tool_missing",
      slot: capability.slot,
      connector_id: connectorId,
    });
  }
  return { drifted };
}

function resolveCapability(
  db: Db,
  slot: CapabilitySlot,
  capabilityId: number | undefined,
): BoundCapability {
  const available = availableCapability(db, slot);
  if (!available) {
    throw new ConnectorError(
      "capability_unavailable",
      `No connected service currently provides ${slot}.`,
    );
  }
  if (capabilityId !== undefined && available.capability.id !== capabilityId) {
    // The plan was authorized against one specific grant. If the binding changed since,
    // the authorization no longer describes what would happen.
    const requested = getCapability(db, capabilityId);
    throw new ConnectorError(
      "capability_changed",
      requested
        ? "That capability is no longer the one Zeus was authorized to use."
        : "That capability no longer exists.",
    );
  }
  return available;
}

async function withClient<T>(
  connector: ConnectorView,
  slots: readonly CapabilitySlot[],
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = await transportFor(connector, slots);
  return withTransport(transport, signal, run);
}

async function withTransport<T>(
  transport: Transport,
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(
    { name: "zeus", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS });
    return await run(client);
  } finally {
    // Always tear the connection down, including a spawned child process. A connector
    // that outlives the request that needed it is a background capability nobody granted.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function transportFor(
  connector: ConnectorView,
  slots: readonly CapabilitySlot[],
): Promise<Transport> {
  let preset: ConnectorPreset | null;
  try {
    preset = assertPresetConnectorConfiguration(connector);
  } catch (error) {
    throw error instanceof ConnectorPresetError
      ? new ConnectorError("invalid_connector", error.message)
      : error;
  }
  if (preset) return presetTransport(preset, slots);

  if (connector.transport === "stdio") {
    if (!connector.command) {
      throw new ConnectorError("invalid_connector", "That connector has no command");
    }
    return new StdioClientTransport({
      command: connector.command,
      args: connector.args,
      cwd: connector.cwd ?? undefined,
      // The SDK's safe default set plus exactly the names the user configured. Zeus never
      // hands a connector the whole environment it happens to be running with.
      env: { ...getDefaultEnvironment(), ...connectorEnvironment(connector) },
      // Never "inherit": a connector's diagnostics must not be mistaken for Zeus's own,
      // and in the MCP server process stdout is a protocol channel.
      stderr: "ignore",
    });
  }
  if (!connector.url) {
    throw new ConnectorError("invalid_connector", "That connector has no URL");
  }
  return new StreamableHTTPClientTransport(new URL(connector.url), {
    requestInit: { headers: bearerHeaders(connector) },
  });
}

async function presetTransport(
  preset: ConnectorPreset,
  slots: readonly CapabilitySlot[],
  options: PresetClientOptions = {},
): Promise<Transport> {
  if (preset.authentication !== "google_adc") {
    throw new ConnectorError("invalid_preset", "That preset authentication is unsupported.");
  }
  const headers = await googleCalendarAdcHeaders(slots, options);
  return new StreamableHTTPClientTransport(new URL(preset.url), {
    requestInit: { headers },
  });
}

async function listClientTools(client: Client): Promise<DiscoveredTool[]> {
  const listed = await client.listTools({}, { timeout: CALL_TIMEOUT_MS });
  return listed.tools.map(
    (tool): DiscoveredTool => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : null,
      inputSchema: tool.inputSchema,
      schemaHash: toolSchemaHash(tool.inputSchema),
      readOnlyHint:
        typeof tool.annotations?.readOnlyHint === "boolean"
          ? tool.annotations.readOnlyHint
          : null,
    }),
  );
}

function presetForCapability(
  bound: BoundCapability,
  slot: CapabilitySlot,
): ConnectorPreset | null {
  let preset: ConnectorPreset | null;
  try {
    preset = assertPresetConnectorConfiguration(bound.connector);
  } catch (error) {
    throw error instanceof ConnectorPresetError
      ? new ConnectorError("invalid_connector", error.message)
      : error;
  }
  if (!preset) return null;
  const mapping = presetCapability(preset, slot);
  if (!mapping || mapping.remoteToolName !== bound.capability.remote_tool_name) {
    throw new ConnectorError(
      "invalid_connector",
      "That preset capability no longer matches Zeus's trusted catalog.",
    );
  }
  return preset;
}

function disableDriftedCapability(
  db: Db,
  bound: BoundCapability,
  reason: "schema_changed" | "tool_missing",
): void {
  db.prepare<[string, number]>(
    "UPDATE connector_capability SET enabled = 0, updated_at = ? WHERE id = ?",
  ).run(new Date().toISOString(), bound.capability.id);
  logEvent({
    event: "connector_capability_drifted",
    outcome: "degraded",
    reason,
    slot: bound.capability.slot,
    connector_id: bound.connector.id,
  });
}

async function safeGoogleCloudCommand(
  runner: GoogleCloudCommandRunner,
  args: readonly string[],
  failureCode: "project_missing" | "adc_missing" | "scope_missing",
): Promise<GoogleCloudCommandResult> {
  try {
    const result = await runner(args);
    if (result.stdout.length > MAX_GCLOUD_OUTPUT_BYTES) throw new Error("output_too_large");
    return result;
  } catch (error) {
    const code = stringErrorCode(error);
    if (code === "ENOENT") {
      throw new ConnectorError("gcloud_missing", "Install the Google Cloud CLI, then try again.");
    }
    if (code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new ConnectorError("gcloud_unavailable", "The Google Cloud CLI did not answer safely.");
    }
    throw new ConnectorError(
      failureCode,
      failureCode === "project_missing"
        ? "Set an active Google Cloud project before connecting Calendar."
        : failureCode === "scope_missing"
          ? "Application Default Credentials do not include the selected Calendar scopes."
          : "Application Default Credentials are missing or invalid.",
    );
  }
}

function runGoogleCloudCommand(args: readonly string[]): Promise<GoogleCloudCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "gcloud",
      [...args],
      {
        encoding: "utf8",
        env: getDefaultEnvironment() as NodeJS.ProcessEnv,
        shell: false,
        timeout: GCLOUD_TIMEOUT_MS,
        maxBuffer: MAX_GCLOUD_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

function stringErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function numericErrorStatus(error: unknown, depth = 0): number | null {
  if (!error || typeof error !== "object" || depth > 3) return null;
  const record = error as { status?: unknown; code?: unknown; cause?: unknown };
  if (typeof record.status === "number") return record.status;
  if (typeof record.code === "number") return record.code;
  return numericErrorStatus(record.cause, depth + 1);
}

/**
 * A configured `*_TOKEN` / `*_KEY` variable becomes the Authorization header for an HTTP
 * connector. Read at call time from the process environment; never stored, never logged.
 */
function bearerHeaders(connector: ConnectorView): Record<string, string> {
  const environment = connectorEnvironment(connector);
  const name = connector.envVarNames.find(
    (variable) => variable.endsWith("_TOKEN") || variable.endsWith("_KEY"),
  );
  const value = name === undefined ? undefined : environment[name];
  return value ? { Authorization: `Bearer ${value}` } : {};
}

type ToolContent = Array<{ type: string; text?: unknown }>;

function boundedText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts = (content as ToolContent)
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text as string);
  const text = parts.join("\n");
  return text.length > MAX_RESULT_BYTES ? text.slice(0, MAX_RESULT_BYTES) : text;
}

function parsedOrText(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

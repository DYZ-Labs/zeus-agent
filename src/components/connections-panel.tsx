import {
  addConnectorAction,
  bindCapabilityAction,
  disconnectGoogleCalendarAction,
  removeConnectorAction,
  setCalendarDirectExecutionAction,
  setCapabilityEnabledAction,
  setConnectorEnabledAction,
  verifyConnectorAction,
} from "@/app/actions";
import { GOOGLE_CALENDAR_PRESET_ID } from "@/core/connector-catalog";
import {
  CAPABILITY_SLOTS,
  type ConnectorView,
  type DiscoveredToolSummary,
  connectorStatusLabel,
} from "@/core/connectors";
import type { CapabilitySlot, ConnectorCapability } from "@/core/schema";
import { GoogleCalendarConnection } from "@/components/google-calendar-connection";

/**
 * What the user is actually deciding here is not "add an integration" but "what may Zeus
 * do on my behalf". So the panel is organised around capability slots rather than around
 * servers, states plainly that no credential is stored, and shows the exact remote tool
 * behind every grant.
 */

const SLOT_LABELS: Record<CapabilitySlot, { title: string; effect: string }> = {
  "calendar.list_events": {
    title: "Read your calendar",
    effect: "Zeus can look, without asking each time.",
  },
  "calendar.create_event": {
    title: "Create calendar events",
    effect: "Zeus prepares each event and waits for you to confirm it.",
  },
  "calendar.update_event": {
    title: "Change calendar events",
    effect: "Zeus prepares each change and waits for you to confirm it.",
  },
};

export function ConnectionsPanel({
  connectors,
  errorMessage,
  localMode,
  successMessage,
  googleCalendarAvailable,
  hostedAccount,
  directExecution,
}: {
  connectors: ConnectorView[];
  errorMessage: string | null;
  localMode: boolean;
  successMessage: string | null;
  googleCalendarAvailable: boolean;
  hostedAccount: boolean;
  /** Whether Zeus carries out calendar changes without asking each time. */
  directExecution: boolean;
}) {
  const brokerCalendar = connectors.find(
    (connector) => connector.provider === "google_calendar",
  ) ?? null;
  const localCalendar =
    connectors.find((connector) => connector.preset_id === GOOGLE_CALENDAR_PRESET_ID) ?? null;
  const customConnectors = connectors.filter(
    (connector) => connector.provider === "generic" && connector.preset_id === null,
  );
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Connections</h1>
      <p className="mt-2 max-w-[60ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
        Choose a service, review what Zeus may do, and verify it in one guided setup. Zeus
        stores connection configuration and reviewed capability grants, never credential
        values. Nothing outside Zeus changes without your confirmation of the exact request.
      </p>

      {errorMessage ? (
        <p
          className="mt-4 rounded-lg border px-3 py-2 text-[0.82rem] leading-5"
          style={{ borderColor: "#7f1d1d", color: "var(--shell-fg)" }}
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}

      {successMessage ? (
        <p
          className="mt-4 rounded-lg border px-3 py-2 text-[0.82rem] leading-5"
          style={{ borderColor: "#166534", color: "var(--shell-fg)" }}
          role="status"
        >
          {successMessage}
        </p>
      ) : null}

      {localMode ? (
        <GoogleCalendarConnection
          key={`${localCalendar?.id ?? "new"}-${localCalendar?.updated_at ?? "available"}`}
          connector={localCalendar}
          localMode
        />
      ) : (
        <GoogleCalendarCard
          connector={brokerCalendar}
          available={googleCalendarAvailable}
          hostedAccount={hostedAccount}
          directExecution={directExecution}
        />
      )}

      {customConnectors.length === 0 ? (
        <p className="mt-5 text-[0.84rem] leading-6" style={{ color: "var(--shell-faint)" }}>
          No advanced MCP connections are configured.
        </p>
      ) : (
        <ul className="mt-5 space-y-4">
          {customConnectors.map((connector) => (
            <ConnectorCard key={connector.id} connector={connector} />
          ))}
        </ul>
      )}

      {/*
        A custom connection is a command Zeus runs, which only makes sense where the machine
        is the user's own. Hiding the form on the hosted site is a courtesy so nobody fills
        in a form that cannot succeed; the refusal itself lives in core, which turns the
        same request down however it arrives.
      */}
      {localMode ? (
        <details className="mt-6 border-t pt-4" style={{ borderColor: "var(--shell-line)" }}>
          <summary className="cursor-pointer text-[0.82rem] font-medium">
            Advanced: custom MCP server
          </summary>
          <p className="mt-2 max-w-[60ch] text-[0.75rem] leading-5" style={{ color: "var(--shell-faint)" }}>
            Add a server manually when it is not in the guided catalog. You will verify its
            live tools and grant each Zeus capability separately.
          </p>
          <AddConnectorForm />
        </details>
      ) : (
        <p
          className="mt-6 max-w-[60ch] border-t pt-4 text-[0.75rem] leading-5"
          style={{ borderColor: "var(--shell-line)", color: "var(--shell-faint)" }}
        >
          Custom MCP servers run a command on the machine Zeus is installed on, so they are
          available only when you run Zeus yourself.
        </p>
      )}
    </section>
  );
}

function GoogleCalendarCard({
  connector,
  available,
  hostedAccount,
  directExecution,
}: {
  connector: ConnectorView | null;
  available: boolean;
  hostedAccount: boolean;
  directExecution: boolean;
}) {
  const readCapability = connector?.capabilities.find(
    (entry) => entry.slot === "calendar.list_events",
  ) ?? null;
  const writeCapabilities = connector?.capabilities.filter(
    (entry) =>
      entry.slot === "calendar.create_event" || entry.slot === "calendar.update_event",
  ) ?? [];
  const writeGranted =
    writeCapabilities.length === 2 && writeCapabilities.every((capability) => capability.enabled === 1);

  return (
    <article
      className="mt-5 rounded-xl border px-4 py-4"
      style={{ borderColor: "var(--shell-line-strong)", background: "var(--shell-elevated)" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[0.95rem] font-medium">Google Calendar</h2>
        <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
          {connector?.enabled === 1 ? "connected" : connector ? connectorStatusLabel(connector.status) : "not connected"}
        </span>
      </div>
      <p className="mt-1 text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        Connect your own Google account. Google credentials stay in the separate encrypted
        broker and never enter Zeus memory.
      </p>

      {!hostedAccount ? (
        <p className="mt-3 text-[0.78rem]" style={{ color: "var(--shell-faint)" }}>
          Sign in to the hosted Zeus site to connect a personal calendar.
        </p>
      ) : !available ? (
        <p className="mt-3 text-[0.78rem]" style={{ color: "var(--shell-faint)" }}>
          The Google Calendar broker is not configured on this deployment yet.
        </p>
      ) : !connector ? (
        <a
          href="/api/integrations/google-calendar/start?permission=read"
          className="mt-3 inline-flex rounded-lg px-3 py-2 text-[0.8rem] font-medium"
          style={{ background: "var(--shell-accent)", color: "#000000" }}
        >
          Connect Google Calendar
        </a>
      ) : (
        <div className="mt-4 space-y-3">
          {connector.status !== "ready" ? (
            <div>
              <p className="text-[0.78rem]" style={{ color: "var(--shell-faint)" }}>
                Google Calendar needs to be reconnected before Zeus can use it.
              </p>
              <a
                href="/api/integrations/google-calendar/start?permission=read"
                className="mt-2 inline-flex text-[0.78rem] font-medium"
                style={{ color: "var(--shell-accent)" }}
              >
                Reconnect Google Calendar
              </a>
            </div>
          ) : null}
          <ProviderCapability
            capability={readCapability}
            label="Read calendar events"
            description="Used for calendar-aware plans and deterministic conflict checks."
          />
          {writeGranted ? (
            writeCapabilities.map((capability) => (
              <ProviderCapability
                key={capability.id}
                capability={capability}
                label={capability.slot === "calendar.create_event" ? "Create events" : "Change events"}
                description="Zeus checks the time against your calendar before it acts."
              />
            ))
          ) : (
            <div className="border-t pt-3" style={{ borderColor: "var(--shell-line)" }}>
              <p className="text-[0.82rem] font-medium">Create and change events</p>
              <p className="mt-1 text-[0.75rem]" style={{ color: "var(--shell-faint)" }}>
                Requires a separate Google permission. Every request will still require exact confirmation.
              </p>
              <a
                href="/api/integrations/google-calendar/start?permission=write"
                className="mt-2 inline-flex text-[0.78rem] font-medium"
                style={{ color: "var(--shell-accent)" }}
              >
                Allow calendar changes
              </a>
            </div>
          )}
          <DirectExecutionToggle enabled={directExecution} />
          <form action={disconnectGoogleCalendarAction} className="border-t pt-3" style={{ borderColor: "var(--shell-line)" }}>
            <button type="submit" className="text-[0.78rem]" style={{ color: "var(--shell-faint)" }}>
              Disconnect and revoke Google access
            </button>
          </form>
        </div>
      )}
    </article>
  );
}

/**
 * The switch that decides whether Zeus asks before each calendar change.
 *
 * It removes the interruption and nothing else: a collision, a calendar Zeus could not
 * read, or an ambiguous event still stops and asks, whatever this says, and every change
 * still writes a receipt you can undo.
 */
function DirectExecutionToggle({ enabled }: { enabled: boolean }) {
  return (
    <form
      action={setCalendarDirectExecutionAction}
      className="border-t pt-3"
      style={{ borderColor: "var(--shell-line)" }}
    >
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          name="directExecution"
          defaultChecked={enabled}
          className="mt-0.5"
        />
        <span>
          <span className="block text-[0.82rem] font-medium">
            Make changes without asking me each time
          </span>
          <span className="mt-1 block text-[0.75rem]" style={{ color: "var(--shell-faint)" }}>
            Zeus reads your calendar first and only acts when the time is free. A clash, a
            calendar it cannot read, or an unclear event always stops and asks.
          </span>
        </span>
      </label>
      <button
        type="submit"
        className="mt-2 text-[0.78rem] font-medium"
        style={{ color: "var(--shell-accent)" }}
      >
        Save
      </button>
    </form>
  );
}

function ProviderCapability({
  capability,
  label,
  description,
}: {
  capability: ConnectorCapability | null;
  label: string;
  description: string;
}) {
  if (!capability) return null;
  return (
    <div className="border-t pt-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[0.82rem] font-medium">{label}</span>
        <span className="font-mono text-[0.6rem] uppercase" style={{ color: "var(--shell-faint)" }}>
          {capability.enabled === 1 ? "allowed" : "paused"}
        </span>
      </div>
      <p className="mt-1 text-[0.75rem]" style={{ color: "var(--shell-faint)" }}>{description}</p>
      <form action={setCapabilityEnabledAction} className="mt-2">
        <input type="hidden" name="id" value={capability.id} />
        <input type="hidden" name="enabled" value={capability.enabled === 1 ? "false" : "true"} />
        <SmallButton label={capability.enabled === 1 ? "Pause" : "Allow"} />
      </form>
    </div>
  );
}

function ConnectorCard({ connector }: { connector: ConnectorView }) {
  const bound = new Map(connector.capabilities.map((entry) => [entry.slot, entry]));
  return (
    <li
      className="rounded-xl border px-4 py-4"
      style={{ borderColor: "var(--shell-line)" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[0.95rem] font-medium leading-5">{connector.label}</h2>
        <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
          {connectorStatusLabel(connector.status)}
          {connector.enabled === 1 ? " · enabled" : ""}
        </span>
      </div>

      <p className="mt-1 font-mono text-[0.68rem] leading-5" style={{ color: "var(--shell-faint)" }}>
        {connector.transport === "stdio"
          ? [connector.command, ...connector.args].join(" ")
          : connector.url}
      </p>

      {connector.envVarNames.length > 0 ? (
        <p className="mt-1 text-[0.75rem] leading-5" style={{ color: "var(--shell-faint)" }}>
          Reads {connector.envVarNames.join(", ")} from your environment.
          {connector.missingEnvVarNames.length > 0 ? (
            <strong style={{ color: "var(--shell-fg)" }}>
              {" "}
              {connector.missingEnvVarNames.join(", ")} is not set, so this connection cannot work.
            </strong>
          ) : null}
        </p>
      ) : null}

      {connector.last_error_code ? (
        <p className="mt-1 font-mono text-[0.68rem]" style={{ color: "var(--shell-faint)" }}>
          Last failure: {connector.last_error_code}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[0.78rem]">
        <form action={verifyConnectorAction}>
          <input type="hidden" name="id" value={connector.id} />
          <SmallButton label="Verify" />
        </form>
        {connector.status === "ready" ? (
          <form action={setConnectorEnabledAction}>
            <input type="hidden" name="id" value={connector.id} />
            <input type="hidden" name="enabled" value={connector.enabled === 1 ? "false" : "true"} />
            <SmallButton label={connector.enabled === 1 ? "Disable" : "Enable"} />
          </form>
        ) : null}
        <form action={removeConnectorAction}>
          <input type="hidden" name="id" value={connector.id} />
          <SmallButton label="Remove" />
        </form>
      </div>

      <div className="mt-4 space-y-3">
        {CAPABILITY_SLOTS.map((slot) => (
          <CapabilityRow
            key={slot}
            slot={slot}
            connectorId={connector.id}
            connectorEnabled={connector.enabled === 1}
            capability={bound.get(slot) ?? null}
            tools={connector.discoveredTools}
          />
        ))}
      </div>
    </li>
  );
}

function CapabilityRow({
  slot,
  connectorId,
  connectorEnabled,
  capability,
  tools,
}: {
  slot: CapabilitySlot;
  connectorId: number;
  connectorEnabled: boolean;
  capability: ConnectorCapability | null;
  tools: readonly DiscoveredToolSummary[];
}) {
  const meta = SLOT_LABELS[slot];
  return (
    <div className="border-t pt-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[0.84rem] font-medium leading-5">{meta.title}</span>
        <span className="font-mono text-[0.62rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
          {capability === null ? "not granted" : capability.enabled === 1 ? "allowed" : "paused"}
        </span>
      </div>
      <p className="mt-1 text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        {meta.effect}
      </p>

      {capability ? (
        <>
          <p className="mt-1 font-mono text-[0.66rem] leading-5" style={{ color: "var(--shell-faint)" }}>
            {capability.remote_tool_name} · schema {capability.schema_hash.slice(0, 12)}
          </p>
          {connectorEnabled ? (
            <form action={setCapabilityEnabledAction} className="mt-2">
              <input type="hidden" name="id" value={capability.id} />
              <input type="hidden" name="enabled" value={capability.enabled === 1 ? "false" : "true"} />
              <SmallButton label={capability.enabled === 1 ? "Stop allowing" : "Allow"} />
            </form>
          ) : (
            <p className="mt-2 text-[0.75rem]" style={{ color: "var(--shell-faint)" }}>
              Enable the connection before allowing this.
            </p>
          )}
        </>
      ) : tools.length === 0 ? (
        <p className="mt-2 text-[0.75rem]" style={{ color: "var(--shell-faint)" }}>
          Verify the connection to see the tools it offers.
        </p>
      ) : (
        <form action={bindCapabilityAction} className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="connectorId" value={connectorId} />
          <input type="hidden" name="slot" value={slot} />
          <label className="sr-only" htmlFor={`tool-${connectorId}-${slot}`}>
            Tool for {SLOT_LABELS[slot].title}
          </label>
          <select
            id={`tool-${connectorId}-${slot}`}
            name="remoteToolName"
            required
            defaultValue=""
            className="min-h-[32px] rounded-md border px-2 text-[0.8rem]"
            style={{ borderColor: "var(--shell-line-strong)", background: "var(--shell-elevated)" }}
          >
            <option value="" disabled>
              Choose a tool
            </option>
            {tools.map((tool) => (
              <option key={tool.name} value={tool.name}>
                {tool.name}
                {tool.readOnlyHint === true ? " (read-only)" : ""}
              </option>
            ))}
          </select>
          <SmallButton label="Grant" />
        </form>
      )}
    </div>
  );
}

function AddConnectorForm() {
  return (
    <form action={addConnectorAction} className="mt-4">
      <h2 className="text-sm font-medium leading-5">Custom connection details</h2>
      <input type="hidden" name="transport" value="stdio" />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field name="label" label="Name" placeholder="Calendar" required />
        <Field name="command" label="Command" placeholder="npx" required />
        <Field name="args" label="Arguments" placeholder="-y @example/calendar-mcp" />
        <Field name="cwd" label="Working directory" placeholder="optional" />
        <Field
          name="envVarNames"
          label="Environment variable names"
          placeholder="CALENDAR_TOKEN"
        />
      </div>
      <p className="mt-2 max-w-[60ch] text-[0.75rem] leading-5" style={{ color: "var(--shell-faint)" }}>
        Names only. Put the values in the environment Zeus runs in; it will never store them.
      </p>
      <div className="mt-3">
        <SmallButton label="Add connection" />
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  placeholder,
  required,
}: {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-[0.75rem]" style={{ color: "var(--shell-faint)" }}>
      {label}
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        className="mt-1 block min-h-[34px] w-full rounded-md border px-2.5 text-[0.82rem]"
        style={{ borderColor: "var(--shell-line-strong)", background: "var(--shell-elevated)" }}
      />
    </label>
  );
}

function SmallButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="rounded-md border px-2.5 py-1 text-[0.78rem] font-medium transition-colors hover:bg-white/[0.06]"
      style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
    >
      {label}
    </button>
  );
}

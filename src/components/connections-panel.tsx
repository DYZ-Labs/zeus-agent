import {
  addConnectorAction,
  bindCapabilityAction,
  removeConnectorAction,
  setCapabilityEnabledAction,
  setConnectorEnabledAction,
  verifyConnectorAction,
} from "@/app/actions";
import {
  CAPABILITY_SLOTS,
  type ConnectorView,
  type DiscoveredToolSummary,
  connectorStatusLabel,
} from "@/core/connectors";
import type { CapabilitySlot, ConnectorCapability } from "@/core/schema";

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
}: {
  connectors: ConnectorView[];
  errorMessage: string | null;
}) {
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Connections</h1>
      <p className="mt-2 max-w-[60ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
        Zeus reaches other services through servers you run. It stores the command and the{" "}
        <em>names</em> of the environment variables a server needs — never their values, which
        stay in your environment. Nothing outside Zeus changes without your explicit
        confirmation of the exact request.
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

      {connectors.length === 0 ? (
        <p className="mt-5 text-[0.84rem] leading-6" style={{ color: "var(--shell-faint)" }}>
          Nothing is connected. Zeus can research and draft, but it cannot see or change
          anything outside its own memory.
        </p>
      ) : (
        <ul className="mt-5 space-y-4">
          {connectors.map((connector) => (
            <ConnectorCard key={connector.id} connector={connector} />
          ))}
        </ul>
      )}

      <AddConnectorForm />
    </section>
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
    <form action={addConnectorAction} className="mt-6 border-t pt-5" style={{ borderColor: "var(--shell-line)" }}>
      <h2 className="text-sm font-medium leading-5">Add a connection</h2>
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

"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import {
  configureConnectorPresetAction,
  removeConnectorAction,
  setConnectorEnabledAction,
  type ConnectorSetupCode,
  type ConnectorSetupState,
} from "@/app/actions";
import {
  GOOGLE_CALENDAR_PRESET,
  GOOGLE_CALENDAR_PRESET_ID,
  googleCalendarAdcLoginCommand,
} from "@/core/connector-catalog";
import type { ConnectorView } from "@/core/connectors";
import type { CapabilitySlot } from "@/core/schema";

const INITIAL_STATE: ConnectorSetupState = {
  status: "idle",
  code: "idle",
  message: "",
};

const PERMISSIONS: ReadonlyArray<{
  slot: CapabilitySlot;
  title: string;
  description: string;
}> = [
  {
    slot: "calendar.list_events",
    title: "Read events",
    description: "Zeus may read bounded calendar windows without asking each time.",
  },
  {
    slot: "calendar.create_event",
    title: "Create events",
    description: "Zeus may prepare an event, then waits for your exact confirmation.",
  },
  {
    slot: "calendar.update_event",
    title: "Update events",
    description: "Zeus may prepare a change, then waits for your exact confirmation.",
  },
];

export function GoogleCalendarConnection({
  connector,
  localMode,
}: {
  connector: ConnectorView | null;
  localMode: boolean;
}) {
  const router = useRouter();
  const initialSlots = useMemo(() => {
    const enabled = connector?.capabilities
      .filter((capability) => capability.enabled === 1)
      .map((capability) => capability.slot) ?? [];
    return enabled.length > 0 ? enabled : (["calendar.list_events"] as CapabilitySlot[]);
  }, [connector]);
  const [selectedSlots, setSelectedSlots] = useState<CapabilitySlot[]>(initialSlots);
  const [state, formAction, pending] = useActionState(
    configureConnectorPresetAction,
    INITIAL_STATE,
  );

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  const connected = connector !== null;
  const adcCommand = googleCalendarAdcLoginCommand(selectedSlots);

  return (
    <article
      className="mt-5 rounded-xl border px-4 py-4"
      style={{ borderColor: "var(--shell-line)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[0.98rem] font-medium leading-5">
              {GOOGLE_CALENDAR_PRESET.label}
            </h2>
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[0.58rem] uppercase tracking-[0.12em]"
              style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-faint)" }}
            >
              {GOOGLE_CALENDAR_PRESET.badge}
            </span>
          </div>
          <p
            className="mt-1 max-w-[62ch] text-[0.8rem] leading-5"
            style={{ color: "var(--shell-muted)" }}
          >
            {GOOGLE_CALENDAR_PRESET.description}
          </p>
        </div>
        <span
          className="font-mono text-[0.62rem] uppercase tracking-[0.14em]"
          style={{ color: "var(--shell-faint)" }}
        >
          {connected
            ? connector.enabled === 1
              ? "Connected"
              : "Paused"
            : localMode
              ? "Available"
              : "Local only"}
        </span>
      </div>

      {!localMode ? (
        <>
          <p
            className="mt-4 rounded-lg border px-3 py-2 text-[0.8rem] leading-5"
            style={{ borderColor: "var(--shell-line)", color: "var(--shell-muted)" }}
          >
            Guided setup uses this machine&apos;s Application Default Credentials, so it is
            disabled for hosted multi-account stores. Process-wide credentials are never
            shared between accounts.
          </p>
          {connector ? <RemoveConnection connectorId={connector.id} /> : null}
        </>
      ) : (
        <>
          <form action={formAction} className="mt-4">
            <input type="hidden" name="presetId" value={GOOGLE_CALENDAR_PRESET_ID} />
            {connector ? (
              <input type="hidden" name="connectorId" value={connector.id} />
            ) : null}

            <fieldset>
              <legend className="text-[0.82rem] font-medium">
                {connected ? "Permissions" : "Choose what Zeus may do"}
              </legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {PERMISSIONS.map((permission) => {
                  const checked = selectedSlots.includes(permission.slot);
                  return (
                    <label
                      key={permission.slot}
                      className="rounded-lg border px-3 py-2.5 text-[0.78rem] leading-5"
                      style={{
                        borderColor: checked
                          ? "var(--shell-line-strong)"
                          : "var(--shell-line)",
                        background: checked ? "var(--shell-elevated)" : "transparent",
                      }}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <input
                          type="checkbox"
                          name="slots"
                          value={permission.slot}
                          checked={checked}
                          onChange={() => {
                            setSelectedSlots((current) =>
                              current.includes(permission.slot)
                                ? current.filter((slot) => slot !== permission.slot)
                                : [...current, permission.slot],
                            );
                          }}
                        />
                        {permission.title}
                      </span>
                      <span className="mt-1 block" style={{ color: "var(--shell-faint)" }}>
                        {permission.description}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <p
              className="mt-3 max-w-[68ch] text-[0.75rem] leading-5"
              style={{ color: "var(--shell-faint)" }}
            >
              Google may authorize a broader calendar scope for writes, but Zeus binds only
              the tools selected here. Creating or changing anything still pauses for your
              confirmation of the exact payload.
            </p>

            <SetupChecklist adcCommand={adcCommand} activeCode={state.code} />

            {state.status !== "idle" ? (
              <p
                className="mt-3 rounded-lg border px-3 py-2 text-[0.8rem] leading-5"
                style={{
                  borderColor:
                    state.status === "error" ? "#7f1d1d" : "var(--shell-line-strong)",
                }}
                role={state.status === "error" ? "alert" : "status"}
              >
                {state.message}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={pending}
                className="rounded-md border px-3 py-1.5 text-[0.8rem] font-medium transition-colors hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-60"
                style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
              >
                {pending
                  ? "Checking…"
                  : connected
                    ? "Save permissions"
                    : "Check and connect"}
              </button>
              <a
                href={GOOGLE_CALENDAR_PRESET.documentationUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[0.75rem] underline underline-offset-4"
                style={{ color: "var(--shell-faint)" }}
              >
                Official tool reference
              </a>
            </div>
          </form>

          {connector ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {connector.enabled === 1 ? (
                <form action={setConnectorEnabledAction}>
                  <input type="hidden" name="id" value={connector.id} />
                  <input type="hidden" name="enabled" value="false" />
                  <SecondaryButton label="Pause connection" />
                </form>
              ) : null}
              <RemoveConnection connectorId={connector.id} />
            </div>
          ) : null}

          {connector ? <TechnicalDetails connector={connector} /> : null}
        </>
      )}
    </article>
  );
}

function SetupChecklist({
  adcCommand,
  activeCode,
}: {
  adcCommand: string;
  activeCode: ConnectorSetupCode;
}) {
  return (
    <details
      className="mt-4 rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--shell-line)" }}
      open={activeCode !== "idle" && activeCode !== "connected" && activeCode !== "updated"}
    >
      <summary className="cursor-pointer text-[0.8rem] font-medium">
        Google Cloud prerequisite checklist
      </summary>
      <ol className="mt-3 space-y-3 text-[0.76rem] leading-5">
        <ChecklistItem active={activeCode === "gcloud_missing" || activeCode === "gcloud_unavailable"}>
          Install the{" "}
          <a
            href="https://cloud.google.com/sdk/docs/install"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            Google Cloud CLI
          </a>
          , then follow Google&apos;s{" "}
          <a
            href={GOOGLE_CALENDAR_PRESET.setupUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            official MCP setup guide
          </a>
          . Zeus never runs setup or IAM commands for you.
        </ChecklistItem>
        <ChecklistItem active={activeCode === "project_missing"}>
          Select the project used for quotas.
          <Command value="gcloud config set project YOUR_PROJECT_ID" />
        </ChecklistItem>
        <ChecklistItem active={activeCode === "api_or_iam_missing"}>
          Enable the Calendar API and Calendar MCP API.
          <Command value="gcloud services enable calendar-json.googleapis.com calendarmcp.googleapis.com" />
        </ChecklistItem>
        <ChecklistItem active={activeCode === "api_or_iam_missing"}>
          Grant your Google account MCP Tool User and Service Usage Consumer in that project.
          <Command value={'gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="user:YOUR_GOOGLE_EMAIL" --role="roles/mcp.toolUser"'} />
          <Command value={'gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member="user:YOUR_GOOGLE_EMAIL" --role="roles/serviceusage.serviceUsageConsumer"'} />
        </ChecklistItem>
        <ChecklistItem active={activeCode === "adc_missing" || activeCode === "scope_missing"}>
          Create a Desktop OAuth client, download its client JSON outside Zeus, then run ADC
          login with exactly the scopes selected above.
          <Command value={adcCommand} />
        </ChecklistItem>
      </ol>
      <p className="mt-3 text-[0.72rem] leading-5" style={{ color: "var(--shell-faint)" }}>
        Credentials remain in gcloud&apos;s Application Default Credentials store. Zeus asks
        gcloud for a short-lived token only while opening one MCP connection; it never saves
        the token, client JSON, or active project.
      </p>
    </details>
  );
}

function ChecklistItem({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <li
      className="rounded-md border-l-2 pl-3"
      style={{
        borderColor: active ? "var(--shell-accent)" : "var(--shell-line)",
        color: active ? "var(--shell-fg)" : "var(--shell-muted)",
      }}
    >
      {children}
    </li>
  );
}

function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="mt-1.5 flex items-start justify-between gap-2 rounded-md border px-2 py-1.5"
      style={{ borderColor: "var(--shell-line)", background: "var(--shell-elevated)" }}
    >
      <code className="min-w-0 break-all font-mono text-[0.66rem] leading-5">{value}</code>
      <button
        type="button"
        className="shrink-0 rounded border px-1.5 py-0.5 text-[0.64rem]"
        style={{ borderColor: "var(--shell-line-strong)" }}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1_500);
            },
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function TechnicalDetails({ connector }: { connector: ConnectorView }) {
  return (
    <details className="mt-4 border-t pt-3" style={{ borderColor: "var(--shell-line)" }}>
      <summary
        className="cursor-pointer font-mono text-[0.66rem] uppercase tracking-[0.12em]"
        style={{ color: "var(--shell-faint)" }}
      >
        Technical details
      </summary>
      <div className="mt-2 space-y-1 font-mono text-[0.66rem] leading-5" style={{ color: "var(--shell-faint)" }}>
        <p>endpoint: {connector.url}</p>
        <p>authentication: Google ADC, resolved in memory at call time</p>
        <p>last verified: {connector.last_verified_at ?? "never"}</p>
        {connector.capabilities.map((capability) => (
          <p key={capability.id}>
            {capability.slot} → {capability.remote_tool_name} · schema{" "}
            {capability.schema_hash.slice(0, 12)} · {capability.enabled === 1 ? "allowed" : "paused"}
          </p>
        ))}
      </div>
    </details>
  );
}

function RemoveConnection({ connectorId }: { connectorId: number }) {
  return (
    <form action={removeConnectorAction}>
      <input type="hidden" name="id" value={connectorId} />
      <SecondaryButton label="Remove connection" />
    </form>
  );
}

function SecondaryButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="rounded-md border px-2.5 py-1 text-[0.75rem] font-medium transition-colors hover:bg-white/[0.06]"
      style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
    >
      {label}
    </button>
  );
}

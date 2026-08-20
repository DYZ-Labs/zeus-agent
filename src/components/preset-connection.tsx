"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, type ReactNode } from "react";

import {
  configureConnectorPresetAction,
  disconnectGoogleCalendarAction,
  disconnectGoogleGmailAction,
  removeConnectorAction,
  verifyConnectorAction,
  type ConnectorSetupState,
} from "@/app/actions";
import { GMAIL_PRESET_ID, type ConnectorPreset } from "@/core/connector-catalog";
import type { ConnectorView } from "@/core/connectors";
import type { CapabilitySlot } from "@/core/schema";

const INITIAL_STATE: ConnectorSetupState = {
  status: "idle",
  code: "idle",
  message: "",
};

/**
 * One connected service, rendered from its catalog preset.
 *
 * Was Calendar-shaped throughout — label, icon, preset id, and default slot all literals —
 * which is workable for one connection and a copy-paste invitation for the second. The
 * preset carries the identity now; what stays as props is the part presets genuinely differ
 * on: an icon, and whether there is a hosted path at all.
 *
 * `hostedStartHref` is null for a preset without an account-bound broker path. Local mode
 * still uses the user's own Application Default Credentials; hosted mode always starts the
 * provider-specific OAuth flow instead of spending process-wide credentials.
 *
 * `recheckLabel` opts a preset into a re-read control. Connecting and reading are two
 * separate things that can fail separately, and this card only ever reported the first — so
 * a service that handshakes and then cannot read showed a green dot while Zeus said it could
 * see nothing, with no way to find out which half was broken.
 */
export function PresetConnection({
  preset,
  icon,
  defaultSlots,
  hostedStartHref = null,
  recheckLabel = null,
  connector,
  localMode,
  available,
}: {
  preset: ConnectorPreset;
  icon: ReactNode;
  defaultSlots: CapabilitySlot[];
  hostedStartHref?: string | null;
  recheckLabel?: string | null;
  connector: ConnectorView | null;
  localMode: boolean;
  available: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    configureConnectorPresetAction,
    INITIAL_STATE,
  );
  const connected =
    available && connector?.status === "ready" && connector.enabled === 1;
  const grantedSlots = connector?.capabilities
    .filter((capability) => capability.enabled === 1)
    .map((capability) => capability.slot) ?? [];
  const localSlots: CapabilitySlot[] =
    grantedSlots.length > 0 ? grantedSlots : defaultSlots;

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  return (
    <article
      className="mt-6 overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--shell-line-strong)" }}
    >
      <div className="flex items-center gap-3 px-4 py-4">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border"
          style={{
            background: "var(--shell-elevated)",
            borderColor: "var(--shell-line)",
            color: "var(--shell-muted)",
          }}
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium leading-5">{preset.label}</h2>
          <p
            role="status"
            className="mt-0.5 flex items-center gap-1.5 text-xs leading-4"
            style={{ color: connected ? "#86efac" : "var(--shell-faint)" }}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: connected ? "#22c55e" : "var(--shell-faint)" }}
            />
            {connected ? "Connected" : "Not connected"}
          </p>
        </div>

        {connected && connector ? (
          <div className="flex shrink-0 items-center gap-2">
            {recheckLabel ? (
              <form action={verifyConnectorAction}>
                <input type="hidden" name="id" value={connector.id} />
                <SecondaryButton label={recheckLabel} />
              </form>
            ) : null}
            {localMode ? (
              <form action={removeConnectorAction}>
                <input type="hidden" name="id" value={connector.id} />
                <SecondaryButton label="Disconnect" />
              </form>
            ) : (
              <form
                action={
                  preset.id === GMAIL_PRESET_ID
                    ? disconnectGoogleGmailAction
                    : disconnectGoogleCalendarAction
                }
              >
                <SecondaryButton label="Disconnect" />
              </form>
            )}
          </div>
        ) : localMode ? (
          <form action={formAction}>
            <input type="hidden" name="presetId" value={preset.id} />
            {connector ? <input type="hidden" name="connectorId" value={connector.id} /> : null}
            {localSlots.map((slot) => (
              <input key={slot} type="hidden" name="slots" value={slot} />
            ))}
            <ConnectButton disabled={pending || !available} pending={pending} />
          </form>
        ) : available && hostedStartHref ? (
          <a
            href={hostedStartHref}
            className="shrink-0 rounded-lg px-3.5 py-2 text-sm font-medium"
            style={{ background: "var(--shell-accent)", color: "#000000" }}
          >
            Connect
          </a>
        ) : (
          <ConnectButton disabled pending={false} />
        )}
      </div>

      {state.status === "error" ? (
        <p
          className="border-t px-4 py-3 text-xs leading-5"
          style={{ borderColor: "var(--shell-line)", color: "var(--shell-muted)" }}
          role="alert"
        >
          {state.message}
        </p>
      ) : null}

      {!available && !localMode ? (
        <p
          className="border-t px-4 py-3 text-xs leading-5"
          style={{ borderColor: "var(--shell-line)", color: "var(--shell-muted)" }}
        >
          {preset.label} connections are unavailable right now.
        </p>
      ) : null}
    </article>
  );
}

function ConnectButton({ disabled, pending }: { disabled: boolean; pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="shrink-0 rounded-lg px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
      style={{ background: "var(--shell-accent)", color: "#000000" }}
    >
      {pending ? "Connecting…" : "Connect"}
    </button>
  );
}

function SecondaryButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="shrink-0 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors hover:bg-white/[0.06]"
      style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
    >
      {label}
    </button>
  );
}

export function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M8 3.5v3M16 3.5v3M3.5 9h17" strokeLinecap="round" />
      <path d="M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01" strokeLinecap="round" strokeWidth="2.2" />
    </svg>
  );
}

export function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3.6 7.2 12 13l8.4-5.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

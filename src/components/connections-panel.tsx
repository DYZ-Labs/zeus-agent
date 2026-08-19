import {
  CalendarIcon,
  MailIcon,
  PresetConnection,
} from "@/components/preset-connection";
import {
  GMAIL_PRESET,
  GMAIL_PRESET_ID,
  GOOGLE_CALENDAR_PRESET,
  GOOGLE_CALENDAR_PRESET_ID,
} from "@/core/connector-catalog";
import type { ConnectorView } from "@/core/connectors";

export function ConnectionsPanel({
  connectors,
  errorMessage,
  localMode,
  googleCalendarAvailable,
  hostedAccount,
}: {
  connectors: ConnectorView[];
  errorMessage: string | null;
  localMode: boolean;
  googleCalendarAvailable: boolean;
  hostedAccount: boolean;
}) {
  const googleCalendar = localMode
    ? connectors.find((connector) => connector.preset_id === GOOGLE_CALENDAR_PRESET_ID) ?? null
    : connectors.find((connector) => connector.provider === "google_calendar") ?? null;
  const gmail =
    connectors.find((connector) => connector.preset_id === GMAIL_PRESET_ID) ?? null;

  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Connections</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        Manage the accounts connected to Zeus.
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

      <PresetConnection
        preset={GOOGLE_CALENDAR_PRESET}
        icon={<CalendarIcon />}
        defaultSlots={["calendar.list_events"]}
        hostedStartHref="/api/integrations/google-calendar/start?permission=read"
        connector={googleCalendar}
        localMode={localMode}
        available={localMode || (hostedAccount && googleCalendarAvailable)}
      />

      {/*
        Gmail is local-only: `gmail.readonly` is a Google restricted scope, so a hosted
        multi-account deployment would need app verification and an annual security
        assessment before anyone but the operator could consent. No hosted path, and
        `available` follows local mode alone.
      */}
      <PresetConnection
        preset={GMAIL_PRESET}
        icon={<MailIcon />}
        defaultSlots={["email.search_threads", "email.get_thread"]}
        connector={gmail}
        localMode={localMode}
        available={localMode}
      />
    </section>
  );
}

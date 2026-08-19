import Link from "next/link";

import {
  followThroughDecisionAction,
  reviewBehavioralPolicySuggestionAction,
  setStewardshipModeAction,
  updateAmbientSettingAction,
} from "@/app/actions";
import { logoutAction } from "@/app/auth/actions";
import { ConnectionsPanel } from "@/components/connections-panel";
import { DeleteAllConversations } from "@/components/delete-all-conversations";
import { CoarseLocationControl } from "@/components/coarse-location-control";
import { SettingsModal } from "@/components/settings-modal";
import { getAmbientSetting, getFreshCoarseLocation } from "@/core/ambient";
import { listConnectors } from "@/core/connectors";
import { listChatHistory } from "@/core/conversations";
import { listBehavioralPolicySuggestions } from "@/core/personalization";
import type {
  FollowThroughEventView,
  BehavioralPolicySuggestionView,
  StewardshipMode,
} from "@/core/schema";
import {
  followThroughMetrics,
  getStewardshipSetting,
  listFollowThroughEvents,
} from "@/core/stewardship";
import { getOwnerAccess, type OwnerAccess } from "@/server/auth/access";
import { getGoogleCalendarIntegrationConfiguration } from "@/server/google-calendar/config";
import { getGoogleGmailIntegrationConfiguration } from "@/server/google-gmail/config";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await getOwnerAccess();
  const resolvedSearchParams = await searchParams;
  const connectorError = resolvedSearchParams.connector_error;
  const googleCalendarConfiguration = getGoogleCalendarIntegrationConfiguration();
  const googleGmailConfiguration = getGoogleGmailIntegrationConfiguration();
  const privateSettings = access.canAccessPrivateData
    ? {
        setting: getStewardshipSetting(access.db),
        metrics: followThroughMetrics(access.db),
        events: listFollowThroughEvents(access.db, 20),
        visibleConversationCount: listChatHistory(access.db, 100_000).length,
        ambient: getAmbientSetting(access.db),
        location: getFreshCoarseLocation(access.db),
        behavioralSuggestions: listBehavioralPolicySuggestions(access.db, { limit: 20 }),
        connectors: listConnectors(access.db),
      }
    : null;

  return (
    <SettingsModal
      account={<AccountSettings access={access} />}
      followThrough={
        privateSettings ? (
          <FollowThroughSettings
            mode={privateSettings.setting.mode}
            metrics={privateSettings.metrics}
            events={privateSettings.events}
            ambient={privateSettings.ambient}
            location={privateSettings.location}
            behavioralSuggestions={privateSettings.behavioralSuggestions}
          />
        ) : (
          <LockedSettings />
        )
      }
      connections={
        privateSettings ? (
          <ConnectionsPanel
            connectors={privateSettings.connectors}
            errorMessage={typeof connectorError === "string" ? connectorError : null}
            localMode={access.state === "local"}
            googleCalendarAvailable={googleCalendarConfiguration.state === "ready"}
            googleGmailAvailable={googleGmailConfiguration.state === "ready"}
            hostedAccount={access.state === "authorized"}
          />
        ) : (
          <LockedSettings />
        )
      }
      dataControls={
        privateSettings ? (
          <DataControlsSettings visibleConversationCount={privateSettings.visibleConversationCount} />
        ) : (
          <LockedSettings />
        )
      }
    />
  );
}

function AccountSettings({ access }: { access: OwnerAccess }) {
  if (access.state === "authorized" && access.account) {
    const label = access.account.name?.trim() || access.account.email;
    const initial = label.slice(0, 1).toLocaleUpperCase();

    return (
      <section className="px-5 py-5 sm:px-6 sm:py-6">
        <h1 className="text-lg font-semibold leading-6">Account</h1>
        <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
          This verified account is the only web identity linked to your Zeus memory.
        </p>
        <div className="mt-6 flex items-center gap-3 border-y py-4" style={{ borderColor: "var(--shell-line)" }}>
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            style={{ background: "var(--shell-accent)", color: "#000000" }}
          >
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{label}</p>
            <p className="truncate text-xs" style={{ color: "var(--shell-faint)" }}>
              {access.account.email} · {providerLabel(access.account.provider)}
            </p>
          </div>
        </div>
        <form action={logoutAction} className="mt-5">
          <button
            type="submit"
            className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-white/[0.06]"
            style={{ borderColor: "var(--shell-line-strong)" }}
          >
            Log out
          </button>
        </form>
      </section>
    );
  }

  if (access.state === "local") {
    return (
      <section className="px-5 py-5 sm:px-6 sm:py-6">
        <h1 className="text-lg font-semibold leading-6">Account</h1>
        <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
          Zeus is running in local-only mode. Add the Supabase values from .env.example to enable login.
        </p>
        <AuthLinks />
      </section>
    );
  }

  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Account</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        {access.message}
      </p>
      {access.account ? (
        <form action={logoutAction} className="mt-5">
          <button
            type="submit"
            className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-white/[0.06]"
            style={{ borderColor: "var(--shell-line-strong)" }}
          >
            Log out {access.account.email}
          </button>
        </form>
      ) : (
        <AuthLinks />
      )}
    </section>
  );
}

function AuthLinks() {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      <Link
        href="/auth/login?next=/settings"
        className="rounded-lg px-4 py-2 text-sm font-medium"
        style={{ background: "var(--shell-accent)", color: "#000000" }}
      >
        Log in
      </Link>
      <Link
        href="/auth/signup?next=/settings"
        className="rounded-lg border px-4 py-2 text-sm font-medium"
        style={{ borderColor: "var(--shell-line-strong)" }}
      >
        Sign up
      </Link>
    </div>
  );
}

function LockedSettings() {
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Login required</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        Sign in to view or change your private Zeus data.
      </p>
      <AuthLinks />
    </section>
  );
}

function providerLabel(provider: string | null): string {
  return provider === "google" ? "Google" : "Email";
}

function FollowThroughSettings({
  mode,
  metrics,
  events,
  ambient,
  location,
  behavioralSuggestions,
}: {
  mode: StewardshipMode;
  metrics: ReturnType<typeof followThroughMetrics>;
  events: FollowThroughEventView[];
  ambient: ReturnType<typeof getAmbientSetting>;
  location: ReturnType<typeof getFreshCoarseLocation>;
  behavioralSuggestions: BehavioralPolicySuggestionView[];
}) {
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Follow-through</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        Choose when Zeus may surface one useful next action.
      </p>

      <div className="mt-6">
        <h2 className="text-sm font-medium leading-5">When Zeus should speak up</h2>
        <p className="mt-1 text-sm leading-5" style={{ color: "var(--shell-faint)" }}>
          Snoozes and dismissals always take priority over this setting.
        </p>
        <div className="mt-3 overflow-hidden rounded-xl border" style={{ borderColor: "var(--shell-line-strong)" }}>
          {MODE_OPTIONS.map((option, index) => {
            const selected = mode === option.mode;

            return (
              <form action={setStewardshipModeAction} key={option.mode}>
                <input type="hidden" name="mode" value={option.mode} />
                <button
                  type="submit"
                  aria-pressed={selected}
                  className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.05]"
                  style={{
                    background: selected ? "var(--shell-elevated)" : "var(--shell-panel)",
                    borderTop: index > 0 ? "1px solid var(--shell-line)" : undefined,
                  }}
                >
                  <span
                    aria-hidden
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                    style={{
                      borderColor: selected ? "var(--shell-fg)" : "var(--shell-line-strong)",
                    }}
                  >
                    {selected && <span className="h-2 w-2 rounded-full" style={{ background: "var(--shell-fg)" }} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-normal leading-5">{option.label}</span>
                    <span className="block text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
                      {option.description}
                    </span>
                  </span>
                </button>
              </form>
            );
          })}
        </div>
      </div>

      <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--shell-line)" }}>
        <h2 className="text-sm font-medium leading-5">Ambient anticipation</h2>
        <p className="mt-1 text-sm leading-5" style={{ color: "var(--shell-faint)" }}>
          Disabled by default. When enabled and explicitly installed, Zeus evaluates current
          opportunities locally every 15 minutes and may deliver at most one macOS notification
          per local day. Missed notifications are never replayed.
        </p>
        <form action={updateAmbientSettingAction} className="mt-4 space-y-3">
          <label className="flex items-start gap-3 text-sm">
            <input name="enabled" type="checkbox" defaultChecked={ambient.enabled === 1} className="mt-1" />
            <span>
              Enable ambient evaluation
              <span className="block text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
                The worker still stays quiet during quiet hours and when nothing is worth surfacing.
              </span>
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs" style={{ color: "var(--shell-faint)" }}>
              IANA timezone
              <input
                name="timezone"
                required
                defaultValue={ambient.timezone}
                maxLength={100}
                className="mt-1 min-h-9 w-full rounded-lg border px-2 text-sm"
                style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
              />
            </label>
            <label className="text-xs" style={{ color: "var(--shell-faint)" }}>
              Quiet from
              <input
                name="quietStart"
                type="time"
                required
                defaultValue={ambient.quiet_start}
                className="mt-1 min-h-9 w-full rounded-lg border px-2 text-sm"
                style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
              />
            </label>
            <label className="text-xs" style={{ color: "var(--shell-faint)" }}>
              Quiet until
              <input
                name="quietEnd"
                type="time"
                required
                defaultValue={ambient.quiet_end}
                className="mt-1 min-h-9 w-full rounded-lg border px-2 text-sm"
                style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
              />
            </label>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input name="locationConsent" type="checkbox" defaultChecked={ambient.location_consent === 1} className="mt-1" />
            <span>
              Allow short-lived, user-named coarse zones
              <span className="block text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
                Revoking consent immediately deletes the current zone signal.
              </span>
            </span>
          </label>
          <button
            type="submit"
            className="rounded-lg border px-3 py-2 text-sm font-medium"
            style={{ borderColor: "var(--shell-line-strong)" }}
          >
            Save ambient settings
          </button>
        </form>
        <CoarseLocationControl
          enabled={ambient.enabled === 1}
          consent={ambient.location_consent === 1}
          currentZone={location?.zone_id ?? null}
          expiresAt={location?.expires_at ?? null}
        />
        <p className="mt-4 rounded-lg px-3 py-2 font-mono text-[0.62rem] leading-5" style={{ background: "var(--shell-elevated)", color: "var(--shell-faint)" }}>
          Explicit macOS install: npm run ambient:install · remove: npm run ambient:uninstall
        </p>
      </div>

      <div className="mt-6 border-t pt-5" style={{ borderColor: "var(--shell-line)" }}>
        <h2 className="text-sm font-medium leading-5">Behavioral policy review</h2>
        <p className="mt-1 text-sm leading-5" style={{ color: "var(--shell-faint)" }}>
          Repeated explicit feedback can suggest a quieter policy for review. These proposals
          are not memories and never activate a routine or increase interruptions.
        </p>
        {behavioralSuggestions.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--shell-faint)" }}>
            No review suggestions.
          </p>
        ) : (
          <ol className="mt-3 space-y-2">
            {behavioralSuggestions.map((suggestion) => (
              <li
                key={suggestion.id}
                className="rounded-lg border px-3 py-3"
                style={{ borderColor: "var(--shell-line)", background: "var(--shell-panel)" }}
              >
                <p className="text-sm leading-5">{suggestion.summary}</p>
                <p className="mt-1 text-xs" style={{ color: "var(--shell-faint)" }}>
                  {suggestion.status.replace(/_/gu, " ")} · {suggestion.evidence_event_ids.length}{" "}
                  explicit feedback events · change: {suggestion.allowed_interruption_change.replace(/_/gu, " ")}
                </p>
                {suggestion.status === "pending" && (
                  <div className="mt-2 flex gap-3 text-xs">
                    <form action={reviewBehavioralPolicySuggestionAction}>
                      <input type="hidden" name="id" value={suggestion.id} />
                      <input type="hidden" name="decision" value="keep_for_review" />
                      <button type="submit" className="font-medium" style={{ color: "var(--shell-accent)" }}>
                        Keep for review
                      </button>
                    </form>
                    <form action={reviewBehavioralPolicySuggestionAction}>
                      <input type="hidden" name="id" value={suggestion.id} />
                      <input type="hidden" name="decision" value="dismiss" />
                      <button type="submit" style={{ color: "var(--shell-faint)" }}>
                        Dismiss
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <details className="mt-6 border-t pt-4" style={{ borderColor: "var(--shell-line)" }}>
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm leading-5">
          <span>Follow-through activity</span>
          <ChevronIcon />
        </summary>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Metric value={metrics.progressWithoutRegret} label="Progress without regret" />
          <Metric value={metrics.accepted} label="Offers accepted" />
          <Metric value={metrics.controlsExercised} label="Snoozed or dismissed" />
          <Metric value={metrics.regrets} label="Regret signals" />
        </div>
        <p className="mt-3 text-sm leading-5" style={{ color: "var(--shell-faint)" }}>
          These are transparent control signals, not an engagement score.
        </p>
        {events.length > 0 && (
          <ol className="mt-3">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}

function DataControlsSettings({
  visibleConversationCount,
}: {
  visibleConversationCount: number;
}) {
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Data controls</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        Manage which chats appear in Recents and Search chats.
      </p>

      <div className="mt-5 border-y" style={{ borderColor: "var(--shell-line)" }}>
        <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-5">Delete all conversations</p>
            <p className="mt-0.5 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
              Clears every chat from Recents and Search chats without deleting saved memory or source messages.
            </p>
          </div>
          <DeleteAllConversations disabled={visibleConversationCount === 0} />
        </div>
      </div>
    </section>
  );
}

function EventRow({ event }: { event: FollowThroughEventView }) {
  return (
    <li className="flex flex-wrap items-start gap-3 border-t py-3" style={{ borderColor: "var(--shell-line)" }}>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5">{event.commitment_title}</p>
        <p className="mt-0.5 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
          {event.created_at.slice(0, 10)} · {event.event_type} · {event.reason.replace(/_/gu, " ")}
          {event.goal_title ? ` · ${event.goal_title}` : ""}
        </p>
      </div>
      {event.event_type === "completed" && (
        <form action={followThroughDecisionAction} className="flex flex-wrap items-center justify-end gap-2">
          <input type="hidden" name="id" value={event.commitment_id} />
          <input type="hidden" name="decision" value="regretted" />
          <input
            name="reason"
            maxLength={1000}
            placeholder="Reason (optional)"
            aria-label="Optional reason for regret"
            className="min-h-[32px] rounded-md border px-2 text-sm"
            style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)" }}
          />
          <button type="submit" className="text-sm leading-5" style={{ color: "var(--shell-faint)" }}>
            Caused regret
          </button>
        </form>
      )}
    </li>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: "var(--shell-elevated)" }}>
      <p className="text-sm font-medium leading-5 tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
        {label}
      </p>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m8.5 10 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MODE_OPTIONS: readonly {
  mode: StewardshipMode;
  label: string;
  description: string;
}[] = [
  { mode: "off", label: "Off", description: "No unsolicited chat or background opportunities; explicit Today and next-step requests still work." },
  { mode: "quiet", label: "Quiet", description: "Only relevant or clearly overdue items." },
  { mode: "balanced", label: "Balanced", description: "Relevant, due, waiting, or forgotten items." },
  { mode: "proactive", label: "Proactive", description: "Earlier notice with a shorter cooldown." },
];

import {
  followThroughDecisionAction,
  setStewardshipModeAction,
} from "@/app/actions";
import { logoutAction } from "@/app/auth/actions";
import { DeleteAllRecentChats } from "@/components/delete-all-conversations";
import { SettingsModal } from "@/components/settings-modal";
import { listChatHistory } from "@/core/conversations";
import Link from "next/link";
import type {
  FollowThroughEventView,
  StewardshipMode,
} from "@/core/schema";
import {
  followThroughMetrics,
  getStewardshipSetting,
  listFollowThroughEvents,
} from "@/core/stewardship";
import { getOwnerAccess, type OwnerAccess } from "@/server/auth/access";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const access = await getOwnerAccess();
  const privateSettings = access.canAccessPrivateData
    ? {
        setting: getStewardshipSetting(access.db),
        metrics: followThroughMetrics(access.db),
        events: listFollowThroughEvents(access.db, 20),
        recentChatCount: listChatHistory(access.db, 500).length,
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
          />
        ) : (
          <LockedSettings />
        )
      }
      dataControls={
        privateSettings ? (
          <DataControlsSettings recentChatCount={privateSettings.recentChatCount} />
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
        href="/auth/login"
        className="rounded-lg px-4 py-2 text-sm font-medium"
        style={{ background: "var(--shell-accent)", color: "#000000" }}
      >
        Log in
      </Link>
      <Link
        href="/auth/signup"
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
        Sign in with the linked owner account to view or change private Zeus data.
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
}: {
  mode: StewardshipMode;
  metrics: ReturnType<typeof followThroughMetrics>;
  events: FollowThroughEventView[];
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

function DataControlsSettings({ recentChatCount }: { recentChatCount: number }) {
  return (
    <section className="px-5 py-5 sm:px-6 sm:py-6">
      <h1 className="text-lg font-semibold leading-6">Data controls</h1>
      <p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        Manage which chats appear in Recents and Search chats.
      </p>

      <div className="mt-5 border-y" style={{ borderColor: "var(--shell-line)" }}>
        <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-5">Delete all recent chats</p>
            <p className="mt-0.5 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
              Removes every chat from Recents and Search chats without deleting stored messages or saved details.
            </p>
          </div>
          <DeleteAllRecentChats disabled={recentChatCount === 0} />
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
  { mode: "quiet", label: "Quiet", description: "Only relevant or clearly overdue items." },
  { mode: "balanced", label: "Balanced", description: "Relevant, due, waiting, or forgotten items." },
  { mode: "proactive", label: "Proactive", description: "Earlier notice with a shorter cooldown." },
];

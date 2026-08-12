import Link from "next/link";

import { logoutAction } from "@/app/auth/actions";
import {
  setLabsEnabledAction,
  setRememberingModeAction,
  setSuggestionModeAction,
} from "@/app/experience-actions";
import { DeleteAllConversations } from "@/components/delete-all-conversations";
import { SettingsModal } from "@/components/settings-modal";
import type { ExperienceSettings } from "@/core/contracts";
import { getExperienceSettings } from "@/core/experience";
import { getOwnerAccess, type OwnerAccess } from "@/server/auth/access";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const access = await getOwnerAccess();
  const privateSettings = access.canAccessPrivateData
    ? {
        experience: getExperienceSettings(access.db),
      }
    : null;
  const locked = <LockedSettings />;

  return (
    <SettingsModal
      account={<AccountSettings access={access} />}
      memory={privateSettings ? <RememberingSettings settings={privateSettings.experience} /> : locked}
      suggestions={privateSettings ? <SuggestionSettings settings={privateSettings.experience} /> : locked}
      dataControls={privateSettings ? <DataControlsSettings accountBacked={access.state === "authorized"} /> : locked}
      labs={privateSettings ? <LabsSettings settings={privateSettings.experience} /> : locked}
    />
  );
}

function AccountSettings({ access }: { access: OwnerAccess }) {
  if (access.state === "authorized" && access.account) {
    const label = access.account.name?.trim() || access.account.email;
    const initial = label.slice(0, 1).toLocaleUpperCase();
    return (
      <SettingsSection title="Account" description="Your private Zeus space is linked to this account.">
        <div className="mt-6 flex items-center gap-3 border-y py-4" style={{ borderColor: "var(--shell-line)" }}>
          <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ background: "var(--shell-accent)", color: "#000000" }}>{initial}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{label}</p>
            <p className="truncate text-xs" style={{ color: "var(--shell-faint)" }}>{access.account.email}</p>
          </div>
        </div>
        <form action={logoutAction} className="mt-5">
          <button type="submit" className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-white/[0.06]" style={{ borderColor: "var(--shell-line-strong)" }}>Log out</button>
        </form>
      </SettingsSection>
    );
  }

  if (access.state === "local") {
    return (
      <SettingsSection title="Account" description="You are using the local edition. This store has one owner and is not exposed as a multi-user service.">
        <p className="mt-6 rounded-xl border px-4 py-3 text-sm leading-5" style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}>
          Your conversations and remembered details remain in this local Zeus store.
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Account" description={access.message}>
      <AuthLinks />
    </SettingsSection>
  );
}

function RememberingSettings({ settings }: { settings: ExperienceSettings }) {
  const options = [
    { value: "automatic", label: "Automatic", description: "Save clear, non-sensitive details and always show what changed." },
    { value: "confirm", label: "Ask before saving", description: "Put every proposed detail in About you for your approval first." },
    { value: "off", label: "Off", description: "Do not read existing memory or learn from new chats. Existing saved data is kept." },
  ] as const;
  return (
    <SettingsSection title="Remembering" description="Choose whether Zeus may use and save details across conversations.">
      <OptionList action={setRememberingModeAction} selected={settings.rememberingMode} options={options} />
      <p className="mt-5 text-xs leading-5" style={{ color: "var(--shell-faint)" }}>
        Temporary chat always ignores these settings: it reads no saved memory and disappears on refresh.
      </p>
    </SettingsSection>
  );
}

function SuggestionSettings({ settings }: { settings: ExperienceSettings }) {
  const options = [
    { value: "off", label: "Off", description: "Only respond when you ask." },
    { value: "important", label: "Important only", description: "Speak up for clearly relevant or overdue plans." },
    { value: "helpful", label: "Helpful", description: "Offer one useful next step when timing and context support it." },
    { value: "proactive", label: "More proactive", description: "Surface relevant plans earlier and with a shorter cooldown." },
  ] as const;
  return (
    <SettingsSection title="Suggestions" description="Zeus offers at most one follow-through suggestion at a time.">
      <OptionList action={setSuggestionModeAction} selected={settings.suggestionMode} options={options} />
      <div className="mt-7 border-t pt-5" style={{ borderColor: "var(--shell-line)" }}>
        <h2 className="text-sm font-medium">Notifications</h2>
        <p className="mt-1 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
          Off. Zeus will ask separately before enabling any notification channel.
        </p>
      </div>
    </SettingsSection>
  );
}

function DataControlsSettings({ accountBacked }: { accountBacked: boolean }) {
  return (
    <SettingsSection title="Data controls" description="Export, hide, or permanently remove your Zeus data.">
      <div className="mt-5 divide-y border-y" style={{ borderColor: "var(--shell-line)" }}>
        <ControlRow title="Hidden chats" description="Restore archived chats or permanently delete a source after reviewing the impact.">
          <Link href="/conversations?view=hidden" className="rounded-full border px-3.5 py-2 text-sm font-medium" style={{ borderColor: "var(--shell-line-strong)" }}>View</Link>
        </ControlRow>
        <ControlRow title="Export all data" description="Download a portable copy of conversations, remembered details, plans, and audit history.">
          <a href="/api/export" download className="rounded-full border px-3.5 py-2 text-sm font-medium" style={{ borderColor: "var(--shell-line-strong)" }}>Export</a>
        </ControlRow>
        <ControlRow title="Clear Zeus data" description="Permanently erase conversations, remembered details, plans, settings, and activity history.">
          <DeleteAllConversations label="Clear data" />
        </ControlRow>
        {accountBacked && (
          <ControlRow title="Delete account" description="Permanently remove your Zeus data, then delete the account.">
            <Link href="/settings/delete-account" className="rounded-full border px-3.5 py-2 text-sm font-medium" style={{ borderColor: "#7f1d1d", color: "#ff8585" }}>Delete account</Link>
          </ControlRow>
        )}
      </div>
    </SettingsSection>
  );
}

function LabsSettings({ settings }: { settings: ExperienceSettings }) {
  return (
    <SettingsSection title="Labs" description="Experimental and technical tools are off by default.">
      <form action={setLabsEnabledAction} className="mt-6 rounded-xl border px-4 py-4" style={{ borderColor: "var(--shell-line-strong)" }}>
        <input type="hidden" name="enabled" value={settings.labsEnabled ? "false" : "true"} />
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">Enable Labs</h2>
            <p className="mt-1 text-xs leading-5" style={{ color: "var(--shell-muted)" }}>
              Shows bounded-work tools and technical memory review. Labs can change and may require extra attention.
            </p>
          </div>
          <button type="submit" aria-pressed={settings.labsEnabled} className="rounded-full border px-3 py-1.5 text-xs font-medium" style={{ borderColor: "var(--shell-line-strong)", background: settings.labsEnabled ? "var(--shell-accent)" : "transparent", color: settings.labsEnabled ? "#000000" : "var(--shell-fg)" }}>
            {settings.labsEnabled ? "On" : "Off"}
          </button>
        </div>
      </form>
      {settings.labsEnabled && (
        <details className="mt-5 rounded-xl border px-4 py-3" style={{ borderColor: "var(--shell-line-strong)" }}>
          <summary className="cursor-pointer text-sm font-medium">Technical details</summary>
          <div className="mt-3 space-y-2 text-sm" style={{ color: "var(--shell-muted)" }}>
            <p>Bounded work plans and their receipts appear at the bottom of Today.</p>
            <Link href="/understanding/backfill" className="inline-block underline underline-offset-4">Review earlier conversations</Link>
          </div>
        </details>
      )}
    </SettingsSection>
  );
}

function OptionList<T extends string>({ action, selected, options }: { action: (formData: FormData) => Promise<void>; selected: T; options: readonly { value: T; label: string; description: string }[] }) {
  return (
    <div className="mt-6 overflow-hidden rounded-xl border" style={{ borderColor: "var(--shell-line-strong)" }}>
      {options.map((option, index) => {
        const active = selected === option.value;
        return (
          <form action={action} key={option.value}>
            <input type="hidden" name="mode" value={option.value} />
            <button type="submit" aria-pressed={active} className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-white/[0.05]" style={{ background: active ? "var(--shell-elevated)" : "var(--shell-panel)", borderTop: index ? "1px solid var(--shell-line)" : undefined }}>
              <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: active ? "var(--shell-fg)" : "var(--shell-line-strong)" }}>{active && <span className="h-2 w-2 rounded-full" style={{ background: "var(--shell-fg)" }} />}</span>
              <span className="min-w-0"><span className="block text-sm">{option.label}</span><span className="block text-xs leading-4" style={{ color: "var(--shell-faint)" }}>{option.description}</span></span>
            </button>
          </form>
        );
      })}
    </div>
  );
}

function SettingsSection({ title, description, children }: { title: string; description: React.ReactNode; children?: React.ReactNode }) {
  return <section className="px-5 py-5 sm:px-6 sm:py-6"><h1 className="text-lg font-semibold leading-6">{title}</h1><p className="mt-1.5 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>{description}</p>{children}</section>;
}

function ControlRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="flex min-h-20 flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{title}</p><p className="mt-0.5 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>{description}</p></div>{children}</div>;
}

function AuthLinks() {
  return <div className="mt-6 flex gap-3"><Link href="/auth/login?next=/settings" className="rounded-lg px-4 py-2 text-sm font-medium" style={{ background: "var(--shell-accent)", color: "#000000" }}>Log in</Link><Link href="/auth/signup?next=/settings" className="rounded-lg border px-4 py-2 text-sm font-medium" style={{ borderColor: "var(--shell-line-strong)" }}>Sign up</Link></div>;
}

function LockedSettings() {
  return <SettingsSection title="Login required" description="Log in to view or change private Zeus data."><AuthLinks /></SettingsSection>;
}

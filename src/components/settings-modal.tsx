"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SettingsSection = "account" | "follow-through" | "connections" | "data";

const SECTIONS: readonly SettingsSection[] = [
  "account",
  "follow-through",
  "connections",
  "data",
];

export function SettingsModal({
  account,
  followThrough,
  connections,
  dataControls,
}: {
  account: React.ReactNode;
  followThrough: React.ReactNode;
  connections: React.ReactNode;
  dataControls: React.ReactNode;
}) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<SettingsSection>("account");
  const dialogRef = useRef<HTMLElement>(null);

  const close = useCallback(() => {
    if (window.history.length > 1) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);

  const selectSection = useCallback((section: SettingsSection) => {
    setActiveSection(section);
    window.history.replaceState(
      window.history.state,
      "",
      `#${section}`,
    );
  }, []);

  useEffect(() => {
    function syncSectionFromHash() {
      const requestedSection = window.location.hash.slice(1) as SettingsSection;
      setActiveSection(SECTIONS.includes(requestedSection) ? requestedSection : "account");
    }

    syncSectionFromHash();
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;

    const focusFrame = window.requestAnimationFrame(() => {
      (dialog.querySelector<HTMLElement>('[aria-current="page"]') ?? dialog).focus();
    });

    function keepFocusInside(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const focused = document.activeElement;
      if (event.shiftKey && (focused === first || !dialog.contains(focused))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (focused === last || !dialog.contains(focused))) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", keepFocusInside);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keepFocusInside);
      previouslyFocused?.focus();
    };
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-0 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden border text-sm leading-5 shadow-2xl sm:h-[560px] sm:max-h-[calc(100vh-3rem)] sm:w-[680px] sm:max-w-[calc(100vw-3rem)] sm:flex-row sm:rounded-2xl"
        style={{
          background: "var(--shell-panel)",
          borderColor: "var(--shell-line-strong)",
          fontFamily:
            'ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, "Apple Color Emoji", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"',
        }}
      >
        <aside
          className="shrink-0 border-b sm:w-[180px] sm:border-b-0 sm:border-r"
          style={{ background: "var(--shell-sidebar)", borderColor: "var(--shell-line)" }}
        >
          <div className="flex h-12 items-center justify-between px-2 sm:h-auto sm:justify-start sm:pb-3 sm:pt-2">
            <span className="pl-2 text-lg font-semibold leading-6 sm:hidden">Settings</span>
            <button
              type="button"
              onClick={close}
              aria-label="Close settings"
              title="Close"
              className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.07]"
              style={{ color: "var(--shell-fg)" }}
            >
              <CloseIcon />
            </button>
          </div>

          <nav
            aria-label="Settings sections"
            className="flex gap-1 overflow-x-auto px-2 pb-2 sm:flex-col sm:overflow-visible"
          >
            <SettingsSectionButton
              label="Account"
              icon={<AccountIcon />}
              active={activeSection === "account"}
              onSelect={() => selectSection("account")}
            />
            <SettingsSectionButton
              label="Follow-through"
              icon={<FollowThroughIcon />}
              active={activeSection === "follow-through"}
              onSelect={() => selectSection("follow-through")}
            />
            <SettingsSectionButton
              label="Connections"
              icon={<ConnectionsIcon />}
              active={activeSection === "connections"}
              onSelect={() => selectSection("connections")}
            />
            <SettingsSectionButton
              label="Data controls"
              icon={<DataControlsIcon />}
              active={activeSection === "data"}
              onSelect={() => selectSection("data")}
            />
          </nav>
        </aside>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {activeSection === "account"
            ? account
            : activeSection === "follow-through"
              ? followThrough
              : activeSection === "connections"
                ? connections
                : dataControls}
        </div>
      </section>
    </div>
  );
}

function SettingsSectionButton({
  label,
  icon,
  active,
  onSelect,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm font-normal leading-5 transition-colors hover:bg-white/[0.06] sm:w-full"
      style={{
        background: active ? "var(--shell-elevated)" : undefined,
        color: active ? "var(--shell-fg)" : "var(--shell-muted)",
      }}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" strokeLinecap="round" />
    </svg>
  );
}

function FollowThroughIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" />
      <path d="m8.5 12 2.2 2.2 4.8-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ConnectionsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9.5 14.5 6.8 17.2a3.8 3.8 0 0 1-5.4-5.4l2.7-2.7" strokeLinecap="round" />
      <path d="M14.5 9.5l2.7-2.7a3.8 3.8 0 0 1 5.4 5.4l-2.7 2.7" strokeLinecap="round" />
      <path d="m9.2 14.8 5.6-5.6" strokeLinecap="round" />
    </svg>
  );
}

function DataControlsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <ellipse cx="10" cy="5.5" rx="6" ry="2.5" />
      <path d="M4 5.5v5c0 1.4 2.7 2.5 6 2.5.7 0 1.3-.1 1.9-.2M4 10.5v5c0 1.4 2.7 2.5 6 2.5" strokeLinecap="round" />
      <circle cx="17.5" cy="16.5" r="2.4" />
      <path d="M17.5 12.7v1.1M17.5 19.2v1.1M13.7 16.5h1.1M20.2 16.5h1.1M14.8 13.8l.8.8M19.4 18.4l.8.8M20.2 13.8l-.8.8M15.6 18.4l-.8.8" strokeLinecap="round" />
    </svg>
  );
}

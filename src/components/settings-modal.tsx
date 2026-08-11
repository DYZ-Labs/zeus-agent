"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type SettingsSection = "follow-through" | "data";

export function SettingsModal({
  followThrough,
  dataControls,
}: {
  followThrough: React.ReactNode;
  dataControls: React.ReactNode;
}) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<SettingsSection>("follow-through");

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
      section === "data" ? "#data" : "#follow-through",
    );
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close]);

  useEffect(() => {
    function syncSectionFromHash() {
      setActiveSection(window.location.hash === "#data" ? "data" : "follow-through");
    }

    syncSectionFromHash();
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-0 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex h-full w-full flex-col overflow-hidden border shadow-2xl sm:h-[560px] sm:max-h-[calc(100vh-3rem)] sm:w-[680px] sm:max-w-[calc(100vw-3rem)] sm:flex-row sm:rounded-2xl"
        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
      >
        <aside
          className="shrink-0 border-b sm:w-[180px] sm:border-b-0 sm:border-r"
          style={{ background: "var(--shell-sidebar)", borderColor: "var(--shell-line)" }}
        >
          <div className="flex h-12 items-center justify-between px-2 sm:h-auto sm:justify-start sm:pb-3 sm:pt-2">
            <span className="pl-2 text-base font-semibold sm:hidden">Settings</span>
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
              label="Follow-through"
              icon={<FollowThroughIcon />}
              active={activeSection === "follow-through"}
              onSelect={() => selectSection("follow-through")}
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
          {activeSection === "follow-through" ? followThrough : dataControls}
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
      className="flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm font-normal leading-5 transition-colors hover:bg-white/[0.06] sm:w-full"
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

function FollowThroughIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" />
      <path d="m8.5 12 2.2 2.2 4.8-5" strokeLinecap="round" strokeLinejoin="round" />
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

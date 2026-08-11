"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type SettingsSection = "follow-through" | "data";

export function SettingsModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<SettingsSection>("follow-through");

  const close = useCallback(() => {
    if (window.history.length > 1) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);

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

    const frame = requestAnimationFrame(syncSectionFromHash);
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", syncSectionFromHash);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-0 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex h-full w-full max-w-[920px] flex-col overflow-hidden border sm:h-[calc(100vh-3rem)] sm:max-h-[760px] sm:rounded-2xl"
        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
      >
        <header
          className="flex h-14 shrink-0 items-center justify-between border-b px-5 sm:px-6"
          style={{ borderColor: "var(--shell-line)" }}
        >
          <h1 id="settings-title" className="text-lg font-semibold leading-6">
            Settings
          </h1>
          <button
            type="button"
            onClick={close}
            aria-label="Close settings"
            title="Close"
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.08]"
            style={{ color: "var(--shell-muted)" }}
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-[18px] w-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label="Settings sections"
            className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-[190px] sm:flex-col sm:border-b-0 sm:border-r sm:p-3"
            style={{ background: "var(--shell-sidebar)", borderColor: "var(--shell-line)" }}
          >
            <SettingsSectionLink
              href="#follow-through"
              label="Follow-through"
              active={activeSection === "follow-through"}
              onSelect={() => setActiveSection("follow-through")}
            />
            <SettingsSectionLink
              href="#data"
              label="Data controls"
              active={activeSection === "data"}
              onSelect={() => setActiveSection("data")}
            />
          </nav>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-smooth">{children}</div>
        </div>
      </section>
    </div>
  );
}

function SettingsSectionLink({
  href,
  label,
  active,
  onSelect,
}: {
  href: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className="flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-normal leading-5 transition-colors hover:bg-white/[0.06] sm:w-full"
      style={{
        background: active ? "var(--shell-elevated)" : undefined,
        color: active ? "var(--shell-fg)" : "var(--shell-muted)",
      }}
    >
      {label}
    </a>
  );
}

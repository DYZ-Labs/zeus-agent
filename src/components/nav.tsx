"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  CHAT_UPDATED_EVENT,
  NEW_CHAT_EVENT,
} from "@/components/chat-events";
import type { RecentChat } from "@/core/conversations";

const PRIMARY_LINKS = [
  { href: "/today", label: "Today", icon: "today" },
  { href: "/memory", label: "Memory", icon: "memory" },
] as const;

type IconName = (typeof PRIMARY_LINKS)[number]["icon"] | "chats" | "settings";

export function Nav({ initialRecentChats }: { initialRecentChats: RecentChat[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    function refreshRecentChats() {
      router.refresh();
    }

    window.addEventListener(CHAT_UPDATED_EVENT, refreshRecentChats);
    return () => window.removeEventListener(CHAT_UPDATED_EVENT, refreshRecentChats);
  }, [router]);

  function startNewChat() {
    if (pathname === "/") {
      window.dispatchEvent(new Event(NEW_CHAT_EVENT));
      router.replace("/");
      return;
    }
    router.push("/");
  }

  if (!isOpen) {
    return (
      <nav
        aria-label="Primary"
        className="fixed left-3 top-3 z-50 flex flex-col gap-1"
        style={{ color: "var(--shell-muted)" }}
      >
        <button
          type="button"
          aria-label="Open sidebar"
          title="Open sidebar"
          onClick={() => setIsOpen(true)}
          className="group flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
          style={{ background: "var(--shell-bg)" }}
        >
          <span className="group-hover:hidden">
            <SidebarIcon />
          </span>
          <span className="hidden group-hover:flex">
            <ZeusMark />
          </span>
        </button>
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={startNewChat}
          className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
          style={{ background: "var(--shell-bg)" }}
        >
          <NewChatIcon />
        </button>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Primary"
      className="flex w-full min-w-0 shrink-0 flex-col overflow-hidden border-b px-3 py-3 lg:h-screen lg:w-[260px] lg:border-b-0 lg:px-3"
      style={{ background: "var(--shell-sidebar)", borderColor: "var(--shell-line)" }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between">
        <Link
          href="/"
          aria-label="Chat home"
          className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
        >
          <ZeusMark />
        </Link>
        <button
          type="button"
          aria-label="Close sidebar"
          title="Close sidebar"
          onClick={() => setIsOpen(false)}
          className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
          style={{ color: "var(--shell-muted)" }}
        >
          <SidebarIcon />
        </button>
      </div>

      <button
        type="button"
        onClick={startNewChat}
        className="mt-2 flex h-10 w-full shrink-0 items-center gap-3 rounded-lg px-3 text-[0.9rem] transition-colors hover:bg-white/[0.06]"
        style={{ color: "var(--shell-fg)" }}
      >
        <NewChatIcon />
        <span>New chat</span>
      </button>

      <ul className="mt-2 flex w-full min-w-0 gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {PRIMARY_LINKS.map((link) => {
          const active = pathname.startsWith(link.href);

          return (
            <li key={link.href} className="shrink-0 lg:w-full">
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className="flex h-10 items-center gap-3 rounded-lg px-3 text-[0.9rem] transition-colors hover:bg-white/[0.06] lg:w-full"
                style={{
                  color: active ? "var(--shell-fg)" : "var(--shell-muted)",
                  background: active ? "var(--shell-elevated)" : undefined,
                }}
              >
                <NavIcon name={link.icon} />
                <span>{link.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="shrink-0 lg:hidden">
          <NavLink
            href="/conversations"
            label="Recent chats"
            icon="chats"
            active={pathname.startsWith("/conversations")}
          />
        </li>
        <li className="shrink-0 lg:hidden">
          <NavLink
            href="/settings"
            label="Settings"
            icon="settings"
            active={pathname.startsWith("/settings")}
          />
        </li>
      </ul>

      <section className="mt-5 hidden min-h-0 flex-1 flex-col lg:flex" aria-labelledby="recent-chats-heading">
        <div className="flex items-center justify-between px-3">
          <h2
            id="recent-chats-heading"
            className="text-[0.72rem] font-medium"
            style={{ color: "var(--shell-faint)" }}
          >
            Recent
          </h2>
          <Link
            href="/conversations"
            className="text-[0.68rem] transition-colors hover:text-white"
            style={{ color: "var(--shell-faint)" }}
          >
            View all
          </Link>
        </div>
        <div className="mt-2 min-h-0 overflow-y-auto">
          {initialRecentChats.length > 0 ? (
            <ul className="space-y-0.5">
              {initialRecentChats.map((chat) => (
                <li key={chat.id}>
                  <Link
                    href={`/?conversation=${chat.id}`}
                    title={chat.title}
                    className="block truncate rounded-lg px-3 py-2 text-[0.82rem] transition-colors hover:bg-white/[0.06]"
                    style={{ color: "var(--shell-muted)" }}
                  >
                    {chat.title}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[0.76rem]" style={{ color: "var(--shell-faint)" }}>
              No recent chats
            </p>
          )}
        </div>
      </section>

      <Link
        href="/settings"
        aria-current={pathname.startsWith("/settings") ? "page" : undefined}
        className="mt-auto hidden h-10 items-center gap-3 rounded-lg px-3 text-[0.9rem] transition-colors hover:bg-white/[0.06] lg:flex"
        style={{
          color: pathname.startsWith("/settings") ? "var(--shell-fg)" : "var(--shell-muted)",
          background: pathname.startsWith("/settings") ? "var(--shell-elevated)" : undefined,
        }}
      >
        <NavIcon name="settings" />
        <span>Settings</span>
      </Link>

      <div
        className="mt-2 hidden border-t px-2 pt-3 lg:flex lg:items-center lg:gap-3"
        style={{ borderColor: "var(--shell-line)" }}
      >
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full text-[0.7rem] font-semibold"
          style={{ background: "var(--shell-elevated)", color: "var(--shell-fg)" }}
        >
          Z
        </span>
        <div className="min-w-0">
          <p className="text-[0.82rem] font-medium">Stored locally</p>
          <p className="truncate text-[0.7rem]" style={{ color: "var(--shell-faint)" }}>
            Private on this device
          </p>
        </div>
      </div>
    </nav>
  );
}

function NavLink({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="flex h-10 items-center gap-3 rounded-lg px-3 text-[0.9rem] transition-colors hover:bg-white/[0.06] lg:w-full"
      style={{
        color: active ? "var(--shell-fg)" : "var(--shell-muted)",
        background: active ? "var(--shell-elevated)" : undefined,
      }}
    >
      <NavIcon name={icon} />
      <span>{label}</span>
    </Link>
  );
}

function ZeusMark() {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 items-center justify-center rounded-full text-[0.72rem] font-bold"
      style={{ background: "var(--shell-accent)", color: "#000000" }}
    >
      Z
    </span>
  );
}

function SidebarIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M12 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V12" />
      <path d="m13 11 6.2-6.2a1.4 1.4 0 0 1 2 2L15 13l-3 1 1-3Z" strokeLinejoin="round" />
    </svg>
  );
}

function NavIcon({ name }: { name: IconName }) {
  if (name === "today") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l2.8 1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "memory") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M8 5.5a3 3 0 0 1 5.4-1.8A3.2 3.2 0 0 1 18 6.6a3.5 3.5 0 0 1 1 6.7A3.5 3.5 0 0 1 15.5 18H14a3 3 0 0 1-5.5.6A3.5 3.5 0 0 1 5 13.2a3.5 3.5 0 0 1 3-6.7Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 5v14M8 9h4M12 14h4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "chats") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 17.5 3.5 20v-4.5a7.5 7.5 0 1 1 3.5 2Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 9h8M8 12.5h5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6" strokeLinecap="round" />
    </svg>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  deleteConversationFromHistoryAction,
  renameConversationAction,
} from "@/app/actions";
import { CHAT_UPDATED_EVENT, NEW_CHAT_EVENT } from "@/components/chat-events";
import type { RecentChat } from "@/core/conversations";

const PRIMARY_LINKS = [
  { href: "/today", label: "Today", icon: "today" },
  { href: "/memory", label: "Memory", icon: "memory" },
  { href: "/understanding", label: "Understanding", icon: "understanding" },
] as const;

const COMPACT_LINKS = [
  { href: "/conversations", label: "Search chats", icon: "search" },
  ...PRIMARY_LINKS,
] as const;

type IconName = (typeof COMPACT_LINKS)[number]["icon"] | "settings";

export function Nav({ initialRecentChats }: { initialRecentChats: RecentChat[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isOpen, setIsOpen] = useState(true);
  const requestedConversationId = Number(searchParams.get("conversation"));
  const activeConversationId =
    pathname === "/" && Number.isInteger(requestedConversationId) && requestedConversationId > 0
      ? requestedConversationId
      : null;

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

  function finishConversationChange(deletedId?: number) {
    if (deletedId === activeConversationId) {
      window.dispatchEvent(new Event(NEW_CHAT_EVENT));
      router.replace("/");
      return;
    }
    router.refresh();
  }

  if (!isOpen) {
    return (
      <nav
        aria-label="Primary"
        className="flex w-full shrink-0 items-center gap-1 border-b px-3 py-2 lg:h-screen lg:w-[64px] lg:flex-col lg:border-b-0 lg:px-3 lg:py-3"
        style={{
          background: "var(--shell-bg)",
          borderColor: "var(--shell-line)",
          color: "var(--shell-muted)",
        }}
      >
        <button
          type="button"
          aria-label="Open sidebar"
          title="Open sidebar"
          onClick={() => setIsOpen(true)}
          className="group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
        >
          <span className="absolute flex transition-all duration-150 ease-out group-hover:scale-90 group-hover:opacity-0">
            <ZeusMark />
          </span>
          <span className="absolute flex scale-90 opacity-0 transition-all duration-150 ease-out group-hover:scale-100 group-hover:opacity-100">
            <SidebarIcon />
          </span>
        </button>
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={startNewChat}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
          style={{ color: "var(--shell-fg)" }}
        >
          <NewChatIcon />
        </button>

        {COMPACT_LINKS.map((link) => (
          <CompactNavLink
            key={link.href}
            href={link.href}
            label={link.label}
            icon={link.icon}
            active={pathname.startsWith(link.href)}
          />
        ))}

        <div className="hidden flex-1 lg:block" />
        <CompactNavLink
          href="/settings"
          label="Settings"
          icon="settings"
          active={pathname.startsWith("/settings")}
        />
      </nav>
    );
  }

  return (
    <nav
      aria-label="Primary"
      className="flex w-full min-w-0 shrink-0 flex-col overflow-hidden border-b px-3 py-3 lg:h-screen lg:w-[260px] lg:border-b-0"
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

      <div className="mt-2 flex gap-0.5 overflow-x-auto lg:block lg:space-y-0.5 lg:overflow-visible">
        <button
          type="button"
          onClick={startNewChat}
          className="grid h-9 w-auto shrink-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-normal leading-5 transition-colors hover:bg-white/[0.06] lg:w-full"
          style={{ color: "var(--shell-fg)" }}
        >
          <SidebarIconSlot>
            <NewChatIcon />
          </SidebarIconSlot>
          <span className="truncate">New chat</span>
        </button>
        <NavLink
          href="/conversations"
          label="Search chats"
          icon="search"
          active={pathname.startsWith("/conversations")}
        />
        {PRIMARY_LINKS.map((link) => (
          <NavLink
            key={link.href}
            href={link.href}
            label={link.label}
            icon={link.icon}
            active={pathname.startsWith(link.href)}
          />
        ))}
        <span className="shrink-0 lg:hidden">
          <CompactNavLink
            href="/settings"
            label="Settings"
            icon="settings"
            active={pathname.startsWith("/settings")}
          />
        </span>
      </div>

      <section className="mt-4 hidden min-h-0 flex-1 flex-col lg:flex" aria-labelledby="recent-chats-heading">
        <Link
          href="/conversations"
          className="group flex h-8 items-center justify-between rounded-lg px-2.5 transition-colors hover:bg-white/[0.04]"
        >
          <h2
            id="recent-chats-heading"
            className="text-xs font-semibold leading-5"
            style={{ color: "var(--shell-faint)" }}
          >
            Recents
          </h2>
          <span
            className="translate-x-[-2px] opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
            style={{ color: "var(--shell-faint)" }}
          >
            <ChevronRightIcon />
          </span>
        </Link>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-20">
          {initialRecentChats.length > 0 ? (
            <ul className="space-y-0.5">
              {initialRecentChats.map((chat, index) => (
                <ChatHistoryItem
                  key={chat.id}
                  chat={chat}
                  active={activeConversationId === chat.id}
                  menuPlacement={index >= initialRecentChats.length - 2 ? "above" : "below"}
                  onOpen={() => undefined}
                  onChanged={() => finishConversationChange()}
                  onDeleted={() => finishConversationChange(chat.id)}
                  directDelete
                />
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-2 text-sm leading-5" style={{ color: "var(--shell-faint)" }}>
              No chats yet
            </p>
          )}
        </div>
      </section>

      <div className="mt-auto hidden border-t pt-2 lg:block" style={{ borderColor: "var(--shell-line)" }}>
        <NavLink
          href="/settings"
          label="Settings"
          icon="settings"
          active={pathname.startsWith("/settings")}
        />
      </div>
    </nav>
  );
}

export function ChatHistoryItem({
  chat,
  active,
  menuPlacement,
  onOpen,
  onChanged,
  onDeleted,
  directDelete = false,
}: {
  chat: RecentChat;
  active: boolean;
  menuPlacement: "above" | "below";
  onOpen: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  directDelete?: boolean;
}) {
  const containerRef = useRef<HTMLLIElement>(null);
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState(chat.title);
  const [state, setState] = useState<"closed" | "menu" | "renaming" | "deleting">("closed");
  const [pending, setPending] = useState(false);

  const title = titleOverride ?? chat.title;

  useEffect(() => {
    if (state === "closed") return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setState("closed");
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setState("closed");
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [state]);

  async function saveRename() {
    const normalized = draftTitle.replace(/\s+/gu, " ").trim();
    if (!normalized) return;

    setPending(true);
    try {
      await renameConversationAction(chat.id, normalized);
      setTitleOverride(normalized);
      setDraftTitle(normalized);
      setState("closed");
      onChanged();
    } finally {
      setPending(false);
    }
  }

  async function deleteChat() {
    if (pending) return;

    setPending(true);
    try {
      await deleteConversationFromHistoryAction(chat.id, "delete");
      setState("closed");
      onDeleted();
    } finally {
      setPending(false);
    }
  }

  if (state === "renaming") {
    return (
      <li ref={containerRef}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
          className="flex h-9 items-center gap-1 rounded-lg px-2"
          style={{ background: "var(--shell-elevated)" }}
        >
          <input
            autoFocus
            value={draftTitle}
            maxLength={100}
            disabled={pending}
            onChange={(event) => setDraftTitle(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-0.5 text-sm leading-5 outline-none"
            aria-label="Chat title"
          />
          <button
            type="submit"
            aria-label="Save chat title"
            disabled={pending || !draftTitle.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/[0.07] disabled:opacity-40"
          >
            <CheckIcon />
          </button>
          <button
            type="button"
            aria-label="Cancel renaming"
            disabled={pending}
            onClick={() => {
              setDraftTitle(title);
              setState("closed");
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/[0.07]"
          >
            <SmallCloseIcon />
          </button>
        </form>
      </li>
    );
  }

  return (
    <li ref={containerRef} className="group relative">
      <Link
        href={`/?conversation=${chat.id}`}
        title={title}
        aria-current={active ? "page" : undefined}
        onClick={onOpen}
        className="flex h-8 min-w-0 items-center rounded-lg px-2.5 pr-9 text-sm font-normal leading-5 transition-colors hover:bg-white/[0.06]"
        style={{
          background: active ? "var(--shell-elevated)" : undefined,
          color: "var(--shell-fg)",
        }}
      >
        <span className="truncate">{title}</span>
      </Link>
      <button
        type="button"
        aria-label={directDelete ? `Delete ${title}` : `Chat options for ${title}`}
        title={directDelete ? "Delete" : undefined}
        aria-expanded={directDelete ? undefined : state !== "closed"}
        disabled={pending}
        onClick={() => {
          if (directDelete) {
            void deleteChat();
            return;
          }
          setState((current) => (current === "closed" ? "menu" : "closed"));
        }}
        className={`absolute right-1 top-0.5 flex h-7 w-7 items-center justify-center rounded-md [color:var(--shell-muted)] transition-all hover:bg-white/[0.09] ${
          directDelete ? "hover:[color:#ff6767]" : ""
        } disabled:cursor-wait disabled:opacity-50 ${
          active || state !== "closed"
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        }`}
      >
        {directDelete ? <TrashIcon /> : <MoreIcon />}
      </button>

      {state !== "closed" && (
        <div
          role="menu"
          className={`absolute right-1 z-30 w-52 rounded-xl border p-1.5 shadow-2xl ${
            menuPlacement === "above" ? "bottom-9" : "top-9"
          }`}
          style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)" }}
        >
          {state === "deleting" ? (
            <div className="p-2">
              <p className="text-sm font-medium leading-5">Remove this chat from history?</p>
              <p className="mt-1 text-xs leading-4" style={{ color: "var(--shell-faint)" }}>
                Its messages and saved details will stay stored.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setState("menu")}
                  className="h-8 rounded-lg px-2.5 text-xs hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void deleteChat()}
                  className="h-8 rounded-lg px-2.5 text-xs font-medium disabled:opacity-50"
                  style={{ background: "#7f1d1d", color: "#ffffff" }}
                >
                  {pending ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setDraftTitle(title);
                  setState("renaming");
                }}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-white/[0.07]"
              >
                <RenameIcon />
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setState("deleting")}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-white/[0.07]"
                style={{ color: "#ff6767" }}
              >
                <TrashIcon />
                Remove from history
              </button>
            </>
          )}
        </div>
      )}
    </li>
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
      className="grid h-9 shrink-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 text-sm font-normal leading-5 transition-colors hover:bg-white/[0.06] lg:w-full"
      style={{
        color: "var(--shell-fg)",
        background: active ? "var(--shell-elevated)" : undefined,
      }}
    >
      <SidebarIconSlot>
        <NavIcon name={icon} />
      </SidebarIconSlot>
      <span className="truncate">{label}</span>
    </Link>
  );
}

function CompactNavLink({
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
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
      style={{
        color: active ? "var(--shell-fg)" : "var(--shell-muted)",
        background: active ? "var(--shell-elevated)" : undefined,
      }}
    >
      <NavIcon name={icon} />
    </Link>
  );
}

function SidebarIconSlot({ children }: { children: React.ReactNode }) {
  return <span className="flex h-5 w-5 items-center justify-center">{children}</span>;
}

function ZeusMark() {
  return (
    <span
      aria-hidden
      className="flex h-6 w-6 items-center justify-center rounded-full text-[0.66rem] font-bold"
      style={{ background: "var(--shell-accent)", color: "#000000" }}
    >
      Z
    </span>
  );
}

function SidebarIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="4" width="17" height="16" rx="2.2" />
      <path d="M9 4v16" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V12" />
      <path d="m13 11 6.2-6.2a1.4 1.4 0 0 1 2 2L15 13l-3 1 1-3Z" strokeLinejoin="round" />
    </svg>
  );
}

function NavIcon({ name }: { name: IconName }) {
  if (name === "search") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="10.8" cy="10.8" r="6.3" />
        <path d="m15.5 15.5 4 4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "today") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l2.8 1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === "memory") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M8 5.5a3 3 0 0 1 5.4-1.8A3.2 3.2 0 0 1 18 6.6a3.5 3.5 0 0 1 1 6.7A3.5 3.5 0 0 1 15.5 18H14a3 3 0 0 1-5.5.6A3.5 3.5 0 0 1 5 13.2a3.5 3.5 0 0 1 3-6.7Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 5v14M8 9h4M12 14h4" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === "understanding") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="8" cy="9" r="3" />
        <circle cx="16" cy="9" r="3" />
        <path d="M3.8 19a4.2 4.2 0 0 1 8.4 0M11.8 19a4.2 4.2 0 0 1 8.4 0M10.5 12.5l3-3" strokeLinecap="round" />
      </svg>
    );
  }
  return <SettingsIcon />;
}

function SettingsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m9.7 3-.5 2.1c-.6.2-1.1.5-1.6.9l-2.1-.6-2.3 4 1.6 1.5a7 7 0 0 0 0 2.2l-1.6 1.5 2.3 4 2.1-.6c.5.4 1 .7 1.6.9l.5 2.1h4.6l.5-2.1c.6-.2 1.1-.5 1.6-.9l2.1.6 2.3-4-1.6-1.5a7 7 0 0 0 0-2.2l1.6-1.5-2.3-4-2.1.6c-.5-.4-1-.7-1.6-.9L14.3 3H9.7Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor">
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m14 5 5 5M4 20l3.5-.8L19 7.7a1.8 1.8 0 0 0-2.6-2.6L5 16.5 4 20Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m6 12 4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SmallCloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m7 7 10 10M17 7 7 17" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m10 7 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

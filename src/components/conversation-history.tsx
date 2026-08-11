"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { ChatHistoryItem } from "@/components/nav";

export type ConversationHistoryEntry = {
  id: number;
  title: string;
  updatedAt: string;
};

export function ConversationHistory({
  chats,
  referenceDate,
}: {
  chats: ConversationHistoryEntry[];
  referenceDate: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredChats = useMemo(
    () =>
      normalizedQuery
        ? chats.filter((chat) => chat.title.toLocaleLowerCase().includes(normalizedQuery))
        : chats,
    [chats, normalizedQuery],
  );
  const groups = useMemo(
    () => groupChats(filteredChats, referenceDate),
    [filteredChats, referenceDate],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className="flex h-14 shrink-0 items-center justify-between border-b px-5 lg:px-7"
        style={{ borderColor: "var(--shell-line)" }}
      >
        <h1 className="text-base font-semibold leading-6">Chats</h1>
        <Link
          href="/"
          className="flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors hover:bg-white/[0.06]"
        >
          <NewChatIcon />
          <span className="hidden sm:inline">New chat</span>
        </Link>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:py-8">
        <div className="mx-auto w-full max-w-[42rem]">
          <label htmlFor="chat-search" className="sr-only">
            Search chats
          </label>
          <div
            className="flex h-11 items-center gap-2.5 rounded-xl border px-3.5"
            style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
          >
            <SearchIcon />
            <input
              id="chat-search"
              type="search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              className="min-w-0 flex-1 bg-transparent text-sm leading-5 outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06]"
                style={{ color: "var(--shell-muted)" }}
              >
                <CloseIcon />
              </button>
            )}
          </div>

          {groups.length > 0 ? (
            <div className="mt-7 space-y-7">
              {groups.map((group) => (
                <section key={group.label} aria-labelledby={`chat-group-${group.slug}`}>
                  <h2
                    id={`chat-group-${group.slug}`}
                    className="px-2.5 text-xs font-semibold leading-5"
                    style={{ color: "var(--shell-faint)" }}
                  >
                    {group.label}
                  </h2>
                  <ul className="mt-1 space-y-0.5">
                    {group.chats.map((chat, index) => (
                      <ChatHistoryItem
                        key={chat.id}
                        chat={{ id: chat.id, title: chat.title }}
                        active={false}
                        menuPlacement={index >= group.chats.length - 2 ? "above" : "below"}
                        onOpen={() => undefined}
                        onChanged={() => router.refresh()}
                        onDeleted={() => router.refresh()}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center">
              <p className="text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
                {query ? "No chats match your search." : "No chats yet."}
              </p>
              {!query && (
                <Link href="/" className="mt-3 inline-block text-sm underline underline-offset-4">
                  Start a new chat
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function groupChats(chats: ConversationHistoryEntry[], referenceDate: string) {
  const reference = startOfUtcDay(referenceDate);
  const definitions = [
    { label: "Today", slug: "today", minimum: 0, maximum: 0 },
    { label: "Yesterday", slug: "yesterday", minimum: 1, maximum: 1 },
    { label: "Previous 7 days", slug: "previous-7-days", minimum: 2, maximum: 7 },
    { label: "Previous 30 days", slug: "previous-30-days", minimum: 8, maximum: 30 },
    { label: "Older", slug: "older", minimum: 31, maximum: Number.POSITIVE_INFINITY },
  ];

  return definitions
    .map((definition) => ({
      ...definition,
      chats: chats.filter((chat) => {
        const age = Math.max(0, Math.floor((reference - startOfUtcDay(chat.updatedAt)) / 86_400_000));
        return age >= definition.minimum && age <= definition.maximum;
      }),
    }))
    .filter((group) => group.chats.length > 0);
}

function startOfUtcDay(value: string): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function SearchIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: "var(--shell-muted)" }}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4 4" strokeLinecap="round" />
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

function CloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m7 7 10 10M17 7 7 17" strokeLinecap="round" />
    </svg>
  );
}

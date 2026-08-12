"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  archiveConversationAction,
  permanentlyDeleteConversationAction,
  previewConversationDeletionAction,
  restoreConversationAction,
  type ConversationDeletionPreview,
} from "@/app/actions";
import type { ResourceId } from "@/core/contracts";

export type ConversationHistoryEntry = {
  id: ResourceId;
  title: string;
  updatedAt: string;
  excerpt: string | null;
};

type ConversationView = "active" | "hidden";

export function ConversationHistory({
  chats,
  referenceDate,
  query,
  view,
  counts,
}: {
  chats: ConversationHistoryEntry[];
  referenceDate: string;
  query: string;
  view: ConversationView;
  counts: { active: number; archived: number };
}) {
  const groups = groupChats(chats, referenceDate, Boolean(query));
  const hidden = view === "hidden";
  const viewQuery = hidden ? "?view=hidden" : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className="flex h-14 shrink-0 items-center justify-between border-b px-5 lg:px-7"
        style={{ borderColor: "var(--shell-line)" }}
      >
        <h1 className="text-base font-semibold leading-6">
          {hidden ? "Hidden chats" : "Chats"}
        </h1>
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
          <nav
            aria-label="Chat history views"
            className="mb-5 flex items-center gap-1 rounded-xl border p-1"
            style={{ borderColor: "var(--shell-line)", background: "var(--shell-panel)" }}
          >
            <HistoryTab
              href="/conversations"
              label="Chats"
              count={counts.active}
              active={!hidden}
            />
            <HistoryTab
              href="/conversations?view=hidden"
              label="Hidden chats"
              count={counts.archived}
              active={hidden}
            />
          </nav>

          <form action="/conversations" method="get" className="flex items-center gap-2">
            {hidden && <input type="hidden" name="view" value="hidden" />}
            <label htmlFor="chat-search" className="sr-only">
              Search all chat messages
            </label>
            <div
              className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border px-3.5"
              style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
            >
              <SearchIcon />
              <input
                id="chat-search"
                name="q"
                type="search"
                autoComplete="off"
                defaultValue={query}
                placeholder="Search all chat messages"
                className="min-w-0 flex-1 bg-transparent text-sm leading-5 outline-none"
              />
              {query && (
                <Link
                  href={`/conversations${viewQuery}`}
                  aria-label="Clear search"
                  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06]"
                  style={{ color: "var(--shell-muted)" }}
                >
                  <CloseIcon />
                </Link>
              )}
            </div>
            <button
              type="submit"
              className="h-11 rounded-xl border px-3.5 text-sm font-medium hover:bg-white/[0.06]"
              style={{ borderColor: "var(--shell-line-strong)" }}
            >
              Search
            </button>
          </form>

          {hidden && !query && counts.archived > 0 && (
            <p className="mt-3 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
              Hidden chats stay stored and can still support remembered details. Restore one to
              return it to your chat list.
            </p>
          )}

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
                  <ul className="mt-1 space-y-1">
                    {group.chats.map((chat) => (
                      <ConversationRow key={chat.id} chat={chat} view={view} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <EmptyHistory query={query} hidden={hidden} />
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationRow({
  chat,
  view,
}: {
  chat: ConversationHistoryEntry;
  view: ConversationView;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<ConversationDeletionPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archive(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await archiveConversationAction(chat.id);
      router.refresh();
    } catch {
      setError("That chat could not be archived. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function restore(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await restoreConversationAction(chat.id);
      router.refresh();
    } catch {
      setError("That chat could not be restored. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function preparePermanentDeletion(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const nextPreview = await previewConversationDeletionAction(chat.id);
      if (!nextPreview) {
        setError("This chat is no longer available.");
        router.refresh();
        return;
      }
      setPreview(nextPreview);
      setMenuOpen(false);
    } catch {
      setError("The deletion preview is unavailable. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function deletePermanently(): Promise<void> {
    if (!preview || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await permanentlyDeleteConversationAction(
        preview.conversationId,
        preview.confirmationKey,
      );
      if (result.status === "deleted") {
        setPreview(null);
        router.refresh();
        return;
      }
      if (result.status === "changed") {
        setPreview(result.preview);
        setError("The affected data changed. Review the updated impact, then confirm again.");
        return;
      }
      setPreview(null);
      setError("This chat is no longer available.");
      router.refresh();
    } catch {
      setError("That chat could not be deleted. No additional data was removed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <li
      className="relative rounded-xl border"
      style={{ borderColor: "var(--shell-line)", background: "var(--shell-panel)" }}
    >
      <div className="flex min-w-0 items-start gap-2 px-2 py-1.5">
        <Link
          href={`/?conversation=${encodeURIComponent(chat.id)}`}
          className="min-w-0 flex-1 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.05]"
        >
          <span className="block truncate text-sm leading-5">{chat.title}</span>
          {chat.excerpt && (
            <span
              className="mt-1 block line-clamp-2 text-xs leading-5"
              style={{ color: "var(--shell-faint)" }}
            >
              {chat.excerpt}
            </span>
          )}
        </Link>
        <button
          type="button"
          aria-label={`Chat options for ${chat.title}`}
          aria-expanded={menuOpen}
          disabled={pending}
          onClick={() => {
            setMenuOpen((current) => !current);
            setPreview(null);
            setError(null);
          }}
          className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/[0.07] disabled:opacity-50"
          style={{ color: "var(--shell-muted)" }}
        >
          <MoreIcon />
        </button>
      </div>

      {menuOpen && (
        <div
          className="absolute right-2 top-11 z-20 w-56 rounded-xl border p-1.5 shadow-2xl"
          style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)" }}
        >
          <button
            type="button"
            disabled={pending}
            onClick={() => void (view === "hidden" ? restore() : archive())}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-white/[0.07] disabled:opacity-50"
          >
            {view === "hidden" ? <RestoreIcon /> : <ArchiveIcon />}
            {view === "hidden" ? "Restore" : "Archive"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void preparePermanentDeletion()}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-white/[0.07] disabled:opacity-50"
            style={{ color: "#ff6767" }}
          >
            <TrashIcon />
            Delete permanently…
          </button>
        </div>
      )}

      {preview && (
        <DeletionPreview
          preview={preview}
          pending={pending}
          error={error}
          onCancel={() => {
            setPreview(null);
            setError(null);
          }}
          onConfirm={() => void deletePermanently()}
        />
      )}
      {!preview && error && (
        <p className="border-t px-4 py-3 text-xs" style={{ borderColor: "var(--shell-line)", color: "#ff8b8b" }}>
          {error}
        </p>
      )}
    </li>
  );
}

function DeletionPreview({
  preview,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  preview: ConversationDeletionPreview;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { impact } = preview;
  return (
    <section
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={`deletion-title-${preview.conversationId}`}
      aria-describedby={`deletion-description-${preview.conversationId}`}
      className="border-t px-4 py-4"
      style={{ borderColor: "var(--shell-line)" }}
    >
      <h3 id={`deletion-title-${preview.conversationId}`} className="text-sm font-medium leading-5">Delete this conversation permanently?</h3>
      <p id={`deletion-description-${preview.conversationId}`} className="mt-1 text-xs leading-5" style={{ color: "var(--shell-muted)" }}>
        This cannot be undone. Shared remembered details stay when another source supports them.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs leading-5">
        <ImpactRow value={impact.messages} label="messages will be deleted" />
        <ImpactRow value={impact.removedMemories} label="saved details will be removed" />
        <ImpactRow
          value={impact.retainedSharedMemories}
          label="shared saved details will stay"
        />
        <ImpactRow value={impact.affectedPlans} label="plans are affected" />
        <ImpactRow
          value={impact.affectedAuditRecords}
          label="supporting history records are affected"
        />
      </dl>
      {error && <p role="alert" className="mt-3 text-xs text-[#ff8b8b]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          autoFocus
          disabled={pending}
          onClick={onCancel}
          className="h-9 rounded-lg px-3 text-sm hover:bg-white/[0.06] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="h-9 rounded-lg px-3 text-sm font-medium disabled:opacity-50"
          style={{ background: "#7f1d1d", color: "#ffffff" }}
        >
          {pending ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </section>
  );
}

function ImpactRow({ value, label }: { value: number; label: string }) {
  return (
    <>
      <dt className="font-semibold tabular-nums">{value}</dt>
      <dd style={{ color: "var(--shell-muted)" }}>{label}</dd>
    </>
  );
}

function HistoryTab({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm transition-colors hover:bg-white/[0.05]"
      style={{
        background: active ? "var(--shell-elevated)" : undefined,
        color: active ? "var(--shell-fg)" : "var(--shell-muted)",
      }}
    >
      {label}
      <span className="text-xs tabular-nums" style={{ color: "var(--shell-faint)" }}>
        {count}
      </span>
    </Link>
  );
}

function EmptyHistory({ query, hidden }: { query: string; hidden: boolean }) {
  return (
    <div className="py-16 text-center">
      <p className="text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
        {query
          ? `No ${hidden ? "hidden " : ""}chats match your search.`
          : hidden
            ? "No hidden chats."
            : "No chats yet."}
      </p>
      {!query && !hidden && (
        <Link href="/" className="mt-3 inline-block text-sm underline underline-offset-4">
          Start a new chat
        </Link>
      )}
    </div>
  );
}

function groupChats(
  chats: ConversationHistoryEntry[],
  referenceDate: string,
  searching: boolean,
) {
  if (searching) return chats.length > 0 ? [{ label: "Results", slug: "results", chats }] : [];
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
        const age = Math.max(
          0,
          Math.floor((reference - startOfUtcDay(chat.updatedAt)) / 86_400_000),
        );
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

function MoreIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M6 7v12h12V7M9 11h6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 4h14v3H5z" strokeLinejoin="round" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 8v5h5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 12a6.5 6.5 0 1 0 1.8-4.5L5 10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AuthTrigger } from "@/components/auth-trigger";
import { setOnboardingStatusAction } from "@/app/experience-actions";
import {
  CHAT_UPDATED_EVENT,
  NEW_CHAT_EVENT,
  type ChatUpdatedDetail,
} from "@/components/chat-events";
import type {
  ChatMode,
  MemoryActivityItem,
  MemoryJobView,
  OnboardingStatus,
  ResourceId,
} from "@/core/contracts";
import type { ChatHydrationTurn } from "@/core/chat-hydration";

export type ChatHistoryTurn = ChatHydrationTurn;

type Turn = ChatHistoryTurn & {
  responseId?: ResourceId | null;
  recalled?: number;
  memory?: MemoryJobView;
  memoryJobId?: ResourceId | null;
  memoryError?: string | null;
};

type Status = "idle" | "streaming" | "error";

export type ChatAccessMode = "durable" | "guest" | "blocked";

export function Chat({
  hasCredentials,
  accessMode,
  showAuthActions,
  initialPrompt,
  initialTurns = [],
  initialConversationId,
  onboardingStatus = "complete",
}: {
  hasCredentials: boolean;
  accessMode: ChatAccessMode;
  showAuthActions: boolean;
  initialPrompt?: string;
  initialTurns?: ChatHistoryTurn[];
  initialConversationId?: ResourceId;
  onboardingStatus?: OnboardingStatus;
}) {
  const durable = accessMode === "durable";
  const guest = accessMode === "guest";
  const canUseChat = accessMode !== "blocked";
  const [turns, setTurns] = useState<Turn[]>(durable ? initialTurns : []);
  const [input, setInput] = useState(initialPrompt ?? "");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>(
    durable ? "standard" : "temporary",
  );
  const [showWelcome, setShowWelcome] = useState(
    durable && onboardingStatus === "welcome" && initialTurns.length === 0,
  );
  const [onboarding, setOnboarding] = useState<OnboardingStatus>(onboardingStatus);
  const conversationId = useRef<ResourceId | null>(initialConversationId ?? null);
  const activeRequest = useRef<AbortController | null>(null);
  const activeReplyId = useRef<string | null>(null);
  const backgroundRequests = useRef(new Set<AbortController>());
  const polledJobIds = useRef(new Set<ResourceId>());
  const shouldFollowOutput = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const memoryRequests = backgroundRequests.current;
    function startNewChat() {
      activeRequest.current?.abort();
      for (const request of memoryRequests) request.abort();
      memoryRequests.clear();
      activeRequest.current = null;
      activeReplyId.current = null;
      conversationId.current = null;
      setTurns([]);
      setInput("");
      setMode(durable ? "standard" : "temporary");
      setStatus("idle");
      setError(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    window.addEventListener(NEW_CHAT_EVENT, startNewChat);
    return () => {
      window.removeEventListener(NEW_CHAT_EVENT, startNewChat);
      activeRequest.current?.abort();
      activeRequest.current = null;
      for (const request of memoryRequests) request.abort();
      memoryRequests.clear();
    };
  }, [durable]);

  useEffect(() => {
    if (turns.length > 0 && shouldFollowOutput.current) {
      endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [turns]);

  function chooseStarter(prompt: string) {
    setShowWelcome(false);
    if (onboarding === "welcome") updateOnboarding("first_chat");
    setInput(prompt);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      resizeComposer(textareaRef.current);
      textareaRef.current.focus();
    });
  }

  const updateOnboarding = useCallback((next: OnboardingStatus) => {
    if (
      !durable ||
      onboarding === next ||
      onboardingRank(next) <= onboardingRank(onboarding)
    ) return;
    setOnboarding(next);
    const formData = new FormData();
    formData.set("status", next);
    void setOnboardingStatusAction(formData).catch(() => undefined);
  }, [durable, onboarding]);

  function selectMode(next: ChatMode) {
    if (!durable || next === mode || status === "streaming") return;
    activeRequest.current?.abort();
    activeRequest.current = null;
    activeReplyId.current = null;
    for (const request of backgroundRequests.current) request.abort();
    backgroundRequests.current.clear();
    conversationId.current = null;
    setMode(next);
    setTurns([]);
    setError(null);
    setStatus("idle");
  }

  function stop() {
    const replyId = activeReplyId.current;
    activeRequest.current?.abort();
    activeRequest.current = null;
    activeReplyId.current = null;
    if (replyId) {
      // A stopped partial response is never stored by the server. Remove only that
      // unsaved bubble so the visible transcript remains identical after refresh.
      setTurns((current) => current.filter((turn) => turn.id !== replyId));
    }
    setStatus("idle");
    setError(null);
  }

  async function retry(assistantIndex?: number) {
    const searchBefore = assistantIndex === undefined
      ? turns
      : turns.slice(0, assistantIndex);
    const sourceUser = [...searchBefore].reverse().find((turn) => turn.role === "user");
    if (!sourceUser || status === "streaming") return;
    // A retry is a new visible attempt. Keeping both attempts prevents the browser
    // from hiding transcript rows that remain durably stored on refresh.
    await send(sourceUser.text);
  }

  async function send(forcedText?: string, historyOverride?: Turn[]) {
    const text = (forcedText ?? input).trim();
    if (!text || status === "streaming" || !hasCredentials || !canUseChat) return;

    setShowWelcome(false);
    const priorTurns = historyOverride ?? turns;
    const replyId = crypto.randomUUID();
    const userTurn: Turn = { id: crypto.randomUUID(), role: "user", text };
    setTurns([...priorTurns, userTurn, { id: replyId, role: "assistant", text: "" }]);
    setInput("");
    setError(null);
    setStatus("streaming");
    activeReplyId.current = replyId;
    shouldFollowOutput.current = true;
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const request = new AbortController();
    activeRequest.current = request;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          mode,
          ...(mode === "standard"
            ? { conversationId: conversationId.current }
            : { temporaryHistory: boundedBrowserHistory(priorTurns) }),
        }),
        signal: request.signal,
      });
      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(chatRequestError(response.status, detail?.error));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "conversation" && typeof event.conversationId === "string") {
            conversationId.current = event.conversationId;
            window.dispatchEvent(
              new CustomEvent<ChatUpdatedDetail>(CHAT_UPDATED_EVENT, {
                detail: { conversationId: event.conversationId },
              }),
            );
          } else if (event.type === "text_delta" && typeof event.text === "string") {
            setTurns((current) => current.map((turn) =>
              turn.id === replyId ? { ...turn, text: turn.text + event.text } : turn,
            ));
          } else if (event.type === "response_complete") {
            const responseId = typeof event.responseId === "string" ? event.responseId : null;
            const memoryJobId = typeof event.memoryJobId === "string" ? event.memoryJobId : null;
            const recalled = typeof event.recalled === "number" ? event.recalled : 0;
            const memoryError = typeof event.memoryError === "string" ? event.memoryError : null;
            setTurns((current) => current.map((turn) =>
              turn.id === replyId
                ? { ...turn, responseId, memoryJobId, recalled, memoryError }
                : turn,
            ));
            setStatus("idle");
            if (memoryJobId) {
              startMemoryPoll(replyId, memoryJobId);
            }
          } else if (event.type === "error") {
            throw new Error(typeof event.message === "string" ? event.message : "Something went wrong.");
          }
        }
      }
      if (!request.signal.aborted) setStatus("idle");
    } catch (caught) {
      if (request.signal.aborted) {
        setTurns((current) => current.filter((turn) => turn.id !== replyId));
        return;
      }
      setTurns((current) => current.filter((turn) => turn.id !== replyId));
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      setStatus("error");
    } finally {
      if (activeRequest.current === request) activeRequest.current = null;
      if (activeReplyId.current === replyId) activeReplyId.current = null;
    }
  }

  const pollMemoryJob = useCallback(async (
    turnId: string,
    jobId: ResourceId,
    signal: AbortSignal,
  ) => {
    for (let attempt = 0; attempt < 120 && !signal.aborted; attempt += 1) {
      if (attempt > 0) await delay(Math.min(1_000 + attempt * 250, 4_000), signal);
      if (signal.aborted) return;
      try {
        const response = await fetch(`/api/memory-jobs/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw new Error("Memory status is unavailable.");
        const body = (await response.json()) as { job: MemoryJobView | null };
        if (!body.job) throw new Error("Memory status is unavailable.");
        setTurns((current) => current.map((turn) =>
          turn.id === turnId ? { ...turn, memory: body.job ?? undefined } : turn,
        ));
        if (body.job.status === "completed" || body.job.status === "failed") {
          if (body.job.items.length > 0 && onboarding !== "complete") {
            updateOnboarding("complete");
          }
          if (conversationId.current) {
            window.dispatchEvent(
              new CustomEvent<ChatUpdatedDetail>(CHAT_UPDATED_EVENT, {
                detail: { conversationId: conversationId.current },
              }),
            );
          }
          return;
        }
      } catch (caught) {
        if (signal.aborted) return;
        setTurns((current) => current.map((turn) =>
          turn.id === turnId
            ? { ...turn, memoryError: caught instanceof Error ? caught.message : "Memory status is unavailable." }
            : turn,
        ));
        return;
      }
    }
  }, [onboarding, updateOnboarding]);

  const startMemoryPoll = useCallback((turnId: string, jobId: ResourceId) => {
    if (polledJobIds.current.has(jobId)) return;
    polledJobIds.current.add(jobId);
    const memoryRequest = new AbortController();
    backgroundRequests.current.add(memoryRequest);
    void pollMemoryJob(turnId, jobId, memoryRequest.signal).finally(() => {
      backgroundRequests.current.delete(memoryRequest);
    });
  }, [pollMemoryJob]);

  useEffect(() => {
    for (const turn of initialTurns as Turn[]) {
      if (
        turn.role === "assistant" &&
        turn.memoryJobId &&
        (!turn.memory || turn.memory.status === "pending" || turn.memory.status === "running")
      ) {
        startMemoryPoll(turn.id, turn.memoryJobId);
      }
    }
  }, [initialTurns, startMemoryPoll]);

  async function undoMemory(turnId: string, jobId: ResourceId) {
    try {
      const response = await fetch(`/api/memory-jobs/${encodeURIComponent(jobId)}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as { job?: MemoryJobView; error?: string } | null;
      if (body?.job) {
        setTurns((current) => current.map((turn) =>
          turn.id === turnId ? { ...turn, memory: body.job, memoryError: null } : turn,
        ));
      }
      if (!response.ok || !body?.job) {
        throw new Error(body?.error ?? "That save cannot be undone safely.");
      }
    } catch (caught) {
      setTurns((current) => current.map((turn) =>
        turn.id === turnId
          ? { ...turn, memoryError: caught instanceof Error ? caught.message : "That save cannot be undone safely." }
          : turn,
      ));
    }
  }

  const hasVisibleTurns = turns.length > 0;
  const canSend = Boolean(input.trim()) && status !== "streaming" && hasCredentials && canUseChat;
  const composer = (
    <Composer
      input={input}
      onInputChange={setInput}
      onSend={() => send()}
      onStop={stop}
      onModeChange={selectMode}
      textareaRef={textareaRef}
      status={status}
      canSend={canSend}
      hasCredentials={hasCredentials}
      canUseChat={canUseChat}
      centered={!hasVisibleTurns}
      mode={mode}
      accessMode={accessMode}
    />
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: "var(--shell-bg)" }}>
      {showAuthActions && <GuestAuthActions />}
      {!hasVisibleTurns ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
          <div className="mx-auto flex min-h-full w-full max-w-[48rem] flex-col justify-center pb-[16vh] pt-20">
            {canUseChat && !hasCredentials && <AvailabilityNotice guest={guest} />}
            {showWelcome
              ? <Welcome onChoose={chooseStarter} onSkip={() => { setShowWelcome(false); updateOnboarding("complete"); }} />
              : <EmptyState accessMode={accessMode} mode={mode} onChoose={chooseStarter} />}
            {composer}
          </div>
        </div>
      ) : (
        <>
          <div
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(event) => {
              const element = event.currentTarget;
              shouldFollowOutput.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 120;
            }}
          >
            <div className={`mx-auto flex min-h-full w-full max-w-[48rem] flex-col px-4 pb-8 md:px-6 ${showAuthActions ? "pt-16" : "pt-6"}`}>
              {durable && mode === "temporary" && <TemporaryBanner />}
              {canUseChat && !hasCredentials && <AvailabilityNotice guest={guest} />}
              <ol className="space-y-8 py-4">
                {turns.map((turn, index) => (
                  <li key={turn.id}>
                    {turn.role === "user" ? (
                      <UserTurn text={turn.text} />
                    ) : (
                      <AssistantTurn
                        turn={turn}
                        pending={status === "streaming" && index === turns.length - 1}
                        onRetry={() => void retry(index)}
                        onUndo={() => turn.memoryJobId && void undoMemory(turn.id, turn.memoryJobId)}
                        temporary={mode === "temporary"}
                      />
                    )}
                  </li>
                ))}
              </ol>
              {error && <ErrorNotice message={error} onRetry={() => void retry()} />}
              <div ref={endRef} />
            </div>
          </div>
          {composer}
        </>
      )}
    </div>
  );
}

function Composer({
  input,
  onInputChange,
  onSend,
  onStop,
  onModeChange,
  textareaRef,
  status,
  canSend,
  hasCredentials,
  canUseChat,
  centered,
  mode,
  accessMode,
}: {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  onStop: () => void;
  onModeChange: (mode: ChatMode) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  status: Status;
  canSend: boolean;
  hasCredentials: boolean;
  canUseChat: boolean;
  centered: boolean;
  mode: ChatMode;
  accessMode: ChatAccessMode;
}) {
  const durable = accessMode === "durable";
  const guest = accessMode === "guest";

  return (
    <form
      onSubmit={(event) => { event.preventDefault(); void onSend(); }}
      className={centered ? "mt-7 w-full" : "shrink-0 px-3 pt-3 [padding-bottom:max(0.5rem,env(safe-area-inset-bottom))] md:px-5"}
      style={{ background: "var(--shell-bg)" }}
    >
      <div className="mx-auto w-full max-w-[48rem]">
        {durable && (
          <div className="mb-2 flex items-center justify-between gap-3 px-1 text-xs" style={{ color: "var(--shell-faint)" }}>
            <button
              type="button"
              disabled={status === "streaming"}
              onClick={() => onModeChange(mode === "temporary" ? "standard" : "temporary")}
              aria-pressed={mode === "temporary"}
              className="rounded-full border px-3 py-1.5 disabled:opacity-50"
              style={{ borderColor: mode === "temporary" ? "var(--shell-accent)" : "var(--shell-line-strong)", color: mode === "temporary" ? "var(--shell-accent)" : undefined }}
            >
              {mode === "temporary" ? "Temporary chat on" : "Temporary chat"}
            </button>
            {mode === "temporary" && <span>Nothing from this chat is saved</span>}
          </div>
        )}
        {guest && (
          <p className="mb-2 px-1 text-xs" style={{ color: "var(--shell-faint)" }}>
            This chat isn’t saved. Context lasts until you refresh or leave.
          </p>
        )}
        <div className="flex items-end gap-2 rounded-[26px] border px-3 py-2" style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}>
          <label htmlFor="chat-input" className="sr-only">Message Zeus</label>
          <textarea
            ref={textareaRef}
            id="chat-input"
            rows={1}
            value={input}
            disabled={!hasCredentials || !canUseChat}
            autoFocus={centered && hasCredentials && canUseChat}
            onChange={(event) => onInputChange(event.target.value)}
            onInput={(event) => resizeComposer(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSend();
              }
            }}
            placeholder="Message Zeus"
            className="max-h-[200px] min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-[0.95rem] leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: "var(--shell-fg)" }}
          />
          {status === "streaming" ? (
            <button type="button" onClick={onStop} aria-label="Stop response" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: "var(--shell-elevated)" }}>
              <span aria-hidden className="h-3 w-3 rounded-[2px]" style={{ background: "var(--shell-fg)" }} />
            </button>
          ) : (
            <button type="submit" disabled={!canSend} aria-label="Send message" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed" style={{ background: canSend ? "var(--shell-accent)" : "var(--shell-elevated)", color: canSend ? "#000" : "var(--shell-faint)" }}>
              <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 19V5m0 0-5 5m5-5 5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function AssistantTurn({ turn, pending, onRetry, onUndo, temporary }: { turn: Turn; pending: boolean; onRetry: () => void; onUndo: () => void; temporary: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(turn.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex gap-4">
      <AssistantMark />
      <div className="min-w-0 flex-1 pt-0.5">
        <div aria-live="polite" aria-busy={pending}>
          {turn.text ? <Markdown text={turn.text} /> : pending && <ThinkingIndicator />}
        </div>
        {turn.text && !pending && (
          <div className="mt-2 flex items-center gap-4 text-xs" style={{ color: "var(--shell-faint)" }}>
            <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        )}
        {!temporary && (
          <ActivityReceipt
            turn={turn}
            onUndo={onUndo}
          />
        )}
      </div>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown text-[0.95rem] leading-7" style={{ color: "var(--shell-fg)" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={safeHref(href)} rel="noreferrer" target="_blank" className="underline underline-offset-4">{children}</a>,
          p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
          pre: ({ children }) => <pre className="my-4 overflow-x-auto rounded-xl border p-4 text-sm" style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}>{children}</pre>,
          code: ({ children }) => <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[0.88em]">{children}</code>,
          blockquote: ({ children }) => <blockquote className="my-4 border-l-2 pl-4" style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}>{children}</blockquote>,
          img: () => null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ActivityReceipt({ turn, onUndo }: { turn: Turn; onUndo: () => void }) {
  const job = turn.memory;
  const used = turn.recalled ?? 0;
  const saved = job?.items.filter((item) => item.change === "saved" || item.change === "updated") ?? [];
  const review = job?.items.filter((item) => item.change === "needs_review") ?? [];
  const hasSavedPlans = saved.some((item) => item.kind === "plan");
  const hasSavedMemory = saved.some((item) => item.kind !== "plan");
  const hasSummary = used > 0 || saved.length > 0 || review.length > 0;
  if (!turn.responseId && !turn.memoryJobId && !turn.memoryError && !hasSummary) return null;
  return (
    <div aria-live="polite" className="mt-3 text-xs" style={{ color: "var(--shell-faint)" }}>
      {hasSummary && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {used > 0 && <span>Used {used} remembered {plural(used, "detail")}</span>}
          {saved.length > 0 && <span>Saved {saved.length} {plural(saved.length, "detail")}</span>}
          {review.length > 0 && <Link href="/about-you?view=review" className="underline underline-offset-3">{review.length} needs review</Link>}
        </div>
      )}
      {job && (job.status === "pending" || job.status === "running") && (
        <p role="status" className="mt-2">Checking what may be worth remembering…</p>
      )}
      {job?.status === "completed" && job.items.length > 0 && (
        <details open className="mt-2 rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--shell-line)" }}>
          <summary className="cursor-pointer font-medium" style={{ color: "var(--shell-muted)" }}>Memory updated</summary>
          <ul className="mt-2 space-y-1.5">
            {job.items.map((item) => <MemoryChange key={`${item.id}:${item.change}`} item={item} />)}
          </ul>
          <div className="mt-3 flex flex-wrap gap-4">
            {job.canUndo && !job.undone && <button type="button" onClick={onUndo} className="underline underline-offset-3">Undo last save</button>}
            {!job.canUndo && hasSavedMemory && <Link href="/about-you" className="underline underline-offset-3">Review or correct details</Link>}
            {!job.canUndo && hasSavedPlans && <Link href="/today#plans" className="underline underline-offset-3">Review plans</Link>}
            {job.undone && <span>Save undone</span>}
          </div>
        </details>
      )}
      {(turn.memoryError || job?.status === "failed") && <p role="status" className="mt-2" style={{ color: "#ff9b9b" }}>{turn.memoryError ?? job?.error ?? "Memory could not be updated."}</p>}
      {turn.responseId && <Link href={`/response/${turn.responseId}`} className="mt-2 inline-block underline underline-offset-3">Why Zeus said this</Link>}
    </div>
  );
}

function MemoryChange({ item }: { item: MemoryActivityItem }) {
  const prefix = item.change === "needs_review" ? "Review" : item.change === "updated" ? "Updated" : "Saved";
  const href = item.change === "needs_review"
    ? `/about-you?view=review#${item.id}`
    : item.kind === "plan"
      ? `/today#${item.id}`
      : `/about-you#${item.id}`;
  return <li><span className="font-medium" style={{ color: "var(--shell-muted)" }}>{prefix}:</span>{" "}<Link href={href} className="underline decoration-transparent underline-offset-3 hover:decoration-current">{item.label}</Link></li>;
}

function Welcome({ onChoose, onSkip }: { onChoose: (prompt: string) => void; onSkip: () => void }) {
  return (
    <section className="mx-auto w-full max-w-[40rem] text-center" aria-labelledby="welcome-heading">
      <p className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color: "var(--shell-accent)" }}>Welcome to Zeus</p>
      <h1 id="welcome-heading" className="mt-3 text-3xl font-semibold tracking-tight">Help that remembers—with you in control.</h1>
      <p className="mx-auto mt-4 max-w-[36rem] text-sm leading-6" style={{ color: "var(--shell-muted)" }}>
        Zeus can remember clear, non-sensitive details, help you follow through, and always show why. You can review, correct, remove, or turn remembering off at any time.
      </p>
      <p className="mt-3 text-xs" style={{ color: "var(--shell-faint)" }}>Helpful suggestions are on by default. Zeus offers at most one at a time.</p>
      <StarterButtons onChoose={onChoose} />
      <button type="button" onClick={onSkip} className="mt-5 text-sm underline underline-offset-4" style={{ color: "var(--shell-faint)" }}>Skip introduction</button>
    </section>
  );
}

function EmptyState({
  accessMode,
  mode,
  onChoose,
}: {
  accessMode: ChatAccessMode;
  mode: ChatMode;
  onChoose: (prompt: string) => void;
}) {
  const signedInTemporary = accessMode === "durable" && mode === "temporary";
  const showStarters = accessMode !== "blocked" && !signedInTemporary;

  return (
    <div className="w-full text-center">
      <h1 className="text-[1.8rem] font-semibold leading-tight tracking-[-0.025em]">
        {signedInTemporary ? "Temporary chat" : "What can I help with?"}
      </h1>
      {signedInTemporary ? (
        <p className="mt-3 text-sm" style={{ color: "var(--shell-muted)" }}>
          No saved memory is read. This conversation disappears when you refresh or leave.
        </p>
      ) : showStarters ? (
        <StarterButtons guest={accessMode === "guest"} onChoose={onChoose} />
      ) : null}
    </div>
  );
}

function StarterButtons({
  guest = false,
  onChoose,
}: {
  guest?: boolean;
  onChoose: (prompt: string) => void;
}) {
  const starters = guest
    ? ["Help me think through something", "Draft something with me", "Explain something clearly"]
    : ["Help me think through something", "Remember what I’m working on", "Show me how memory works"];
  return <div className="mt-6 flex flex-wrap justify-center gap-2">{starters.map((starter) => <button type="button" key={starter} onClick={() => onChoose(starter)} className="rounded-full border px-3.5 py-2 text-sm hover:bg-white/[0.05]" style={{ borderColor: "var(--shell-line-strong)" }}>{starter}</button>)}</div>;
}

function TemporaryBanner() {
  return <p role="status" className="mt-3 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}>Temporary chat: no saved memory is read, and this conversation is not stored.</p>;
}

function UserTurn({ text }: { text: string }) {
  return <div className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap rounded-[20px] px-4 py-2.5 text-[0.95rem] leading-6" style={{ background: "var(--shell-elevated)", color: "var(--shell-fg)" }}>{text}</p></div>;
}

function AssistantMark() {
  return <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[0.68rem] font-bold" style={{ background: "var(--shell-accent)", color: "#000" }}>Z</span>;
}

function ThinkingIndicator() {
  return <span role="status" aria-label="Thinking" className="inline-flex h-7 items-center gap-1.5">{[0, 150, 300].map((delayMs) => <span key={delayMs} aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "var(--shell-muted)", animationDelay: `${delayMs}ms` }} />)}</span>;
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="mt-5 flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-sm" style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}><span>{message}</span><button type="button" onClick={onRetry} className="shrink-0 underline underline-offset-3">Retry</button></div>;
}

function AvailabilityNotice({ guest }: { guest: boolean }) {
  return <div role="status" className="mb-4 rounded-2xl border px-5 py-4" style={{ borderColor: "var(--shell-line-strong)", background: "var(--shell-panel)" }}><p className="text-sm font-medium">Chat is temporarily unavailable</p><p className="mt-1 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>{guest ? "Try again later." : "Saved details and data controls are still available."}</p></div>;
}

function GuestAuthActions() {
  return <nav aria-label="Account access" className="absolute right-0 top-0 z-10 flex h-16 items-center gap-2 px-4 sm:px-5"><AuthTrigger intent="login" className="flex h-9 items-center rounded-full px-4 text-sm font-medium" style={{ background: "var(--shell-accent)", color: "#000" }}>Log in</AuthTrigger><AuthTrigger intent="signup" className="flex h-9 items-center rounded-full border px-4 text-sm font-medium" style={{ borderColor: "var(--shell-line-strong)" }}>Sign up</AuthTrigger></nav>;
}

function resizeComposer(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
}

function boundedBrowserHistory(turns: readonly Turn[]): Array<{ role: "user" | "assistant"; content: string }> {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let remaining = 20_000;
  for (const turn of turns.slice(-20).reverse()) {
    const content = turn.text.trim().slice(0, 4_000);
    if (!content || remaining === 0) continue;
    const bounded = content.slice(0, remaining);
    history.unshift({ role: turn.role, content: bounded });
    remaining -= bounded.length;
  }
  return history;
}

function safeHref(value: string | undefined): string {
  if (!value) return "#";
  if (value.startsWith("/") || value.startsWith("#")) return value;
  try {
    const url = new URL(value, "https://zeus.invalid");
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? value : "#";
  } catch {
    return "#";
  }
}

function chatRequestError(status: number, detail?: string): string {
  if (status === 401) return "Log in to continue.";
  if (status === 403) return "This chat is not available for this account.";
  if (status === 404) return "That saved chat is no longer available.";
  if (status === 429) return detail || "Chat is busy. Try again shortly.";
  if (status >= 500) return "Zeus is temporarily unavailable. Try again shortly.";
  return "That request could not be completed. Try again.";
}

function onboardingRank(status: OnboardingStatus): number {
  return status === "welcome" ? 0 : status === "first_chat" ? 1 : 2;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}

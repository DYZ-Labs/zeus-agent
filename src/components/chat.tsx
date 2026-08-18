"use client";

import { useEffect, useRef, useState } from "react";

import { AssistantProse } from "@/components/assistant-prose";
import { AuthTrigger } from "@/components/auth-trigger";
import {
  CHAT_UPDATED_EVENT,
  NEW_CHAT_EVENT,
  type ChatUpdatedDetail,
} from "@/components/chat-events";
import { type ChatReceipt } from "@/components/chat-receipt";
import { confirmationSentence } from "@/core/confirmation-text";
import type { CalendarOutcome, FollowThroughRecommendation } from "@/core/schema";

export type ChatHistoryTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * How a calendar request ended, decided deterministically rather than read out of the
   * reply. The chat renders nothing from it — the prose says what happened, and the stored
   * row is what constrains the prose. It is carried here for the one thing prose cannot do:
   * put the exact confirmation line in front of the user when a change is waiting on it.
   */
  calendar?: CalendarOutcome | null;
};

type Turn = ChatHistoryTurn & {
  recommendation?: FollowThroughRecommendation;
  /** Set on the assistant turn once the stream closes. */
  receipt?: ChatReceipt & {
    projectsUpdated: number;
  };
};

type Status = "idle" | "streaming" | "error";

export function Chat({
  hasCredentials,
  canAccessPrivateData,
  showAuthActions,
  initialPrompt,
  initialTurns = [],
  initialConversationId,
  awaitingConfirmation,
}: {
  hasCredentials: boolean;
  canAccessPrivateData: boolean;
  showAuthActions: boolean;
  initialPrompt?: string;
  initialTurns?: ChatHistoryTurn[];
  initialConversationId?: number;
  /**
   * A change still waiting on the user, restored after a reload.
   *
   * The composer line is the only affordance a prose-only chat has for authorizing one, and a
   * refresh used to take it away — leaving a prepared request nothing in the conversation
   * could reach.
   */
  awaitingConfirmation?: { hash: string; count: number } | null;
}) {
  const [turns, setTurns] = useState<Turn[]>(canAccessPrivateData ? initialTurns : []);
  const [input, setInput] = useState(
    initialPrompt ??
      (awaitingConfirmation
        ? confirmationSentence(awaitingConfirmation.hash, awaitingConfirmation.count)
        : ""),
  );
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<number | null>(initialConversationId ?? null);
  const activeRequest = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function startNewChat() {
      activeRequest.current?.abort();
      activeRequest.current = null;
      conversationId.current = null;
      setTurns([]);
      setInput("");
      setStatus("idle");
      setError(null);
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      });
    }

    window.addEventListener(NEW_CHAT_EVENT, startNewChat);
    return () => {
      window.removeEventListener(NEW_CHAT_EVENT, startNewChat);
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, []);

  useEffect(() => {
    if (turns.length === 0) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  async function send() {
    const text = input.trim();
    if (!text || status === "streaming" || !hasCredentials || !canAccessPrivateData) return;

    const replyId = crypto.randomUUID();
    setTurns((prior) => [
      ...prior,
      { id: crypto.randomUUID(), role: "user", text },
      { id: replyId, role: "assistant", text: "" },
    ]);
    setInput("");
    setError(null);
    setStatus("streaming");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const request = new AbortController();
    activeRequest.current = request;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          conversationId: conversationId.current,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        signal: request.signal,
      });

      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Request failed (${response.status})`);
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

          if (event.type === "meta") {
            const nextConversationId = event.conversationId;
            if (typeof nextConversationId === "number") {
              conversationId.current = nextConversationId;
              window.dispatchEvent(
                new CustomEvent<ChatUpdatedDetail>(CHAT_UPDATED_EVENT, {
                  detail: { conversationId: nextConversationId },
                }),
              );
            }
          } else if (event.type === "delta") {
            const chunk = event.text as string;
            setTurns((prior) =>
              prior.map((turn) =>
                turn.id === replyId ? { ...turn, text: turn.text + chunk } : turn,
              ),
            );
          } else if (event.type === "done") {
            const opportunityId = event.opportunityId as number | null;
            const messageId = event.messageId as number;
            const opportunityDelivered = opportunityId === null
              ? true
              : await recordOpportunityDelivery(opportunityId, "chat", messageId);
            setTurns((prior) =>
              prior.map((turn) =>
                turn.id === replyId
                  ? {
                      ...turn,
                      receipt: {
                        messageId,
                        recalled: event.recalled as number,
                        recalledFacts: event.recalledFacts as number,
                        recalledEpisodes: event.recalledEpisodes as number,
                        recalledFacets: event.recalledFacets as number,
                        accepted: event.accepted as number,
                        acceptedFacets: event.acceptedFacets as number,
                        pending: event.pending as number,
                        pendingFacets: event.pendingFacets as number,
                        goalsUpdated: event.goalsUpdated as number,
                        commitmentsUpdated: event.commitmentsUpdated as number,
                        projectsUpdated: event.projectsUpdated as number,
                        superseded: event.superseded as number,
                        failed: event.extractionFailed as boolean,
                      },
                      recommendation:
                        opportunityDelivered
                          ? (event.recommendation as FollowThroughRecommendation | null) ?? undefined
                          : undefined,
                      calendar: (event.calendar as CalendarOutcome | null) ?? null,
                    }
                  : turn,
              ),
            );
            // Whatever is still owed, whether this turn asked for it or three turns ago did.
            // The box is emptied every time the user sends something, so the offer has to be
            // renewed for as long as it stands — the reply is allowed to say the line is
            // there only because this puts it there.
            const offer = event.awaitingConfirmation as
              | { hash: string; count: number }
              | null
              | undefined;
            if (offer) offerConfirmation(offer.hash, offer.count);
          } else if (event.type === "error") {
            throw new Error(event.message as string);
          }
        }
      }

      if (!request.signal.aborted) setStatus("idle");
    } catch (caught) {
      if (request.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
      setStatus("error");
    } finally {
      if (activeRequest.current === request) activeRequest.current = null;
    }
  }

  /**
   * Put the words that authorize a waiting change where the user is already typing.
   *
   * Only into an empty box: whatever they were part-way through writing outranks a
   * suggestion. Nothing is sent until they send it, which is the whole design — the
   * confirmation has to be a message they wrote.
   */
  function offerConfirmation(hash: string, count: number) {
    setInput((current) => (current.trim() ? current : confirmationSentence(hash, count)));
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      resizeComposer(textareaRef.current);
      textareaRef.current.focus();
    });
  }

  const hasVisibleTurns = canAccessPrivateData && turns.length > 0;
  const canSend =
    Boolean(input.trim()) && status !== "streaming" && hasCredentials && canAccessPrivateData;
  const composer = (
    <Composer
      input={input}
      onInputChange={setInput}
      onSend={send}
      textareaRef={textareaRef}
      status={status}
      canSend={canSend}
      hasCredentials={hasCredentials}
      canAccessPrivateData={canAccessPrivateData}
      centered={!hasVisibleTurns}
    />
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      style={{ background: "var(--shell-bg)" }}
    >
      {!hasVisibleTurns && showAuthActions && <AccountAccessActions />}
      {!hasVisibleTurns ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
          <div className="mx-auto flex min-h-full w-full max-w-[48rem] flex-col justify-center pb-[24vh] pt-20 lg:pb-[27vh]">
            {canAccessPrivateData && !hasCredentials && <CredentialsNotice />}
            <EmptyState requiresLogin={!canAccessPrivateData} />
            {composer}
          </div>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div
              className={`mx-auto flex min-h-full w-full max-w-[48rem] flex-col px-4 pb-8 md:px-6 ${
                showAuthActions ? "pt-16" : "pt-6"
              }`}
            >
              {canAccessPrivateData && !hasCredentials && <CredentialsNotice />}
              <ol className="space-y-8 py-4">
                {turns.map((turn) => (
                  <li key={turn.id}>
                    {turn.role === "user" ? (
                      <UserTurn text={turn.text} />
                    ) : (
                      <AssistantTurn
                        text={turn.text}
                        pending={status === "streaming" && !turn.receipt}
                      />
                    )}
                  </li>
                ))}
              </ol>

              {error && (
                <p
                  role="alert"
                  className="mt-5 rounded-xl border px-4 py-3 text-[0.86rem]"
                  style={{
                    background: "var(--shell-panel)",
                    borderColor: "var(--shell-line-strong)",
                    color: "var(--shell-muted)",
                  }}
                >
                  {error}
                </p>
              )}

              <div ref={endRef} />
            </div>
          </div>
          {composer}
        </>
      )}
    </div>
  );
}

async function recordOpportunityDelivery(
  opportunityId: number,
  channel: "chat" | "today",
  responseMessageId: number | null,
): Promise<boolean> {
  try {
    const response = await fetch(`/api/opportunities/${opportunityId}/delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, responseMessageId }),
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function Composer({
  input,
  onInputChange,
  onSend,
  textareaRef,
  status,
  canSend,
  hasCredentials,
  canAccessPrivateData,
  centered,
}: {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  status: Status;
  canSend: boolean;
  hasCredentials: boolean;
  canAccessPrivateData: boolean;
  centered: boolean;
}) {
  const inputLabel = canAccessPrivateData ? "Message Zeus" : "Log in to message Zeus";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSend();
      }}
      className={centered ? "mt-9 w-full" : "shrink-0 px-3 pb-2 pt-3 md:px-5"}
      style={{ background: "var(--shell-bg)" }}
    >
      <div className="mx-auto w-full max-w-[48rem]">
        <div
          className="flex items-end gap-2 rounded-[26px] border px-3 py-2 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]"
          style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
        >
          <label htmlFor="chat-input" className="sr-only">
            {inputLabel}
          </label>
          <textarea
            ref={textareaRef}
            id="chat-input"
            rows={1}
            value={input}
            disabled={!hasCredentials || !canAccessPrivateData}
            autoFocus={centered && hasCredentials && canAccessPrivateData}
            onChange={(event) => onInputChange(event.target.value)}
            onInput={(event) => resizeComposer(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void onSend();
              }
            }}
            placeholder={inputLabel}
            className="max-h-[200px] min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1.5 text-[0.95rem] leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: "var(--shell-fg)", outline: "none" }}
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label={status === "streaming" ? "Response in progress" : "Send message"}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
            style={{
              background: canSend ? "var(--shell-accent)" : "var(--shell-elevated)",
              color: canSend ? "#000000" : "var(--shell-faint)",
            }}
          >
            <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 19V5m0 0-5 5m5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </form>
  );
}

function resizeComposer(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
}

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p
        className="max-w-[85%] whitespace-pre-wrap rounded-[20px] px-4 py-2.5 text-[0.95rem] leading-6"
        style={{ background: "var(--shell-elevated)", color: "var(--shell-fg)" }}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * One reply, and nothing else.
 *
 * The calendar, work-plan and follow-through panels that used to sit here are gone. They were
 * deterministic where the prose is not, which is a real thing to give up — so what replaced
 * them is not trust in the model but a narrower job for it: the same stored `calendar_outcome`
 * that drove the panel is supplied to the model as data it must not contradict, kept for
 * audit, and replayed to later turns. The reply says it in sentences; the record still exists
 * and still governs.
 *
 * What a panel could do and a paragraph cannot is hand the user a button. That one case is
 * handled by putting the exact confirmation line in the composer, where the user sends it
 * themselves — which is the stricter arrangement, not the looser one.
 */
function AssistantTurn({ text, pending }: { text: string; pending: boolean }) {
  return (
    <div className="flex gap-4">
      <AssistantMark />
      <div className="min-w-0 flex-1 pt-0.5">
        {text ? (
          <AssistantProse
            text={text}
            paragraphClassName="text-[0.95rem] leading-7"
            style={{ color: "var(--shell-fg)" }}
          />
        ) : (
          pending && <ThinkingIndicator />
        )}
      </div>
    </div>
  );
}


function AssistantMark() {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[0.68rem] font-bold"
      style={{ background: "var(--shell-accent)", color: "#000000" }}
    >
      Z
    </span>
  );
}

function ThinkingIndicator() {
  return (
    <span role="status" aria-label="Thinking" className="inline-flex h-7 items-center gap-1.5">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          aria-hidden
          className="h-1.5 w-1.5 animate-pulse rounded-full"
          style={{ background: "var(--shell-muted)", animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function EmptyState({ requiresLogin }: { requiresLogin: boolean }) {
  return (
    <div className="w-full text-center">
      <h1 className="text-[1.8rem] font-semibold leading-tight tracking-[-0.025em]">
        What can I help with?
      </h1>
      {requiresLogin && (
        <p
          className="mx-auto mt-2 max-w-[28rem] text-sm leading-5"
          style={{ color: "var(--shell-muted)" }}
        >
          Log in to start a private conversation with the personal AI that remembers what matters.
        </p>
      )}
    </div>
  );
}

function AccountAccessActions() {
  return (
    <nav
      aria-label="Account access"
      className="absolute right-0 top-0 z-10 flex h-16 items-center gap-2 px-4 sm:px-5"
    >
      <AuthTrigger
        intent="login"
        className="flex h-9 items-center rounded-full px-4 text-sm font-medium transition-opacity hover:opacity-90"
        style={{ background: "var(--shell-accent)", color: "#000000" }}
      >
        Log in
      </AuthTrigger>
      <AuthTrigger
        intent="signup"
        className="flex h-9 items-center rounded-full border px-4 text-sm font-medium transition-colors hover:bg-white/[0.06]"
        style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
      >
        Sign up
      </AuthTrigger>
    </nav>
  );
}

function CredentialsNotice() {
  return (
    <div
      role="status"
      className="mb-4 rounded-2xl border px-5 py-4"
      style={{ borderColor: "var(--shell-line-strong)", background: "var(--shell-panel)" }}
    >
      <p className="text-[0.9rem] font-medium">API key required</p>
      <p className="mt-1.5 text-[0.82rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        Chat and extraction need a configured API key in{" "}
        <code className="font-mono text-[0.76rem]" style={{ color: "var(--shell-fg)" }}>
          .env.local
        </code>
        . Browsing and editing saved details still works without one.
      </p>
    </div>
  );
}

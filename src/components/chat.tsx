"use client";

import { useEffect, useRef, useState } from "react";

import { AuthTrigger } from "@/components/auth-trigger";
import {
  CHAT_UPDATED_EVENT,
  NEW_CHAT_EVENT,
  type ChatUpdatedDetail,
} from "@/components/chat-events";
import {
  receiptSummaryParts,
  type ChatReceipt,
} from "@/components/chat-receipt";
import type { FollowThroughRecommendation } from "@/core/schema";

type RecommendationDecision = "accepted" | "dismissed" | "snoozed" | "completed";

export type ChatHistoryTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type Turn = ChatHistoryTurn & {
  recommendation?: FollowThroughRecommendation;
  recommendationDecision?: RecommendationDecision;
  /** Set on the assistant turn once the stream closes. */
  receipt?: ChatReceipt;
};

type Status = "idle" | "streaming" | "error";

export function Chat({
  hasCredentials,
  canAccessPrivateData,
  canUseChat,
  showAuthActions,
  initialPrompt,
  initialTurns = [],
  initialConversationId,
}: {
  hasCredentials: boolean;
  canAccessPrivateData: boolean;
  canUseChat: boolean;
  showAuthActions: boolean;
  initialPrompt?: string;
  initialTurns?: ChatHistoryTurn[];
  initialConversationId?: number;
}) {
  const [turns, setTurns] = useState<Turn[]>(canAccessPrivateData ? initialTurns : []);
  const [input, setInput] = useState(initialPrompt ?? "");
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
    if (!text || status === "streaming" || !hasCredentials || !canUseChat) return;

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
        body: JSON.stringify(
          canAccessPrivateData
            ? { input: text, conversationId: conversationId.current }
            : { input: text, history: boundedGuestHistory(turns) },
        ),
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
            setTurns((prior) =>
              prior.map((turn) =>
                turn.id === replyId
                  ? event.guest === true
                    ? turn
                    : {
                        ...turn,
                        receipt: {
                          messageId: event.messageId as number,
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
                          superseded: event.superseded as number,
                          failed: event.extractionFailed as boolean,
                        },
                        recommendation:
                          (event.recommendation as FollowThroughRecommendation | null) ?? undefined,
                      }
                  : turn,
              ),
            );
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

  function chooseStarter(prompt: string) {
    setInput(prompt);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      resizeComposer(textareaRef.current);
      textareaRef.current.focus();
    });
  }

  async function respondToRecommendation(
    turnId: string,
    recommendation: FollowThroughRecommendation,
    decision: RecommendationDecision,
    responseMessageId: number | null,
    userReason?: string,
  ) {
    try {
      const response = await fetch("/api/follow-through", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitmentId: recommendation.commitment_id,
          decision,
          responseMessageId,
          ...(userReason?.trim() ? { userReason: userReason.trim() } : {}),
        }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? "Could not record that choice.");
      }
      setTurns((prior) =>
        prior.map((turn) =>
          turn.id === turnId ? { ...turn, recommendationDecision: decision } : turn,
        ),
      );
      if (decision === "accepted") chooseStarter(recommendation.chat_prompt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record that choice.");
    }
  }

  const hasVisibleTurns = turns.length > 0;
  const canSend =
    Boolean(input.trim()) && status !== "streaming" && hasCredentials && canUseChat;
  const composer = (
    <Composer
      input={input}
      onInputChange={setInput}
      onSend={send}
      textareaRef={textareaRef}
      status={status}
      canSend={canSend}
      hasCredentials={hasCredentials}
      canUseChat={canUseChat}
      centered={!hasVisibleTurns}
    />
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      style={{ background: "var(--shell-bg)" }}
    >
      {showAuthActions && <GuestAuthActions />}
      {!hasVisibleTurns ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
          <div className="mx-auto flex min-h-full w-full max-w-[48rem] flex-col justify-center pb-[28vh] pt-20">
            {canAccessPrivateData && !hasCredentials && <CredentialsNotice />}
            <EmptyState />
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
                        receipt={turn.receipt}
                        recommendation={turn.recommendation}
                        recommendationDecision={turn.recommendationDecision}
                        onRecommendationDecision={(recommendation, decision, userReason) =>
                          respondToRecommendation(
                            turn.id,
                            recommendation,
                            decision,
                            turn.receipt?.messageId ?? null,
                            userReason,
                          )
                        }
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

function Composer({
  input,
  onInputChange,
  onSend,
  textareaRef,
  status,
  canSend,
  hasCredentials,
  canUseChat,
  centered,
}: {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  status: Status;
  canSend: boolean;
  hasCredentials: boolean;
  canUseChat: boolean;
  centered: boolean;
}) {
  const inputLabel = "Message Zeus";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSend();
      }}
      className={centered ? "mt-7 w-full" : "shrink-0 px-3 pb-2 pt-3 md:px-5"}
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

function boundedGuestHistory(turns: readonly Turn[]): Array<{
  role: "user" | "assistant";
  content: string;
}> {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let remainingCharacters = 20_000;

  for (const turn of turns.slice(-20).reverse()) {
    const content = turn.text.trim().slice(0, 4_000);
    if (!content || remainingCharacters === 0) continue;
    const boundedContent = content.slice(0, remainingCharacters);
    history.unshift({ role: turn.role, content: boundedContent });
    remainingCharacters -= boundedContent.length;
  }

  return history;
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

function AssistantTurn({
  text,
  receipt,
  recommendation,
  recommendationDecision,
  onRecommendationDecision,
  pending,
}: {
  text: string;
  receipt?: Turn["receipt"];
  recommendation?: FollowThroughRecommendation;
  recommendationDecision?: RecommendationDecision;
  onRecommendationDecision: (
    recommendation: FollowThroughRecommendation,
    decision: RecommendationDecision,
    userReason?: string,
  ) => void;
  pending: boolean;
}) {
  return (
    <div className="flex gap-4">
      <AssistantMark />
      <div className="min-w-0 flex-1 pt-0.5">
        {text ? (
          <p className="whitespace-pre-wrap text-[0.95rem] leading-7" style={{ color: "var(--shell-fg)" }}>
            {text}
          </p>
        ) : (
          pending && <ThinkingIndicator />
        )}
        {recommendation && (
          <FollowThroughCard
            recommendation={recommendation}
            decision={recommendationDecision}
            onDecision={onRecommendationDecision}
          />
        )}
        {receipt && <Receipt {...receipt} />}
      </div>
    </div>
  );
}

function FollowThroughCard({
  recommendation,
  decision,
  onDecision,
}: {
  recommendation: FollowThroughRecommendation;
  decision?: RecommendationDecision;
  onDecision: (
    recommendation: FollowThroughRecommendation,
    decision: RecommendationDecision,
    userReason?: string,
  ) => void;
}) {
  const [userReason, setUserReason] = useState("");
  const decisionText =
    decision === "accepted"
      ? "Ready in the composer — help is available without acting externally."
      : decision === "completed"
        ? "Marked complete."
        : decision === "snoozed"
          ? "Snoozed for seven days."
          : decision === "dismissed"
            ? "Dismissed. It will stay quiet unless the commitment changes."
            : null;

  return (
    <aside
      className="mt-4 rounded-xl border px-4 py-3.5"
      style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
      aria-label="Follow-through recommendation"
    >
      <p
        className="font-mono text-[0.62rem] uppercase tracking-[0.14em]"
        style={{ color: "var(--shell-faint)" }}
      >
        Useful next action
      </p>
      <p className="mt-2 text-[0.9rem] font-medium">{recommendation.suggested_action}</p>
      <p className="mt-1.5 text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        {recommendation.why}
      </p>
      {recommendation.requires_confirmation && (
        <p className="mt-2 font-mono text-[0.62rem]" style={{ color: "var(--shell-faint)" }}>
          external action requires your confirmation
        </p>
      )}
      {decisionText ? (
        <p className="mt-3 text-[0.76rem]" style={{ color: "var(--shell-muted)" }}>
          {decisionText}
        </p>
      ) : (
        <div className="mt-3 text-[0.76rem]">
          <label className="block max-w-[30rem] text-[0.68rem]" style={{ color: "var(--shell-faint)" }}>
            Reason (optional; silence is never interpreted)
            <input
              value={userReason}
              onChange={(event) => setUserReason(event.target.value)}
              maxLength={1000}
              className="mt-1 block min-h-[34px] w-full rounded-md border px-2.5"
              style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => onDecision(recommendation, "accepted", userReason)}
            className="rounded-md px-3 py-1.5 font-medium"
            style={{ background: "var(--shell-accent)", color: "#000000" }}
          >
            Help me do this
          </button>
          <button type="button" onClick={() => onDecision(recommendation, "completed", userReason)}>
            Already done
          </button>
          <button type="button" onClick={() => onDecision(recommendation, "snoozed", userReason)}>
            Not now
          </button>
          <button
            type="button"
            onClick={() => onDecision(recommendation, "dismissed", userReason)}
            style={{ color: "var(--shell-faint)" }}
          >
            Not useful
          </button>
          </div>
        </div>
      )}
      <div className="mt-2 flex gap-3 font-mono text-[0.61rem]" style={{ color: "var(--shell-faint)" }}>
        <a href={`/source/${recommendation.commitment_source_message_id}`} className="underline underline-offset-2">
          why this is known
        </a>
        <a href="/settings#follow-through" className="underline underline-offset-2">
          follow-through settings
        </a>
      </div>
    </aside>
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

/** The memory changes made by a turn, kept inspectable without crowding the reply. */
function Receipt({
  messageId,
  recalled,
  recalledFacts,
  recalledEpisodes,
  recalledFacets,
  accepted,
  acceptedFacets,
  pending,
  pendingFacets,
  goalsUpdated,
  commitmentsUpdated,
  superseded,
  failed,
}: NonNullable<Turn["receipt"]>) {
  const parts = receiptSummaryParts({
    messageId,
    recalled,
    recalledFacts,
    recalledEpisodes,
    recalledFacets,
    accepted,
    acceptedFacets,
    pending,
    pendingFacets,
    goalsUpdated,
    commitmentsUpdated,
    superseded,
    failed,
  });

  if (parts.length === 0) {
    return (
      <a
        href={`/response/${messageId}`}
        className="mt-3 inline-block font-mono text-[0.66rem] underline underline-offset-2"
        style={{ color: "var(--shell-faint)" }}
      >
        response sources
      </a>
    );
  }

  return (
    <details className="mt-3 font-mono text-[0.66rem]" style={{ color: "var(--shell-faint)" }}>
      <summary className="inline-flex cursor-pointer list-none rounded-md py-1 hover:text-white">
        {parts.join("  ·  ")}
      </summary>
      <div
        className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 border-l pl-3"
        style={{ borderColor: "var(--shell-line-strong)" }}
      >
        <span>{recalledFacts} facts</span>
        <span>{recalledEpisodes} passages</span>
        <span>{recalledFacets} understanding facets</span>
        {acceptedFacets > 0 && <span>{acceptedFacets} facets accepted</span>}
        {goalsUpdated > 0 && <span>{goalsUpdated} goals updated</span>}
        {commitmentsUpdated > 0 && <span>{commitmentsUpdated} commitments updated</span>}
        <a href={`/response/${messageId}`} className="underline underline-offset-2" style={{ color: "var(--shell-fg)" }}>
          sources used
        </a>
        {(accepted > 0 || pending > 0) && (
          <a
            href={pendingFacets > 0 ? "/understanding" : pending > 0 ? "/memory?view=review" : "/memory"}
            className="underline underline-offset-2"
            style={{ color: "var(--shell-fg)" }}
          >
            {pendingFacets > 0 ? "review understanding" : "review saved details"}
          </a>
        )}
      </div>
    </details>
  );
}

function EmptyState() {
  return (
    <div className="w-full text-center">
      <h1 className="text-[1.8rem] font-semibold leading-tight tracking-[-0.025em]">
        What can I help with?
      </h1>
    </div>
  );
}

function GuestAuthActions() {
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

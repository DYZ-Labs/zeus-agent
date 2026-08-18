"use client";

import { useEffect, useRef, useState } from "react";

import { confirmEffectAction, declineEffectAction } from "@/app/actions";
import { AssistantProse } from "@/components/assistant-prose";
import { AuthTrigger } from "@/components/auth-trigger";
import {
  CARD_COPY,
  CLARIFICATION,
  CLARIFICATION_FALLBACK,
  FOLLOW_THROUGH_DECISION,
  NOT_DONE,
  TARGET_NOT_FOUND,
  UNVERIFIABLE,
  UNVERIFIABLE_FALLBACK,
  WORK_CARD_COPY,
  rendersCard,
} from "@/components/calendar-card-copy";
import {
  CHAT_UPDATED_EVENT,
  NEW_CHAT_EVENT,
  type ChatUpdatedDetail,
} from "@/components/chat-events";
import { type ChatReceipt } from "@/components/chat-receipt";
// Imported rather than restated. A hand-copied duplicate is how a new status ends up
// rendering the catch-all sentence in CARD_COPY.stoppedShort, which for read_only would
// be actively false.
import type { CalendarOutcome, FollowThroughRecommendation } from "@/core/schema";

type RecommendationDecision = "accepted" | "dismissed" | "snoozed" | "completed";

export type ChatHistoryTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * How a calendar request ended. Stored with the turn, so the deterministic account of
   * everything Zeus did *not* do survives a reload rather than resting on the model's prose.
   * A change that went through is the deliberate exception: it renders no card, so there the
   * reply is the account and the receipt is the durable copy.
   */
  calendar?: CalendarOutcome | null;
};

type Turn = ChatHistoryTurn & {
  recommendation?: FollowThroughRecommendation;
  recommendationDecision?: RecommendationDecision;
  workPlan?: {
    id: number;
    runId: number;
    status: string;
    errorCode: string | null;
    artifacts: Array<{ id: number; title: string; kind: string }>;
    pendingEffects: Array<{
      id: number;
      previewText: string;
      payload: unknown;
      payloadHash: string;
      expiresAt: string;
      capabilitySlot: string;
      connectorLabel: string;
    }>;
  };
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
}: {
  hasCredentials: boolean;
  canAccessPrivateData: boolean;
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
                      workPlan:
                        (event.workPlan as Turn["workPlan"] | null) ?? undefined,
                      calendar: (event.calendar as CalendarOutcome | null) ?? null,
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
                        workPlan={turn.workPlan}
                        calendar={turn.calendar}
                        onReply={(text) => {
                          setInput(text);
                          textareaRef.current?.focus();
                        }}
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

function AssistantTurn({
  text,
  recommendation,
  recommendationDecision,
  onRecommendationDecision,
  workPlan,
  calendar,
  onReply,
  pending,
}: {
  text: string;
  recommendation?: FollowThroughRecommendation;
  recommendationDecision?: RecommendationDecision;
  onRecommendationDecision: (
    recommendation: FollowThroughRecommendation,
    decision: RecommendationDecision,
    userReason?: string,
  ) => void;
  workPlan?: Turn["workPlan"];
  calendar?: CalendarOutcome | null;
  /** Fills the composer. Choosing an alternative is a message the user sends, not an act. */
  onReply: (text: string) => void;
  pending: boolean;
}) {
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
        {recommendation && (
          <FollowThroughCard
            recommendation={recommendation}
            decision={recommendationDecision}
            onDecision={onRecommendationDecision}
          />
        )}
        {/*
          A read and a completed change both render nothing, and the card decides that for
          itself rather than this ternary deciding it: an outcome exists for every calendar
          request, so this branch must keep being taken. Testing `calendar.kind` or
          `calendar.status` here instead would fall through to that request's own
          WorkPlanCard, which lists the very steps the card was hiding.
        */}
        {calendar ? (
          <CalendarActionCard workPlan={workPlan} outcome={calendar} onReply={onReply} />
        ) : (
          workPlan && <WorkPlanCard workPlan={workPlan} />
        )}
      </div>
    </div>
  );
}

/**
 * Why Zeus did not change the calendar, and what would settle it.
 *
 * Only that. A change that went through renders nothing here — the reply is the account of
 * it, and the receipt on `/today` is the durable copy — so everything below is a collision,
 * a question, or a refusal.
 *
 * Everything here is rendered from the deterministic outcome rather than from the
 * assistant's prose, so the card cannot claim something the run did not do. Choosing an
 * alternative time fills the composer instead of acting: the user sends a real message, the
 * whole gated path runs again, and no button on this card writes to a calendar.
 */
function CalendarActionCard({
  workPlan,
  outcome,
  onReply,
}: {
  // Optional: the outcomes worth surfacing most — nothing connected, or a request Zeus
  // recognized and could not resolve — never produced a run to attach to.
  workPlan?: Turn["workPlan"];
  outcome: CalendarOutcome;
  onReply: (text: string) => void;
}) {
  const [decided, setDecided] = useState<"executed" | "declined" | null>(null);
  const [busy, setBusy] = useState<"confirm" | "decline" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = workPlan?.pendingEffects[0];

  async function decide(action: "confirm" | "decline", effectId: number, hash?: string) {
    if (busy) return;
    setBusy(action);
    setActionError(null);
    try {
      const response = await fetch(`/api/effects/${effectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payloadHash: hash }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        outcome?: string;
      } | null;
      if (!response.ok || !body?.outcome) {
        throw new Error(body?.error ?? "That action could not be completed.");
      }
      // A failed execute leaves `decided` null on purpose: nothing happened, so the card
      // stays and `actionError` says why. The rule holds — a card means it did not happen.
      if (body.outcome === "executed" || body.outcome === "declined") {
        setDecided(body.outcome);
      } else {
        throw new Error("The change did not go through.");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That action could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  // A card is the record of a change that did not happen. A completed create, reschedule,
  // or cancel renders nothing: the reply is the account of it, and the receipt on /today is
  // the durable copy. A read renders nothing either — nothing changed, so there is no
  // receipt to put under the answer — and read-shaped refusals go with it, because the
  // reply already has to say what is missing and where to change it. The calendar_outcome
  // row is written in every case, so what happened stays recorded; only the rendering is
  // conditional. Placed below the hooks so they still run unconditionally, and inside the
  // component rather than at the render site in chat.tsx, because that ternary falls
  // through to WorkPlanCard — which would list the very steps this card was hiding.
  if (!rendersCard(outcome)) return null;

  // A panel that asked has to answer its own buttons. Nothing else is streamed after a
  // decision — no new assistant turn follows the click — so without this, confirming and
  // declining would look identical from the outside: the panel simply gone, above prose
  // written a moment earlier saying nothing had been sent yet.
  //
  // This is the one place a card reports that something happened, and it stays deliberately
  // bare. What changed is the reply's to say; this says only that the request went.
  if (decided) {
    return (
      <aside
        className="mt-4 rounded-xl border px-4 py-3.5"
        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
        aria-label="Calendar change"
      >
        <p className="text-[0.85rem] leading-6">
          {decided === "executed" ? CARD_COPY.sent : CARD_COPY.nothingWasSent}
        </p>
      </aside>
    );
  }

  // Awaiting confirmation with no pending request in hand means this turn was rehydrated
  // after a reload, which does not restore the work plan. Zeus cannot tell from here
  // whether the user went on to confirm, so it says nothing rather than reporting that it
  // stopped — which would be a flat contradiction of a change that did go through.
  if (outcome.status === "awaiting_confirmation" && !pending) return null;

  return (
    <aside
      className="mt-4 rounded-xl border px-4 py-3.5"
      style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
      aria-label="Calendar change"
    >
      {outcome.status === "blocked_by_conflict" ? (
        <>
          <p className="text-[0.85rem] font-medium leading-6">
            {NOT_DONE[outcome.kind]} — {CARD_COPY.blockedByConflict}
          </p>
          <ul className="mt-2 space-y-1 text-[0.78rem]" style={{ color: "var(--shell-muted)" }}>
            {outcome.conflicts.map((conflict) => (
              <li key={`${conflict.startsAt}-${conflict.title ?? ""}`}>
                {conflict.title ?? "An event"} · {timeRange(conflict.startsAt, conflict.endsAt)}
              </li>
            ))}
          </ul>
          {outcome.alternatives.length > 0 && (
            <>
              <p className="mt-3 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
                {CARD_COPY.freeNearby}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {outcome.alternatives.map((slot) => (
                  <button
                    key={slot.startsAt}
                    type="button"
                    onClick={() => onReply(alternativeReply(outcome.kind, slot.startsAt))}
                    className="rounded-md border px-2.5 py-1 text-[0.74rem]"
                    style={{ borderColor: "var(--shell-line)", color: "var(--shell-fg)" }}
                  >
                    {timeRange(slot.startsAt, slot.endsAt)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : outcome.status === "ambiguous_target" ? (
        <>
          <p className="text-[0.85rem] font-medium leading-6">
            {CARD_COPY.ambiguousTarget}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {outcome.candidates.map((candidate) => (
              <button
                key={candidate.externalId}
                type="button"
                onClick={() =>
                  onReply(`I mean ${candidate.title ?? "the one"} at ${localLabel(candidate.startsAt)}.`)
                }
                className="rounded-md border px-2.5 py-1 text-[0.74rem]"
                style={{ borderColor: "var(--shell-line)", color: "var(--shell-fg)" }}
              >
                {candidate.title ?? "An event"} · {localLabel(candidate.startsAt)}
              </button>
            ))}
          </div>
        </>
      ) : outcome.status === "target_not_found" ? (
        <>
          <p className="text-[0.85rem] leading-6">
            {outcome.coverage?.eventCount === 0
              ? TARGET_NOT_FOUND.emptyWindow
              : TARGET_NOT_FOUND.noMatch}
          </p>
          {outcome.nearMisses.length > 0 && (
            <>
              <p className="mt-3 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
                {TARGET_NOT_FOUND.nearMisses}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {outcome.nearMisses.map((candidate) => (
                  <button
                    key={candidate.externalId}
                    type="button"
                    onClick={() =>
                      onReply(
                        `I mean ${candidate.title ?? "the one"} at ${localLabel(candidate.startsAt)}.`,
                      )
                    }
                    className="rounded-md border px-2.5 py-1 text-[0.74rem]"
                    style={{ borderColor: "var(--shell-line)", color: "var(--shell-fg)" }}
                  >
                    {candidate.title ?? "An event"} · {localLabel(candidate.startsAt)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : outcome.status === "needs_clarification" ? (
        <p className="text-[0.85rem] leading-6">
          Nothing changed.{" "}
          {(outcome.reason && CLARIFICATION[outcome.reason]) ?? CLARIFICATION_FALLBACK}{" "}
          {CARD_COPY.needsClarificationSuffix}
        </p>
      ) : outcome.status === "read_only" ? (
        <p className="text-[0.85rem] leading-6">
          {CARD_COPY.readOnly}{" "}
          <a href="/settings#connections" className="underline underline-offset-2">
            Allow calendar changes
          </a>
          .
        </p>
      ) : outcome.status === "unverifiable" ? (
        <p className="text-[0.85rem] leading-6">
          {(outcome.reason && UNVERIFIABLE[outcome.reason]) ?? UNVERIFIABLE_FALLBACK}
        </p>
      ) : outcome.status === "no_connector" ? (
        <p className="text-[0.85rem] leading-6">
          {CARD_COPY.noConnector}{" "}
          <a href="/settings#connections" className="underline underline-offset-2">
            Connect one
          </a>
          .
        </p>
      ) : outcome.status === "awaiting_confirmation" && pending ? (
        <>
          {outcome.reason === "calendar_conflict" ? (
            <>
              <p className="text-[0.85rem] font-medium leading-6">
                {NOT_DONE[outcome.kind]} yet — {CARD_COPY.awaitingOverlap}
              </p>
              <ul className="mt-2 space-y-1 text-[0.78rem]" style={{ color: "var(--shell-muted)" }}>
                {outcome.conflicts.map((conflict) => (
                  <li key={`${conflict.startsAt}-${conflict.title ?? ""}`}>
                    {conflict.title ?? "An event"} · {timeRange(conflict.startsAt, conflict.endsAt)}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[0.8rem] leading-5">{pending.previewText}</p>
              <p className="mt-1 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
                {CARD_COPY.confirmDespiteOverlap}
              </p>
            </>
          ) : (
            <>
              <p className="text-[0.85rem] font-medium leading-6">{pending.previewText}</p>
              <p className="mt-1 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
                {CARD_COPY.nothingSentYet}
              </p>
            </>
          )}
          <pre
            className="mt-3 overflow-x-auto rounded-md border px-2.5 py-2 font-mono text-[0.66rem] leading-5"
            style={{ borderColor: "var(--shell-line)", color: "var(--shell-muted)" }}
            aria-label="Exact Google Calendar request"
          >
            {JSON.stringify(pending.payload, null, 2)}
          </pre>
          {outcome.reason === "calendar_conflict" && outcome.alternatives.length > 0 && (
            <>
              <p className="mt-3 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
                {CARD_COPY.freeNearby}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {outcome.alternatives.map((slot) => (
                  <button
                    key={slot.startsAt}
                    type="button"
                    onClick={() => onReply(alternativeReply(outcome.kind, slot.startsAt))}
                    className="rounded-md border px-2.5 py-1 text-[0.74rem]"
                    style={{ borderColor: "var(--shell-line)", color: "var(--shell-fg)" }}
                  >
                    {timeRange(slot.startsAt, slot.endsAt)}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[0.75rem]">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide("confirm", pending.id, pending.payloadHash)}
              className="rounded-md px-3 py-1.5 font-medium disabled:opacity-50"
              style={{ background: "var(--shell-elevated)", color: "var(--shell-fg)" }}
            >
              {busy === "confirm" ? "Sending…" : "Confirm"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void decide("decline", pending.id)}
              className="underline underline-offset-2 disabled:opacity-50"
              style={{ color: "var(--shell-muted)" }}
            >
              Don&apos;t
            </button>
          </div>
        </>
      ) : (
        <p className="text-[0.85rem] leading-6">{CARD_COPY.stoppedShort}</p>
      )}
      {actionError && (
        <p className="mt-2 text-[0.72rem]" role="alert" style={{ color: "#f3a6a6" }}>
          {actionError}
        </p>
      )}
    </aside>
  );
}

function localLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function alternativeReply(kind: CalendarOutcome["kind"], startsAt: string): string {
  return kind === "create"
    ? `Add it at ${localLabel(startsAt)}.`
    : `Move it to ${localLabel(startsAt)}.`;
}

function timeRange(startsAt: string, endsAt: string | null): string {
  const end = endsAt ? new Date(endsAt) : null;
  const endLabel = end && !Number.isNaN(end.getTime())
    ? end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;
  return endLabel ? `${localLabel(startsAt)}–${endLabel}` : localLabel(startsAt);
}

function WorkPlanCard({ workPlan }: { workPlan: NonNullable<Turn["workPlan"]> }) {
  const [status, setStatus] = useState(workPlan.status);
  const [errorCode, setErrorCode] = useState(workPlan.errorCode);
  const [busy, setBusy] = useState<"resume" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const completed = status === "completed";
  const closed = completed || status === "cancelled";
  const canResume = ["queued", "running", "paused"].includes(status);
  const awaitingConfirmation = errorCode === "effect_confirmation_required";
  const pendingEffect = workPlan.pendingEffects[0];

  async function act(action: "resume" | "cancel") {
    if (busy) return;
    setBusy(action);
    setActionError(null);
    try {
      const response = await fetch(`/api/work-runs/${workPlan.runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        run?: { status: string; error_code: string | null };
      } | null;
      if (!response.ok || !body?.run) {
        throw new Error(body?.error ?? "The bounded-work action failed.");
      }
      setStatus(body.run.status);
      setErrorCode(body.run.error_code);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The bounded-work action failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside
      className="mt-4 rounded-xl border px-4 py-3.5"
      style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
      aria-label="Bounded work plan"
    >
      <p
        className="font-mono text-[0.62rem] uppercase tracking-[0.14em]"
        style={{ color: "var(--shell-faint)" }}
      >
        Bounded work · {status}
      </p>
      <p className="mt-2 text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        {completed
          ? WORK_CARD_COPY.completed
          : awaitingConfirmation
            ? WORK_CARD_COPY.awaitingConfirmation
            : `The run stopped at ${errorCode ?? "a durable checkpoint"}; no external action was taken.`}
      </p>
      {awaitingConfirmation && pendingEffect ? (
        <div className="mt-3 rounded-lg border px-3 py-3" style={{ borderColor: "var(--shell-line)" }}>
          <p className="text-[0.82rem] font-medium leading-5">{pendingEffect.previewText}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-[0.72rem]" style={{ color: "var(--shell-muted)" }}>
              Exactly what Google Calendar will receive
            </summary>
            <pre
              className="mt-2 overflow-x-auto rounded-md border px-2.5 py-2 font-mono text-[0.66rem] leading-5"
              style={{ borderColor: "var(--shell-line)", color: "var(--shell-muted)" }}
            >
              {JSON.stringify(pendingEffect.payload, null, 2)}
            </pre>
            <p className="mt-1.5 font-mono text-[0.6rem]" style={{ color: "var(--shell-faint)" }}>
              {pendingEffect.capabilitySlot} · {pendingEffect.connectorLabel} · {pendingEffect.payloadHash}
            </p>
          </details>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[0.75rem]">
            <form action={confirmEffectAction}>
              <input type="hidden" name="id" value={pendingEffect.id} />
              <input type="hidden" name="payloadHash" value={pendingEffect.payloadHash} />
              <button
                type="submit"
                className="rounded-md px-3 py-1.5 font-medium"
                style={{ background: "var(--shell-elevated)", color: "var(--shell-fg)" }}
              >
                Confirm and create event
              </button>
            </form>
            <form action={declineEffectAction}>
              <input type="hidden" name="id" value={pendingEffect.id} />
              <button type="submit" className="underline underline-offset-2" style={{ color: "var(--shell-muted)" }}>
                Do not create
              </button>
            </form>
          </div>
          <p className="mt-2 text-[0.68rem]" style={{ color: "var(--shell-faint)" }}>
            If you do nothing, nothing happens. Expires {pendingEffect.expiresAt.slice(0, 10)}.
          </p>
        </div>
      ) : awaitingConfirmation ? (
        // Older persisted runs may not have streamed their pending payload into this card.
        <a
          href="/today#confirmations"
          className="mt-3 inline-block text-[0.74rem] font-medium"
          style={{ color: "var(--shell-accent)" }}
        >
          Review the exact request →
        </a>
      ) : null}
      {!closed && !awaitingConfirmation && (
        <div className="mt-3 flex flex-wrap gap-4 text-[0.74rem]">
          {canResume && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act("resume")}
              className="font-medium disabled:opacity-50"
              style={{ color: "var(--shell-accent)" }}
            >
              {busy === "resume" ? "Resuming…" : "Resume"}
            </button>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("cancel")}
            className="disabled:opacity-50"
            style={{ color: "var(--shell-faint)" }}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      )}
      {actionError && (
        <p className="mt-2 text-[0.72rem]" role="alert" style={{ color: "#f3a6a6" }}>
          {actionError} Review the exact plan in Today if it needs fresh approval.
        </p>
      )}
      {workPlan.artifacts.length > 0 && (
        <ul className="mt-2 space-y-1 text-[0.78rem]">
          {workPlan.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <a href={`/work-artifacts/${artifact.id}`} className="underline underline-offset-2">
                {artifact.title}
              </a>{" "}
              <span
                className="font-mono text-[0.61rem]"
                style={{ color: "var(--shell-faint)" }}
              >
                {artifact.kind.replace(/_/gu, " ")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <a
        href="/today#work-plans"
        className="mt-2 inline-block font-mono text-[0.61rem] underline underline-offset-2"
        style={{ color: "var(--shell-faint)" }}
      >
        review plan and receipts
      </a>
    </aside>
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
  const decisionText = decision ? FOLLOW_THROUGH_DECISION[decision] : null;

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

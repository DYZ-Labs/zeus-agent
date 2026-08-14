"use client";

import { useEffect, useRef, useState } from "react";

import { confirmEffectAction, declineEffectAction } from "@/app/actions";
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
                        workPlan={turn.workPlan}
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
  receipt,
  recommendation,
  recommendationDecision,
  onRecommendationDecision,
  workPlan,
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
  workPlan?: Turn["workPlan"];
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
        {workPlan && <WorkPlanCard workPlan={workPlan} />}
        {receipt && <Receipt {...receipt} />}
      </div>
    </div>
  );
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
          ? "Zeus completed the authorized research and local preparation steps."
          : awaitingConfirmation
            ? "Zeus prepared an external request and stopped. Nothing has been sent."
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
  projectsUpdated,
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
        {projectsUpdated > 0 && <span>{projectsUpdated} projects updated</span>}
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

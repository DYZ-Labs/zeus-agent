"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

import type { RecommendationDto } from "@/core/recommendation-dtos";

type Decision = "accepted" | "completed" | "snoozed" | "dismissed";

export function TodayRecommendation({
  recommendation,
}: {
  recommendation: RecommendationDto;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Decision | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<"snoozed" | "dismissed" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: Decision, userReason?: string) {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch("/api/follow-through", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitmentId: recommendation.commitmentId,
          decision,
          ...(userReason?.trim() ? { userReason: userReason.trim() } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "Could not save that choice.");
      if (decision === "accepted") {
        router.push(`/?prompt=${encodeURIComponent(recommendation.chatPrompt)}`);
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that choice.");
    } finally {
      setBusy(null);
    }
  }

  async function decideThenAskForFeedback(decision: "snoozed" | "dismissed") {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      const response = await fetch("/api/follow-through", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitmentId: recommendation.commitmentId,
          decision,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "Could not save that choice.");
      setFeedbackFor(decision);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that choice.");
    } finally {
      setBusy(null);
    }
  }

  async function saveFeedback() {
    if (!feedbackFor || !feedback.trim() || busy) return;
    setBusy(feedbackFor);
    setError(null);
    try {
      const response = await fetch("/api/follow-through", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitmentId: recommendation.commitmentId,
          decision: feedbackFor,
          userReason: feedback.trim(),
          feedbackOnly: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "Could not save that feedback.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that feedback.");
    } finally {
      setBusy(null);
    }
  }

  if (feedbackFor) {
    return (
      <article className="rounded-xl border px-5 py-5" style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}>
        <h2 className="text-base font-medium">
          {feedbackFor === "snoozed" ? "Saved for later" : "Marked not relevant"}
        </h2>
        <p className="mt-2 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
          Your choice is saved. If you want, tell Zeus what made this suggestion miss the mark.
        </p>
        <label className="mt-4 block text-sm">
          <span className="sr-only">Optional feedback</span>
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={2}
            maxLength={1_000}
            placeholder="Optional feedback"
            className="w-full resize-y rounded-lg border px-3 py-2 outline-none"
            style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)" }}
          />
        </label>
        <div className="mt-3 flex gap-4 text-sm">
          <button
            type="button"
            disabled={!feedback.trim() || busy !== null}
            onClick={() => void saveFeedback()}
            className="font-medium disabled:opacity-40"
            style={{ color: "var(--shell-accent)" }}
          >
            Save feedback
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => router.refresh()}
            style={{ color: "var(--shell-muted)" }}
          >
            Done
          </button>
        </div>
        {error && <p role="alert" className="mt-2 text-sm" style={{ color: "#ff8585" }}>{error}</p>}
      </article>
    );
  }

  return (
    <article className="rounded-xl border px-5 py-5" style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}>
      <p className="text-xs font-medium uppercase tracking-[0.12em]" style={{ color: "var(--shell-faint)" }}>
        One useful next step
      </p>
      <h2 className="mt-3 text-lg font-medium leading-6">{recommendation.suggestedAction}</h2>
      <p className="mt-3 max-w-[68ch] text-sm leading-6" style={{ color: "var(--shell-muted)" }}>
        {recommendation.why}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 text-sm">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void decide("accepted")}
          className="rounded-lg px-3 py-2 font-medium disabled:opacity-50"
          style={{ background: "var(--shell-accent)", color: "#000000" }}
        >
          Help me do this
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void decide("completed")}>
          Mark done
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void decideThenAskForFeedback("snoozed")}>
          Later
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void decideThenAskForFeedback("dismissed")} style={{ color: "var(--shell-faint)" }}>
          Not relevant
        </button>
      </div>
      {recommendation.requiresConfirmation && (
        <p className="mt-3 text-xs" style={{ color: "var(--shell-faint)" }}>
          Zeus can prepare this here. Anything outside Zeus still needs your approval.
        </p>
      )}
      <Link href={`/source/${recommendation.sourceId}`} className="mt-4 inline-block text-xs underline underline-offset-4" style={{ color: "var(--shell-faint)" }}>
        Why this suggestion
      </Link>
      {error && <p role="alert" className="mt-2 text-sm" style={{ color: "#ff8585" }}>{error}</p>}
    </article>
  );
}

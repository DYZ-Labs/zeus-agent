import Link from "next/link";

import { followThroughDecisionAction } from "@/app/actions";
import { PageHeader } from "@/components/page-header";
import { Plans } from "@/components/plans";
import { hasCredentials } from "@/core/openai";
import type { FollowThroughRecommendation } from "@/core/schema";
import {
  recommendationForCommitment,
  recommendNextAction,
} from "@/core/stewardship";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; show?: string }>;
}) {
  const db = await requireOwnerPageDb();
  const params = await searchParams;
  const focus = Number(params.focus);
  const recommendation = Number.isInteger(focus) && focus > 0
    ? recommendationForCommitment(db, focus)
    : recommendNextAction(db, "", { force: true });

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Today"
        meta={recommendation ? "one useful next action" : "nothing needs your attention"}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <p className="max-w-[68ch] text-[0.9rem] leading-6" style={{ color: "var(--shell-muted)" }}>
          Zeus ranks what is timely, meaningful, and actionable. It offers one step at a time,
          records your corrections, and leaves external actions under your control.
        </p>

        <section className="mt-8 max-w-[54rem]">
          {recommendation ? (
            <RecommendationCard recommendation={recommendation} canChat={hasCredentials()} />
          ) : (
            <div
              className="rounded-xl border border-dashed px-5 py-8"
              style={{ borderColor: "var(--shell-line-strong)" }}
            >
              <h2 className="text-[1rem] font-medium">Nothing worth interrupting you for.</h2>
              <p className="mt-2 max-w-[60ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
                That is a valid outcome. Zeus will stay quiet until an accepted commitment becomes
                relevant, urgent, stale, or explicitly important.
              </p>
            </div>
          )}
        </section>

        <Plans db={db} showCompleted={params.show === "completed"} />
      </div>
    </div>
  );
}

function RecommendationCard({
  recommendation,
  canChat,
}: {
  recommendation: FollowThroughRecommendation;
  canChat: boolean;
}) {
  return (
    <article
      className="rounded-xl border px-5 py-5"
      style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
    >
      <p
        className="font-mono text-[0.62rem] uppercase tracking-[0.14em]"
        style={{ color: "var(--shell-faint)" }}
      >
        Best current next step · {recommendation.reason.replace(/_/gu, " ")}
      </p>
      <h2 className="mt-3 text-[1.1rem] font-medium leading-6">
        {recommendation.suggested_action}
      </h2>
      <p className="mt-3 max-w-[68ch] text-[0.84rem] leading-6" style={{ color: "var(--shell-muted)" }}>
        {recommendation.why}
      </p>
      {recommendation.requires_confirmation && (
        <p className="mt-3 font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
          Zeus may prepare the work; sending, scheduling, purchasing, or changing external state
          still requires your explicit confirmation.
        </p>
      )}

      <form action={followThroughDecisionAction} className="mt-5">
        <input type="hidden" name="id" value={recommendation.commitment_id} />
        <label className="block max-w-[34rem] text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
          Reason (optional; Zeus will store only what you write)
          <input
            name="reason"
            maxLength={1000}
            className="mt-1 block min-h-[36px] w-full rounded-md border px-2.5 text-[0.8rem]"
            style={{ background: "var(--shell-elevated)", borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3 text-[0.78rem]">
          <button
            type="submit"
            name="decision"
            value="accepted"
            disabled={!canChat}
            className="rounded-md px-3 py-1.5 font-medium disabled:opacity-50"
            style={{ background: "var(--shell-accent)", color: "#000000" }}
          >
            Help me do this
          </button>
          <button type="submit" name="decision" value="completed">Already done</button>
          <button type="submit" name="decision" value="snoozed">Not now</button>
          <button type="submit" name="decision" value="dismissed" style={{ color: "var(--shell-faint)" }}>Not useful</button>
        </div>
      </form>
      {!canChat && (
        <p className="mt-2 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
          Add an OpenAI API key to start this work in chat.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-4 font-mono text-[0.63rem]" style={{ color: "var(--shell-faint)" }}>
        <Link
          href={`/source/${recommendation.commitment_source_message_id}`}
          className="underline underline-offset-2"
        >
          source commitment
        </Link>
        {recommendation.goal_id && (
          <Link href="/today#plans" className="underline underline-offset-2">
            {recommendation.goal_priority ?? "normal"} priority goal
          </Link>
        )}
      </div>
    </article>
  );
}

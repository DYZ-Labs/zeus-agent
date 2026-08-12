import Link from "next/link";

import {
  acceptBackfillBatchAction,
  processBackfillAction,
  startBackfillAction,
} from "@/app/actions";
import { PageHeader } from "@/components/page-header";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

type BackfillJob = {
  id: number;
  status: "preview" | "running" | "completed" | "failed" | "cancelled";
  conversation_count: number;
  message_count: number;
  processed_count: number;
  last_message_id: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type EligibleHistory = {
  conversation_count: number;
  message_count: number;
};

type CandidateCounts = {
  pending: number;
  accepted: number;
  rejected: number;
  batchEligible: number;
};

export default async function UnderstandingBackfillPage() {
  const db = await requireOwnerPageDb();
  const job = db
    .prepare<[], BackfillJob>(
      `SELECT id, status, conversation_count, message_count, processed_count,
              last_message_id, error_message, created_at, updated_at, completed_at
       FROM understanding_backfill_job
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() ?? null;
  const eligible = db
    .prepare<[], EligibleHistory>(
      `SELECT COUNT(DISTINCT m.conversation_id) AS conversation_count,
              COUNT(*) AS message_count
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
       WHERE m.role = 'user'
         AND m.origin = 'conversation'
         AND m.recall_state = 'unclassified'
         AND COALESCE(c.title, '') != 'Memory curation'`,
    )
    .get() ?? { conversation_count: 0, message_count: 0 };
  const candidateCounts = job ? countsForJob(db, job.id) : null;

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title="Past-conversation review" eyebrow="Understanding" meta={jobMeta(job)} />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link
          href="/understanding"
          className="font-mono text-[0.68rem] underline underline-offset-2"
          style={{ color: "var(--shell-muted)" }}
        >
          ← back to Understanding
        </Link>

        <div className="mt-6 grid max-w-[64rem] gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <section>
            <h1 className="text-[1.15rem] font-medium leading-7">
              Review history only when you choose to
            </h1>
            <p className="mt-3 max-w-[68ch] text-[0.86rem] leading-6" style={{ color: "var(--shell-muted)" }}>
              Existing messages remain valid provenance for facts, but Zeus does not retrospectively
              classify them into understanding facets by default. This opt-in flow creates a separate,
              resumable preview.
            </p>

            <div
              className="mt-6 rounded-xl border px-5 py-5"
              style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
            >
              <h2 className="font-mono text-[0.65rem] uppercase tracking-[0.13em]" style={{ color: "var(--shell-faint)" }}>
                Before you start
              </h2>
              <ul className="mt-3 space-y-2 text-[0.82rem] leading-6" style={{ color: "var(--shell-muted)" }}>
                <li>• User-message excerpts are sent to the configured OpenAI Responses API with storage disabled.</li>
                <li>• Facet results stay in preview and do not rewrite facts or enter context before acceptance.</li>
                <li>• Successfully classified non-sensitive spans become recallable only as dated evidence passages.</li>
                <li>• Inferred and sensitive suggestions require individual confirmation.</li>
                <li>• Processing is idempotent and can resume from the last completed message.</li>
              </ul>
            </div>

            <BackfillControls job={job} eligible={eligible} candidateCounts={candidateCounts} />
          </section>

          <aside
            className="h-fit rounded-xl border px-4 py-4"
            style={{ borderColor: "var(--shell-line)", background: "var(--shell-panel)" }}
          >
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.12em]" style={{ color: "var(--shell-faint)" }}>
              Eligible history
            </p>
            <dl className="mt-4 space-y-3">
              <Metric label="conversations" value={eligible.conversation_count} />
              <Metric label="user messages" value={eligible.message_count} />
            </dl>
            <p className="mt-4 text-[0.72rem] leading-5" style={{ color: "var(--shell-faint)" }}>
              Assistant text and explicit curation actions cannot become evidence about you.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

function BackfillControls({
  job,
  eligible,
  candidateCounts,
}: {
  job: BackfillJob | null;
  eligible: EligibleHistory;
  candidateCounts: CandidateCounts | null;
}) {
  const active = job?.status === "preview" || job?.status === "running";
  const canStart = !active && eligible.message_count > 0;
  const percent = job && job.message_count > 0
    ? Math.min(100, Math.round((job.processed_count / job.message_count) * 100))
    : 0;

  return (
    <section className="mt-6 max-w-[48rem] border-t pt-6" style={{ borderColor: "var(--shell-line)" }}>
      {job && (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[0.95rem] font-medium">Latest review</h2>
            <span className="font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
              job {job.id} · {job.status}
            </span>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full"
            style={{ background: "var(--shell-line-strong)" }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={job.message_count}
            aria-valuenow={job.processed_count}
            aria-label="Historical review progress"
          >
            <span
              className="block h-full rounded-full"
              style={{ width: `${percent}%`, background: "var(--shell-accent)" }}
            />
          </div>
          <p className="mt-2 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
            {job.processed_count} of {job.message_count} messages · {percent}%
          </p>
          {candidateCounts && (
            <p className="mt-2 text-[0.76rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              {candidateCounts.pending} awaiting confirmation · {candidateCounts.accepted} accepted ·{" "}
              {candidateCounts.rejected} rejected
            </p>
          )}
          {job.error_message && (
            <p
              className="mt-3 rounded-md border px-3 py-2 text-[0.76rem] leading-5"
              style={{ borderColor: "#7f1d1d", color: "#ff9c9c" }}
            >
              Review paused: {job.error_message}
            </p>
          )}
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {active && job ? (
          <form action={processBackfillAction}>
            <input type="hidden" name="id" value={job.id} />
            <button
              type="submit"
              className="rounded-md px-3 py-2 text-[0.78rem] font-medium"
              style={{ background: "var(--shell-accent)", color: "#12100b" }}
            >
              {job.processed_count === 0 ? "Analyze first batch" : "Continue review"}
            </button>
          </form>
        ) : (
          <form action={startBackfillAction}>
            <button
              type="submit"
              disabled={!canStart}
              className="rounded-md px-3 py-2 text-[0.78rem] font-medium disabled:opacity-45"
              style={{ background: "var(--shell-accent)", color: "#12100b" }}
            >
              {job?.status === "completed" ? "Start a new preview" : "Prepare preview"}
            </button>
          </form>
        )}
        {(candidateCounts?.pending ?? 0) > 0 && (
          <Link
            href="/understanding?view=review"
            className="rounded-md border px-3 py-2 text-[0.78rem]"
            style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
          >
            Review suggestions
          </Link>
        )}
        {(candidateCounts?.batchEligible ?? 0) > 0 && job && (
          <form action={acceptBackfillBatchAction}>
            <input type="hidden" name="id" value={job.id} />
            <button
              type="submit"
              className="rounded-md border px-3 py-2 text-[0.78rem]"
              style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
            >
              Accept {candidateCounts?.batchEligible ?? 0} clear direct suggestions
            </button>
          </form>
        )}
      </div>

      {!job && eligible.message_count === 0 && (
        <p className="mt-3 text-[0.76rem]" style={{ color: "var(--shell-faint)" }}>
          There are no eligible user messages to review yet.
        </p>
      )}
    </section>
  );
}

function countsForJob(
  db: Awaited<ReturnType<typeof requireOwnerPageDb>>,
  jobId: number,
): CandidateCounts {
  const rows = db
    .prepare<[number], { status: "pending" | "accepted" | "rejected"; count: number }>(
      `SELECT status, COUNT(*) AS count
       FROM memory_candidate
       WHERE kind = 'facet' AND backfill_job_id = ?
       GROUP BY status`,
    )
    .all(jobId);
  const counts: CandidateCounts = { pending: 0, accepted: 0, rejected: 0, batchEligible: 0 };
  for (const row of rows) counts[row.status] = row.count;
  counts.batchEligible = db
    .prepare<[number], { count: number }>(
      `SELECT COUNT(*) AS count
       FROM memory_candidate
       WHERE kind = 'facet' AND backfill_job_id = ? AND status = 'pending'
         AND reason = 'backfill_preview'
         AND json_array_length(reasons_json) = 1
         AND json_extract(payload_json, '$.item.grounding') = 'user_statement'
         AND json_extract(payload_json, '$.item.explicitness') = 'explicit'
         AND json_extract(payload_json, '$.item.sensitivity') = 'normal'
         AND json_extract(payload_json, '$.item.ambiguity') = 'clear'
         AND json_extract(payload_json, '$.item.machine_effect') IS NULL`,
    )
    .get(jobId)?.count ?? 0;
  return counts;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[0.78rem]" style={{ color: "var(--shell-muted)" }}>
        {label}
      </dt>
      <dd className="font-mono text-[0.8rem] tabular-nums">{value}</dd>
    </div>
  );
}

function jobMeta(job: BackfillJob | null): string {
  if (!job) return "not started";
  if (job.status === "completed") return `completed ${job.completed_at?.slice(0, 10) ?? ""}`.trim();
  return `${job.processed_count}/${job.message_count} messages · ${job.status}`;
}

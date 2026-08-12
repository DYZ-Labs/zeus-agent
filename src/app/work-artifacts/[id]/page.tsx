import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { resourceId } from "@/core/resource-id";
import { getWorkArtifact, getWorkPlan, getWorkRun, listToolReceipts } from "@/core/work-plans";
import { requireOwnerPageDb } from "@/server/auth/access";
import { labsEnabled } from "@/server/labs";

export const dynamic = "force-dynamic";

export default async function WorkArtifactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = await requireOwnerPageDb();
  if (!labsEnabled(db)) notFound();
  const artifact = getWorkArtifact(db, id);
  if (!artifact) notFound();
  const detail = getWorkPlan(db, artifact.work_plan_id);
  const run = getWorkRun(db, artifact.work_run_id);
  const receipt = listToolReceipts(db, artifact.work_run_id).find(
    (item) => item.work_step_id === artifact.work_step_id,
  );
  const citations = parseCitations(artifact.citations_json);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title={artifact.title} meta={`${artifact.kind.replace(/_/gu, " ")} · local artifact`} />
      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link href="/today#work-plans" className="font-mono text-[0.68rem] underline underline-offset-2">
          ← bounded work
        </Link>
        <section className="mt-7 max-w-[76ch]">
          <p className="whitespace-pre-wrap text-[0.92rem] leading-7">{artifact.content}</p>
        </section>
        {citations.length > 0 && (
          <section className="mt-8 max-w-[76ch] border-t pt-5" style={{ borderColor: "var(--shell-line)" }}>
            <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
              Citations
            </h2>
            <ol className="mt-3 space-y-2 text-[0.78rem]">
              {citations.map((citation, index) => (
                <li key={`${citation.url ?? citation.messageId ?? "source"}-${index}`}>
                  {citation.url ? (
                    <a href={citation.url} rel="noreferrer" target="_blank" className="underline underline-offset-2">
                      {citation.title ?? citation.url}
                    </a>
                  ) : citation.messageId ? (
                    <Link href={`/source/${resourceId("message", citation.messageId)}`} className="underline underline-offset-2">
                      Zeus source message
                    </Link>
                  ) : (
                    "Recorded source"
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
        <section className="mt-8 max-w-[76ch] border-t pt-5 font-mono text-[0.63rem] leading-5" style={{ borderColor: "var(--shell-line)", color: "var(--shell-faint)" }}>
          <p>plan {artifact.work_plan_id} · run {artifact.work_run_id} ({run?.status ?? "unknown"}) · step {artifact.work_step_id ?? "none"}</p>
          <p>plan hash {detail?.plan.plan_hash ?? "unavailable"}</p>
          {receipt && <p>receipt {receipt.id} · {receipt.tool_name} · {receipt.status} · idempotency {receipt.idempotency_key.slice(0, 12)}…</p>}
          <p>No external action was performed.</p>
        </section>
      </div>
    </div>
  );
}

function parseCitations(value: string): Array<{
  title: string | null;
  url: string | null;
  messageId: number | null;
}> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : null;
      const messageId = typeof record.message_id === "number" ? record.message_id : null;
      if (!url && !messageId) return [];
      return [{
        title: typeof record.title === "string" ? record.title : null,
        url,
        messageId,
      }];
    });
  } catch {
    return [];
  }
}

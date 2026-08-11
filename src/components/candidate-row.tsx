import Link from "next/link";

import { acceptCandidateAction, rejectCandidateAction } from "@/app/actions";
import type { CandidateView } from "@/core/candidates";

export function CandidateRow({ candidate }: { candidate: CandidateView }) {
  return (
    <li className="border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-[0.92rem]">{candidateLabel(candidate)}</p>
          <p className="mt-1.5 font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
            {candidate.kind} · held for {candidate.reasons.join(", ")} · confidence {candidate.confidence.toFixed(2)} ·{" "}
            <Link href={`/source/${candidate.source_message_id}`} className="underline underline-offset-2">
              source
            </Link>
          </p>
          {candidate.evidence.length > 0 ? (
            <div className="mt-2 space-y-1 text-[0.78rem]" style={{ color: "var(--shell-muted)" }}>
              {candidate.evidence.map((passage) => (
                <p key={passage.id} className="line-clamp-2">
                  “{passage.text}” <span className="font-mono text-[0.62rem]">span {passage.start_offset}–{passage.end_offset}</span>
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-2 line-clamp-2 text-[0.78rem]" style={{ color: "var(--shell-muted)" }}>
              Legacy message provenance: “{candidate.source_excerpt}”
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 font-mono text-[0.68rem]">
          <form action={acceptCandidateAction}>
            <input type="hidden" name="id" value={candidate.id} />
            <button type="submit" style={{ color: "var(--shell-accent)" }}>
              accept
            </button>
          </form>
          <form action={rejectCandidateAction}>
            <input type="hidden" name="id" value={candidate.id} />
            <button type="submit" style={{ color: "var(--shell-muted)" }}>
              reject
            </button>
          </form>
        </div>
      </div>
    </li>
  );
}

function candidateLabel(candidate: CandidateView): string {
  const envelope = asRecord(candidate.payload);
  const payload = asRecord(envelope.item ?? envelope);
  if (candidate.kind === "fact" || candidate.kind === "interest") {
    return `${string(payload.subject, "Unknown")} ${string(payload.predicate, "asserts").replace(/_/gu, " ")} ${string(payload.object, "")}`;
  }
  const title = string(payload.title, "Untitled");
  const status = string(payload.status, "");
  return status ? `${title} — ${status}` : title;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

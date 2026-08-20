import Link from "next/link";

import { acceptFacetCandidateAction, rejectFacetCandidateAction } from "@/app/actions";
import type { CandidateView } from "@/core/candidates";

/**
 * The rich review affordance a proposed facet needs: editable wording, the exact evidence
 * behind it, its typed condition, and what accepting it would supersede. A fact candidate
 * carries none of that, which is why `CandidateRow` stays a separate, plainer renderer.
 */
export function FacetCandidateRow({ candidate }: { candidate: CandidateView }) {
  const envelope = asRecord(candidate.payload);
  const payload = "item" in envelope ? asRecord(envelope.item) : envelope;
  const statement = stringValue(payload.statement, "Review this proposed understanding");
  const kind = stringValue(payload.kind, "facet").replace(/_/gu, " ");
  const scope = candidateScope(payload);
  const reasons = candidateReasons(candidate);
  const conflict = conflictPreview(envelope) ?? conflictPreview(payload);
  const structuredCondition = payload.structured_condition ?? null;
  const origin = candidate.origin;

  return (
    <li className="border-b py-5" style={{ borderColor: "var(--shell-line)" }}>
      <form action={acceptFacetCandidateAction}>
        <input type="hidden" name="id" value={candidate.id} />
        <div className="flex flex-wrap items-center gap-2 font-mono text-[0.63rem]">
          <span
            className="rounded-full border px-2 py-0.5 uppercase tracking-[0.08em]"
            style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-faint)" }}
          >
            {kind}
          </span>
          <span style={{ color: "var(--shell-faint)" }}>{scope}</span>
          <span style={{ color: "var(--shell-faint)" }}>
            held for {reasons.join(" + ")} · confidence {candidate.confidence.toFixed(2)}
          </span>
          {origin === "backfill" && (
            <span style={{ color: "var(--shell-muted)" }}>historical preview</span>
          )}
        </div>

        <label htmlFor={`candidate-statement-${candidate.id}`} className="sr-only">
          Edit proposed understanding
        </label>
        <textarea
          id={`candidate-statement-${candidate.id}`}
          name="statement"
          defaultValue={statement}
          required
          rows={2}
          className="mt-3 w-full resize-y rounded-md border px-3 py-2 text-[0.92rem] leading-6"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "var(--shell-fg)",
          }}
        />

        {conflict && (
          <div
            className="mt-3 rounded-md border px-3 py-2 text-[0.76rem] leading-5"
            style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
          >
            <span className="font-medium" style={{ color: "var(--shell-fg)" }}>
              If accepted: {" "}
            </span>
            {conflict}
          </div>
        )}

        <label
          htmlFor={`candidate-condition-${candidate.id}`}
          className="mt-3 block font-mono text-[0.63rem]"
          style={{ color: "var(--shell-faint)" }}
        >
          structured condition JSON (blank means unconditional)
        </label>
        <textarea
          id={`candidate-condition-${candidate.id}`}
          name="structuredCondition"
          defaultValue={structuredCondition === null ? "" : JSON.stringify(structuredCondition, null, 2)}
          rows={3}
          className="mt-1 w-full resize-y rounded-md border px-3 py-2 font-mono text-[0.72rem] leading-5"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "var(--shell-fg)",
          }}
        />

        <CandidateEvidence candidate={candidate} />

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <label
            htmlFor={`candidate-effect-${candidate.id}`}
            className="font-mono text-[0.63rem]"
            style={{ color: "var(--shell-faint)" }}
          >
            follow-through effect
          </label>
          <select
            id={`candidate-effect-${candidate.id}`}
            name="machineEffect"
            defaultValue={machineEffectValue(payload.machine_effect)}
            className="min-h-8 rounded border px-2 text-[0.74rem]"
            style={{
              background: "var(--shell-panel)",
              borderColor: "var(--shell-line-strong)",
              color: "var(--shell-fg)",
            }}
          >
            <option value="">No ranking effect</option>
            <option value="boost">Boost matching actions</option>
            <option value="deprioritize">Deprioritize matching actions</option>
            <option value="block">Block matching actions</option>
          </select>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-[0.76rem] font-medium"
            style={{ background: "var(--shell-accent)", color: "#12100b" }}
          >
            Accept edited understanding
          </button>
          <Link
            href={`/source/${candidate.source_message_id}`}
            className="font-mono text-[0.63rem] underline underline-offset-2"
            style={{ color: "var(--shell-faint)" }}
          >
            inspect source
          </Link>
        </div>
      </form>
      <form action={rejectFacetCandidateAction} className="mt-2">
        <input type="hidden" name="id" value={candidate.id} />
        <button type="submit" className="font-mono text-[0.63rem]" style={{ color: "var(--shell-muted)" }}>
          Reject and keep out of Zeus&apos;s model
        </button>
      </form>
    </li>
  );
}

function CandidateEvidence({ candidate }: { candidate: CandidateView }) {
  if (candidate.evidence.length === 0) {
    return (
      <blockquote className="mt-3 line-clamp-3 text-[0.76rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        “{candidate.source_excerpt}”
      </blockquote>
    );
  }

  return (
    <ul className="mt-3 space-y-2">
      {candidate.evidence.map((passage) => (
        <li
          key={passage.id}
          className="rounded-md border px-3 py-2"
          style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line)" }}
        >
          <blockquote className="text-[0.76rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            “{passage.text}”
          </blockquote>
          <p className="mt-1 font-mono text-[0.6rem]" style={{ color: "var(--shell-faint)" }}>
            characters {passage.start_offset}–{passage.end_offset} ·{" "}
            <Link
              href={`/source/${passage.message_id}?passage=${passage.id}`}
              className="underline underline-offset-2"
            >
              source
            </Link>
          </p>
        </li>
      ))}
    </ul>
  );
}

function candidateReasons(candidate: CandidateView): string[] {
  const record = asRecord(candidate);
  const reasons = record.reasons;
  if (Array.isArray(reasons)) {
    const values = reasons.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (values.length > 0) return values.map((value) => value.replace(/_/gu, " "));
  }
  const encoded = record.reasons_json;
  if (typeof encoded === "string") {
    try {
      const parsed = JSON.parse(encoded) as unknown;
      if (Array.isArray(parsed)) {
        const values = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
        if (values.length > 0) return values.map((value) => value.replace(/_/gu, " "));
      }
    } catch {
      // The primary reason remains visible if an externally edited row is malformed.
    }
  }
  return [candidate.reason.replace(/_/gu, " ")];
}

function candidateScope(payload: Record<string, unknown>): string {
  const nested = asRecord(payload.scope);
  const kind = stringValue(nested.kind, stringValue(payload.scope_kind, "global"));
  if (kind === "global") return "across your life";
  if (kind === "domain") return stringValue(nested.label, stringValue(payload.scope_label, "domain"));
  return `${kind} scoped`;
}

function conflictPreview(payload: Record<string, unknown>): string | null {
  for (const key of ["conflict_preview", "conflict", "supersession_preview", "influence_preview"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (items.length > 0) return items.join("; ");
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function machineEffectValue(value: unknown): "" | "boost" | "deprioritize" | "block" {
  return value === "boost" || value === "deprioritize" || value === "block" ? value : "";
}

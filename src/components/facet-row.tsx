"use client";

import Link from "next/link";
import { useState } from "react";

import {
  closeFacetAction,
  correctFacetAction,
  forgetFacetAction,
} from "@/app/actions";
import type { FacetEvidence, UnderstandingFacetView } from "@/core/facets";

export function FacetRow({
  facet,
  evidence,
}: {
  facet: UnderstandingFacetView;
  evidence: readonly FacetEvidence[];
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const closed = facet.valid_to !== null;

  return (
    <li
      className="group border-b py-5"
      style={{ borderColor: "var(--shell-line)", opacity: closed ? 0.62 : 1 }}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-full border px-2 py-0.5 font-mono text-[0.62rem] uppercase tracking-[0.08em]"
              style={{
                borderColor: "var(--shell-line-strong)",
                color: "var(--shell-faint)",
              }}
            >
              {facet.kind.replace(/_/gu, " ")}
            </span>
            <span className="font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
              {scopeLabel(facet)}
            </span>
            {facet.sensitivity === "sensitive" && (
              <span className="font-mono text-[0.62rem]" style={{ color: "var(--shell-muted)" }}>
                sensitive · explicitly accepted
              </span>
            )}
          </div>

          {editing ? (
            <form action={correctFacetAction} className="mt-3 max-w-[48rem]">
              <input type="hidden" name="id" value={facet.id} />
              <label htmlFor={`facet-statement-${facet.id}`} className="sr-only">
                Correct this understanding
              </label>
              <textarea
                id={`facet-statement-${facet.id}`}
                name="statement"
                defaultValue={facet.statement}
                required
                autoFocus
                rows={3}
                className="w-full resize-y rounded-md border px-3 py-2 text-[0.92rem] leading-6"
                style={{
                  background: "var(--shell-panel)",
                  borderColor: "var(--shell-accent)",
                  color: "var(--shell-fg)",
                }}
              />
              <label
                htmlFor={`facet-condition-${facet.id}`}
                className="mt-3 block font-mono text-[0.65rem]"
                style={{ color: "var(--shell-faint)" }}
              >
                structured condition JSON (weekdays, local_time, zones, expires_at)
              </label>
              <textarea
                id={`facet-condition-${facet.id}`}
                name="structuredCondition"
                defaultValue={formatStructuredCondition(facet.condition_json)}
                rows={3}
                placeholder='{"weekdays":["mon","tue"],"local_time":{"start":"09:00","end":"17:00"}}'
                className="mt-1 w-full resize-y rounded-md border px-3 py-2 font-mono text-[0.72rem] leading-5"
                style={{
                  background: "var(--shell-panel)",
                  borderColor: "var(--shell-line-strong)",
                  color: "var(--shell-fg)",
                }}
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label
                  htmlFor={`facet-effect-${facet.id}`}
                  className="font-mono text-[0.65rem]"
                  style={{ color: "var(--shell-faint)" }}
                >
                  follow-through effect
                </label>
                <select
                  id={`facet-effect-${facet.id}`}
                  name="machineEffect"
                  defaultValue={facet.machine_effect ?? ""}
                  className="min-h-8 rounded border px-2 text-[0.76rem]"
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
                  className="text-[0.78rem] font-medium"
                  style={{ color: "var(--shell-accent)" }}
                >
                  Save correction
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="text-[0.78rem]"
                  style={{ color: "var(--shell-faint)" }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <p className="mt-3 max-w-[72ch] text-[0.96rem] leading-6">{facet.statement}</p>
          )}

          {facet.condition_text && (
            <p className="mt-1.5 text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              Applies when {facet.condition_text}
            </p>
          )}
          {facet.condition_json ? (
            <pre
              className="mt-1.5 max-w-[48rem] overflow-x-auto rounded-md px-2 py-1.5 text-[0.68rem] leading-5"
              style={{ background: "var(--shell-elevated)", color: "var(--shell-muted)" }}
            >
              {formatStructuredCondition(facet.condition_json)}
            </pre>
          ) : facet.condition_text && facet.machine_effect ? (
            <p className="mt-1.5 text-[0.76rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              This legacy conditional ranking effect is inactive until you correct it with a
              structured condition.
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.64rem]">
            <span style={{ color: "var(--shell-faint)" }}>
              effective {facet.valid_from.slice(0, 10)}
            </span>
            {closed && (
              <span style={{ color: "var(--shell-faint)" }}>
                ended {facet.valid_to?.slice(0, 10)}
              </span>
            )}
            <span style={{ color: "var(--shell-faint)" }}>{facet.importance} importance</span>
            <Confidence value={facet.confidence} />
            {facet.machine_effect && (
              <span style={{ color: "var(--shell-muted)" }}>
                {facet.machine_effect.replace(/_/gu, " ")} matching follow-through
              </span>
            )}
          </div>

          <Evidence evidence={evidence} fallbackSourceId={facet.source_message_id} />
        </div>

        {!editing && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 font-mono text-[0.66rem] opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {!closed && (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  style={{ color: "var(--shell-muted)" }}
                >
                  correct
                </button>
                <form action={closeFacetAction}>
                  <input type="hidden" name="id" value={facet.id} />
                  <button type="submit" style={{ color: "var(--shell-muted)" }}>
                    no longer applies
                  </button>
                </form>
              </>
            )}
            {confirmingForget ? (
              <form action={forgetFacetAction} className="flex items-center gap-2">
                <input type="hidden" name="id" value={facet.id} />
                <button type="submit" style={{ color: "var(--shell-accent)" }}>
                  confirm forget
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingForget(false)}
                  style={{ color: "var(--shell-faint)" }}
                >
                  keep
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingForget(true)}
                style={{ color: "var(--shell-muted)" }}
              >
                forget
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function formatStructuredCondition(value: string | null): string {
  if (!value) return "";
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

function Evidence({
  evidence,
  fallbackSourceId,
}: {
  evidence: readonly FacetEvidence[];
  fallbackSourceId: number;
}) {
  if (evidence.length === 0) {
    return (
      <Link
        href={`/source/${fallbackSourceId}`}
        className="mt-3 inline-block font-mono text-[0.64rem] underline underline-offset-2"
        style={{ color: "var(--shell-faint)" }}
      >
        source message
      </Link>
    );
  }

  return (
    <details className="mt-3 max-w-[48rem]">
      <summary
        className="cursor-pointer font-mono text-[0.64rem]"
        style={{ color: "var(--shell-faint)" }}
      >
        {evidence.length} evidence {evidence.length === 1 ? "passage" : "passages"}
      </summary>
      <ul className="mt-2 space-y-2">
        {evidence.map((item) => (
          <li
            key={item.id}
            className="rounded-md border px-3 py-2"
            style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line)" }}
          >
            <blockquote className="text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              “{item.quote}”
            </blockquote>
            <p className="mt-1.5 font-mono text-[0.6rem]" style={{ color: "var(--shell-faint)" }}>
              {item.kind.replace(/_/gu, " ")} · characters {item.start_offset}–{item.end_offset} ·{" "}
              <Link
                href={`/source/${item.source_message_id}`}
                className="underline underline-offset-2"
              >
                source
              </Link>
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function scopeLabel(facet: UnderstandingFacetView): string {
  if (facet.scope_kind === "global") return "across your life";
  if (facet.scope_kind === "domain") return facet.scope_label ?? "domain";
  if (facet.scope_kind === "entity") return facet.scope_entity_name ?? "relationship";
  if (facet.scope_kind === "goal") return facet.scope_goal_title ?? "goal";
  return facet.scope_commitment_title ?? "commitment";
}

function Confidence({ value }: { value: number }) {
  const filled = Math.max(1, Math.round(value * 4));

  return (
    <span
      className="inline-flex items-center gap-1"
      title={`confidence ${value.toFixed(2)}`}
      style={{ color: "var(--shell-faint)" }}
    >
      <span aria-hidden className="inline-flex gap-[2px]">
        {[0, 1, 2, 3].map((index) => (
          <span
            key={index}
            className="inline-block h-[8px] w-[3px]"
            style={{
              background: index < filled ? "var(--shell-accent)" : "var(--shell-line-strong)",
            }}
          />
        ))}
      </span>
      <span className="sr-only">confidence {value.toFixed(2)}</span>
    </span>
  );
}

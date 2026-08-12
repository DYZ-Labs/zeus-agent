"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type {
  EffectKind,
  WorkArtifact,
  WorkPlan,
  WorkRun,
  WorkStep,
  ToolReceipt,
} from "@/core/schema";

export type WorkPlanPanelItem = {
  plan: WorkPlan;
  steps: Array<WorkStep & { depends_on: number[] }>;
  latestRun: WorkRun | null;
  artifacts: WorkArtifact[];
  receipts: ToolReceipt[];
  needsReauthorization: boolean;
};

export function WorkPlansPanel({
  items,
  canExecute,
}: {
  items: WorkPlanPanelItem[];
  canExecute: boolean;
}) {
  const router = useRouter();
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createPlan() {
    const requested = objective.trim();
    if (!requested || busy) return;
    setBusy("create");
    setError(null);
    try {
      await requestJson("/api/work-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective: requested }),
      });
      setObjective("");
      router.refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  }

  async function runPlan(planId: number) {
    setBusy(`run-${planId}`);
    setError(null);
    try {
      await requestJson(`/api/work-plans/${planId}/run`, { method: "POST" });
      router.refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  }

  async function authorizePlan(item: WorkPlanPanelItem) {
    setBusy(`authorize-${item.plan.id}`);
    setError(null);
    try {
      await requestJson(`/api/work-plans/${item.plan.id}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planHash: item.plan.plan_hash,
          allowedEffects: parseEffects(item.plan.allowed_effects_json),
          maxModelToolCalls: item.plan.max_model_tool_calls,
          maxRetriesPerStep: item.plan.max_retries_per_step,
          maxDurationSeconds: item.plan.max_duration_seconds,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          userInstruction: `I approve bounded work plan ${item.plan.plan_hash}.`,
        }),
      });
      router.refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  }

  async function cancelPlan(planId: number) {
    setBusy(`cancel-${planId}`);
    setError(null);
    try {
      await requestJson(`/api/work-plans/${planId}`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="work-plans" className="mt-10 max-w-[54rem] scroll-mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[1rem] font-medium">Bounded work</h2>
          <p className="mt-1 max-w-[68ch] text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            Resumable plans can recall accepted memory, research the web read-only, and prepare
            local drafts or reports. They cannot send, schedule, purchase, or modify anything
            outside Zeus.
          </p>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-2 rounded-xl border p-4 sm:flex-row"
        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
        onSubmit={(event) => {
          event.preventDefault();
          void createPlan();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Bounded work objective</span>
          <input
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            maxLength={2000}
            disabled={!canExecute || busy !== null}
            placeholder="Research the options and draft a recommendation"
            className="min-h-10 w-full rounded-lg border px-3 text-[0.85rem]"
            style={{
              background: "var(--shell-elevated)",
              borderColor: "var(--shell-line-strong)",
              color: "var(--shell-fg)",
            }}
          />
        </label>
        <button
          type="submit"
          disabled={!canExecute || !objective.trim() || busy !== null}
          className="min-h-10 rounded-lg px-4 text-[0.8rem] font-medium disabled:opacity-50"
          style={{ background: "var(--shell-accent)", color: "#000000" }}
        >
          {busy === "create" ? "Planning…" : "Create plan"}
        </button>
      </form>
      {!canExecute && (
        <p className="mt-2 text-[0.72rem]" style={{ color: "var(--shell-faint)" }}>
          Add an OpenAI API key to generate and run bounded work.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[0.78rem]" style={{ color: "#f3a6a6" }}>
          {error}
        </p>
      )}

      {items.length > 0 ? (
        <ol className="mt-5 space-y-3">
          {items.map((item) => (
            <WorkPlanRow
              key={item.plan.id}
              item={item}
              busy={busy}
              canExecute={canExecute}
              onAuthorize={authorizePlan}
              onRun={runPlan}
              onCancel={cancelPlan}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-5 text-[0.8rem]" style={{ color: "var(--shell-faint)" }}>
          No bounded work plans yet.
        </p>
      )}
    </section>
  );
}

function WorkPlanRow({
  item,
  busy,
  canExecute,
  onAuthorize,
  onRun,
  onCancel,
}: {
  item: WorkPlanPanelItem;
  busy: string | null;
  canExecute: boolean;
  onAuthorize: (item: WorkPlanPanelItem) => Promise<void>;
  onRun: (id: number) => Promise<void>;
  onCancel: (id: number) => Promise<void>;
}) {
  const closed = ["completed", "cancelled"].includes(item.plan.status);
  const canRun = ["authorized", "running", "paused"].includes(item.plan.status) &&
    !item.needsReauthorization;
  return (
    <li
      className="rounded-xl border px-4 py-4"
      style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[0.9rem] font-medium">{item.plan.objective}</p>
          <p className="mt-1 font-mono text-[0.61rem]" style={{ color: "var(--shell-faint)" }}>
            plan {item.plan.id} · {item.plan.status} · hash {item.plan.plan_hash.slice(0, 12)}… ·{" "}
            {item.plan.origin.replace(/_/gu, " ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-[0.74rem]">
          {(item.plan.status === "proposed" || item.needsReauthorization) && (
            <button
              type="button"
              disabled={!canExecute || busy !== null}
              onClick={() => void onAuthorize(item)}
            >
              {item.needsReauthorization ? "Reapprove exact plan" : "Approve exact plan"}
            </button>
          )}
          {canRun && (
            <button
              type="button"
              disabled={!canExecute || busy !== null}
              onClick={() => void onRun(item.plan.id)}
              className="font-medium"
              style={{ color: "var(--shell-accent)" }}
            >
              {item.latestRun ? "Resume" : "Run"}
            </button>
          )}
          {!closed && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void onCancel(item.plan.id)}
              style={{ color: "var(--shell-faint)" }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <ol className="mt-3 space-y-1.5">
        {item.steps.map((step) => (
          <li key={step.id} className="flex gap-2 text-[0.76rem] leading-5">
            <span className="font-mono text-[0.61rem]" style={{ color: "var(--shell-faint)" }}>
              {step.position}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block">{step.title}</span>
              <span className="block text-[0.7rem]" style={{ color: "var(--shell-muted)" }}>
                {step.instruction}
              </span>
              <span className="font-mono text-[0.59rem]" style={{ color: "var(--shell-faint)" }}>
                {step.effect_kind.replace(/_/gu, " ")} · {step.status}
                {step.depends_on.length > 0 ? ` · after ${step.depends_on.join(", ")}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <details className="mt-3 rounded-lg border px-3 py-2" style={{ borderColor: "var(--shell-line)" }}>
        <summary className="cursor-pointer text-[0.72rem]">Exact authorization scope</summary>
        <dl className="mt-2 space-y-1 text-[0.68rem] leading-5" style={{ color: "var(--shell-muted)" }}>
          <div>
            <dt className="inline">Plan hash: </dt>
            <dd className="inline break-all font-mono">{item.plan.plan_hash}</dd>
          </div>
          <div>
            <dt className="inline">Allowed effects: </dt>
            <dd className="inline">{parseEffects(item.plan.allowed_effects_json).join(", ")}</dd>
          </div>
          <div>
            <dt className="inline">Limits: </dt>
            <dd className="inline">
              {item.plan.max_model_tool_calls} model/tool calls · {item.plan.max_retries_per_step}{" "}
              retries per step · {item.plan.max_duration_seconds} seconds
            </dd>
          </div>
          <div>
            <dt className="inline">Completion: </dt>
            <dd className="inline">{parseStrings(item.plan.completion_criteria_json).join("; ")}</dd>
          </div>
        </dl>
      </details>

      {item.latestRun && (
        <p className="mt-3 text-[0.7rem]" style={{ color: "var(--shell-muted)" }}>
          Run {item.latestRun.id}: {item.latestRun.status} ·{" "}
          {item.latestRun.model_call_count} model / {item.latestRun.tool_call_count} tool calls
          {item.latestRun.error_code ? ` · ${item.latestRun.error_code}` : ""}
        </p>
      )}
      {item.artifacts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.74rem]">
          {item.artifacts.map((artifact) => (
            <a
              key={artifact.id}
              href={`/work-artifacts/${artifact.id}`}
              className="underline underline-offset-2"
            >
              {artifact.title}
            </a>
          ))}
        </div>
      )}
      {item.receipts.length > 0 && (
        <details
          className="mt-3 rounded-lg border px-3 py-2"
          style={{ borderColor: "var(--shell-line)" }}
        >
          <summary className="cursor-pointer text-[0.72rem]">
            Review {item.receipts.length} tool receipt{item.receipts.length === 1 ? "" : "s"}
          </summary>
          <ol className="mt-3 space-y-3">
            {item.receipts.map((receipt) => (
              <li key={receipt.id} className="text-[0.68rem] leading-5">
                <p>
                  <span className="font-medium">{receipt.tool_name.replace(/_/gu, " ")}</span>{" "}
                  <span className="font-mono" style={{ color: "var(--shell-faint)" }}>
                    receipt {receipt.id} · {receipt.status} · call {receipt.call_index}
                  </span>
                </p>
                {receipt.error_code && (
                  <p style={{ color: "#f3a6a6" }}>
                    {receipt.error_code}{receipt.error_message ? `: ${receipt.error_message}` : ""}
                  </p>
                )}
                <details className="mt-1">
                  <summary className="cursor-pointer" style={{ color: "var(--shell-faint)" }}>
                    Sanitized inputs and outputs
                  </summary>
                  <pre
                    className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-[0.61rem]"
                    style={{ background: "var(--shell-elevated)", color: "var(--shell-muted)" }}
                  >
                    {formatReceipt(receipt)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "The bounded work request failed.");
  return body;
}

function parseEffects(value: string): EffectKind[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (effect): effect is EffectKind =>
            effect === "memory_read" || effect === "web_read" || effect === "prepare_local",
        )
      : [];
  } catch {
    return [];
  }
}

function parseStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function messageFor(value: unknown): string {
  return value instanceof Error ? value.message : "The bounded work request failed.";
}

function formatReceipt(receipt: ToolReceipt): string {
  return JSON.stringify(
    {
      input: parseJson(receipt.input_json),
      output: parseJson(receipt.output_json),
      citations: parseJson(receipt.citations_json),
    },
    null,
    2,
  );
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return "[unavailable]";
  }
}

import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { getMessage } from "@/core/conversations";
import type { IntentFieldProvenance } from "@/core/context";
import { getExperienceSettings } from "@/core/experience";
import { numericResourceId, resourceId } from "@/core/resource-id";
import {
  responseSelectionsForResponse,
  type ResponseContextSelection,
} from "@/core/response-context";
import type { RecallItem } from "@/core/schema";
import { recommendationsForResponse } from "@/core/stewardship";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

export default async function ResponseSourcesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = numericResourceId((await params).id, "message");
  if (id === null) notFound();
  const db = await requireOwnerPageDb();
  const message = getMessage(db, id);
  if (!message || message.role !== "assistant") notFound();
  const selections = responseSelectionsForResponse(db, id);
  const recommendations = recommendationsForResponse(db, id);
  const labsEnabled = getExperienceSettings(db).labsEnabled;

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Why Zeus said this"
        meta={selections.length === 0 ? "No remembered details were used" : `${selections.length} remembered detail${selections.length === 1 ? "" : "s"} used`}
      />
      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link href="/" className="font-mono text-[0.68rem] underline underline-offset-2" style={{ color: "var(--shell-muted)" }}>
          ← chat
        </Link>

        <section className="mt-7 rounded-[6px] border px-5 py-4" style={{ borderColor: "var(--shell-line-strong)" }}>
          <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
            Zeus answered
          </h2>
          <p className="mt-3 whitespace-pre-wrap text-[0.92rem]">{message.content}</p>
        </section>

        {recommendations.length > 0 && (
          <section className="mt-9">
            <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
            Suggestion shown with this answer
            </h2>
            <ol className="mt-2">
              {recommendations.map((recommendation) => (
                <li key={recommendation.commitment_id} className="border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
                  <p className="text-[0.9rem]">{recommendation.suggested_action}</p>
                  <p className="mt-1.5 text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
                    {recommendation.why}
                  </p>
                  <p className="mt-1.5 text-xs" style={{ color: "var(--shell-faint)" }}>
                    This was a suggestion, not something Zeus saved about you. ·{" "}
                    <Link href={`/source/${resourceId("message", recommendation.commitment_source_message_id)}`} className="underline underline-offset-2">
                      Why it was suggested
                    </Link>
                  </p>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="mt-9">
          <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
            Remembered details used
          </h2>
          {selections.length ? (
            <ol className="mt-2">
              {selections.map((selection) => (
                <RecallRow
                  key={key(selection.item)}
                  item={selection.item}
                  selection={selection}
                  technical={labsEnabled}
                />
              ))}
            </ol>
          ) : (
            <p className="mt-4 text-[0.88rem]" style={{ color: "var(--shell-muted)" }}>
              No memory was supplied to this response.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function RecallRow({
  item,
  selection,
  technical,
}: {
  item: RecallItem;
  selection: ResponseContextSelection;
  technical: boolean;
}) {
  let title: string;
  let detail: string;
  let source: number | null = null;
  let sourcePassage: number | null = null;
  if (item.kind === "fact") {
    title = `${item.fact.subject_slug === "self" ? "You" : item.fact.subject_name} ${item.fact.predicate.replace(/_/gu, " ")} ${item.fact.object}`;
    detail = item.fact.valid_to ? "A detail from your history" : "A saved detail";
    source = item.fact.source_message_id;
  } else if (item.kind === "episode") {
    title = `“${item.episode.excerpt}”`;
    detail = `Something you said on ${item.episode.message.created_at.slice(0, 10)}`;
    source = item.episode.message.id;
    sourcePassage = item.episode.passage_id;
  } else if (item.kind === "goal") {
    title = item.goal.title;
    detail = `Goal · ${friendlyStatus(item.goal.status)}${item.goal.target_at ? ` · by ${item.goal.target_at.slice(0, 10)}` : ""}`;
    source = item.goal.source_message_id;
  } else if (item.kind === "commitment") {
    title = item.commitment.title;
    detail = `Plan · ${friendlyStatus(item.commitment.status)}${item.commitment.due_at ? ` · by ${item.commitment.due_at.slice(0, 10)}` : ""}`;
    source = item.commitment.source_message_id;
  } else if (item.kind === "project") {
    title = item.project.entity_name;
    detail = `Project · ${friendlyStatus(item.project.status)}${item.project.progress_percent === null ? "" : ` · ${Math.round(item.project.progress_percent * 100)}% complete`}${item.project.blocked_at ? " · blocked" : ""}`;
    source = item.project.source_message_id;
  } else {
    title = item.facet.statement;
    detail = `Helpful context${facetScope(item) === "global" ? "" : ` · ${facetScope(item)}`}`;
    source = item.evidence[0]?.source_message_id ?? item.facet.source_message_id;
  }

  return (
    <li className="flex gap-3 border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
      <span className="font-mono text-[0.63rem]" style={{ color: "var(--shell-faint)" }}>
        {selection.rank + 1}
      </span>
      <div className="min-w-0">
        <p className="text-[0.9rem]">{title}</p>
        <p className="mt-1 font-mono text-[0.64rem]" style={{ color: "var(--shell-faint)" }}>
          {detail}
          {source !== null && (
            <>
              {" · "}
              <Link
                href={`/source/${resourceId("message", source)}${sourcePassage === null ? "" : `?passage=${resourceId("passage", sourcePassage)}`}`}
                className="underline underline-offset-2"
              >
                source
              </Link>
            </>
          )}
        </p>
        {technical && (
          <details className="mt-2 text-xs" style={{ color: "var(--shell-faint)" }}>
            <summary className="cursor-pointer">Technical details</summary>
            <p className="mt-1">
              Selected because {selection.reason.replace(/_/gu, " ")}
              {selection.via.length > 0 ? ` · via ${selection.via.join(" + ")}` : ""}
              {selection.score > 0 ? ` · score ${selection.score.toFixed(2)}` : ""}
            </p>
            {selection.fieldProvenance && <FieldSources provenance={selection.fieldProvenance} />}
          </details>
        )}
      </div>
    </li>
  );
}

function key(item: RecallItem): string {
  return item.kind === "fact"
    ? `fact-${item.fact.id}`
    : item.kind === "episode"
      ? `episode-${item.episode.passage_id ?? `legacy-message-${item.episode.message.id}`}`
      : item.kind === "goal"
        ? `goal-${item.goal.id}`
        : item.kind === "commitment"
          ? `commitment-${item.commitment.id}`
          : item.kind === "project"
            ? `project-${item.project.id}`
            : `facet-${item.facet.id}`;
}

function FieldSources({ provenance }: { provenance: IntentFieldProvenance }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.59rem]" style={{ color: "var(--shell-faint)" }}>
      <span>current field sources:</span>
      {Object.entries(provenance.fields).map(([field, source]) => (
        <span key={field}>
          {field.replace(/_/gu, " ")} {source.source_message_id === null ? (
            <span>· {source.source_kind.replace(/_/gu, " ")}</span>
          ) : (
            <Link
              href={`/source/${resourceId("message", source.source_message_id)}${source.passage_id ? `?passage=${resourceId("passage", source.passage_id)}` : ""}`}
              className="underline underline-offset-2"
            >
              · source
            </Link>
          )}
        </span>
      ))}
    </div>
  );
}

function facetScope(item: Extract<RecallItem, { kind: "facet" }>): string {
  if (item.facet.scope_kind === "global") return "global";
  if (item.facet.scope_kind === "domain") return item.facet.scope_label ?? "domain";
  if (item.facet.scope_kind === "entity") return item.facet.scope_entity_name ?? "entity";
  if (item.facet.scope_kind === "goal") return item.facet.scope_goal_title ?? "goal";
  return item.facet.scope_commitment_title ?? "commitment";
}

function friendlyStatus(value: string): string {
  const labels: Record<string, string> = {
    abandoned: "Stopped",
    achieved: "Done",
    active: "Active",
    cancelled: "Stopped",
    completed: "Done",
    done: "Done",
    open: "In progress",
    paused: "Paused",
    planned: "Planned",
    waiting: "Waiting on someone",
  };
  return labels[value] ?? value.replace(/_/gu, " ");
}

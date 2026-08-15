import Link from "next/link";
import { notFound } from "next/navigation";

import { AssistantProse } from "@/components/assistant-prose";
import { PageHeader } from "@/components/page-header";
import { getMessage } from "@/core/conversations";
import type { IntentFieldProvenance } from "@/core/context";
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
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const db = await requireOwnerPageDb();
  const message = getMessage(db, id);
  if (!message || message.role !== "assistant") notFound();
  const selections = responseSelectionsForResponse(db, id);
  const recommendations = recommendationsForResponse(db, id);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Response sources"
        meta={`${selections.length} memory items · ${recommendations.length} follow-through proposal${recommendations.length === 1 ? "" : "s"}`}
      />
      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link href="/" className="font-mono text-[0.68rem] underline underline-offset-2" style={{ color: "var(--shell-muted)" }}>
          ← chat
        </Link>

        <section className="mt-7 rounded-[6px] border px-5 py-4" style={{ borderColor: "var(--shell-line-strong)" }}>
          <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
            Zeus answered
          </h2>
          <AssistantProse
            text={message.content}
            className="mt-3"
            paragraphClassName="text-[0.92rem]"
          />
        </section>

        {recommendations.length > 0 && (
          <section className="mt-9">
            <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
              Follow-through proposal supplied
            </h2>
            <ol className="mt-2">
              {recommendations.map((recommendation) => (
                <li key={recommendation.commitment_id} className="border-b py-4" style={{ borderColor: "var(--shell-line)" }}>
                  <p className="text-[0.9rem]">{recommendation.suggested_action}</p>
                  <p className="mt-1.5 text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
                    {recommendation.why}
                  </p>
                  <p className="mt-1.5 font-mono text-[0.63rem]" style={{ color: "var(--shell-faint)" }}>
                    system proposal · {recommendation.reason.replace(/_/gu, " ")} · not canonical memory ·{" "}
                    <Link href={`/source/${recommendation.commitment_source_message_id}`} className="underline underline-offset-2">
                      commitment source
                    </Link>
                  </p>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="mt-9">
          <h2 className="font-mono text-[0.64rem] uppercase tracking-[0.14em]" style={{ color: "var(--shell-faint)" }}>
            Memory supplied to that answer
          </h2>
          {selections.length ? (
            <ol className="mt-2">
              {selections.map((selection) => (
                <RecallRow
                  key={key(selection.item)}
                  item={selection.item}
                  selection={selection}
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
}: {
  item: RecallItem;
  selection: ResponseContextSelection;
}) {
  let title: string;
  let detail: string;
  let source: number | null = null;
  let sourcePassage: number | null = null;
  if (item.kind === "fact") {
    title = `${item.fact.subject_slug === "self" ? "You" : item.fact.subject_name} ${item.fact.predicate.replace(/_/gu, " ")} ${item.fact.object}`;
    detail = `canonical fact · ${item.evidence.length} evidence source${item.evidence.length === 1 ? "" : "s"}`;
    source = item.fact.source_message_id;
  } else if (item.kind === "episode") {
    title = `“${item.episode.excerpt}”`;
    const passage = item.episode.passage_id === null
      ? "legacy episode"
      : `passage ${item.episode.passage_id}`;
    const offsets = item.episode.start_offset === null || item.episode.end_offset === null
      ? ""
      : ` · offsets ${item.episode.start_offset}-${item.episode.end_offset}`;
    detail = `dated episode · ${item.episode.message.created_at.slice(0, 10)} · ${passage}${offsets}`;
    source = item.episode.message.id;
    sourcePassage = item.episode.passage_id;
  } else if (item.kind === "goal") {
    title = item.goal.title;
    detail = `goal · ${item.goal.status} · ${item.goal.priority} priority${item.goal.target_at ? ` · target ${item.goal.target_at.slice(0, 10)}` : ""}`;
    source = item.goal.source_message_id;
  } else if (item.kind === "commitment") {
    title = item.commitment.title;
    detail = `commitment · ${item.commitment.status}${item.commitment.due_at ? ` · due ${item.commitment.due_at.slice(0, 10)}` : ""}`;
    source = item.commitment.source_message_id;
  } else if (item.kind === "project") {
    title = item.project.entity_name;
    detail = `project · ${item.project.status}${item.project.progress_percent === null ? "" : ` · ${Math.round(item.project.progress_percent * 100)}% complete`}${item.project.blocked_at ? " · blocked" : ""}`;
    source = item.project.source_message_id;
  } else {
    title = item.facet.statement;
    detail = `${item.facet.kind.replace(/_/gu, " ")} facet · ${facetScope(item)} · confidence ${item.facet.confidence.toFixed(2)} · ${item.evidence.length} evidence passage${item.evidence.length === 1 ? "" : "s"}`;
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
                href={`/source/${source}${sourcePassage === null ? "" : `?passage=${sourcePassage}`}`}
                className="underline underline-offset-2"
              >
                source
              </Link>
            </>
          )}
        </p>
        <p className="mt-1 font-mono text-[0.61rem]" style={{ color: "var(--shell-muted)" }}>
          selected because {selection.reason.replace(/_/gu, " ")}
          {selection.via.length > 0 ? ` · via ${selection.via.join(" + ")}` : ""}
          {selection.score > 0 ? ` · score ${selection.score.toFixed(2)}` : ""}
          {selection.estimated_tokens > 0 ? ` · ~${selection.estimated_tokens} tokens` : ""}
        </p>
        {selection.fieldProvenance && (
          <FieldSources provenance={selection.fieldProvenance} />
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
              href={`/source/${source.source_message_id}${source.passage_id ? `?passage=${source.passage_id}` : ""}`}
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

import Link from "next/link";

import { CandidateRow } from "@/components/candidate-row";
import { FactRow } from "@/components/fact-row";
import { PageHeader } from "@/components/page-header";
import { countPendingCandidates, listCandidates } from "@/core/candidates";
import { listEntities } from "@/core/entities";
import { countFacts, timeline } from "@/core/facts";
import type { FactView } from "@/core/schema";
import { search } from "@/core/search";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; show?: string }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const includeSuperseded = params.show === "all";
  const showPending = params.show === "pending";

  const db = getDb();
  const counts = countFacts(db);
  const pendingCount = countPendingCandidates(db);
  const candidates = showPending ? listCandidates(db, { status: "pending", limit: 200 }) : [];
  const entities = listEntities(db, { limit: 400 }).filter((entity) => entity.slug !== "self");

  const facts: FactView[] = query
    ? (await search(db, query, { limit: 100, includeSuperseded })).map((hit) => hit.fact)
    : timeline(db, { limit: 100 }).filter((fact) => includeSuperseded || fact.valid_to === null);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Memory"
        meta={`${counts.live} live · ${counts.superseded} superseded · ${pendingCount} pending`}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <form method="get" className="flex flex-wrap items-center gap-3">
          <label htmlFor="q" className="sr-only">
            Search memory
          </label>
          <input
            id="q"
            name="q"
            defaultValue={query}
            placeholder="Search what Zeus knows"
            className="min-h-[40px] min-w-0 flex-1 rounded-[4px] border px-3 text-[0.92rem]"
            style={{
              background: "var(--shell-panel)",
              borderColor: "var(--shell-line-strong)",
              color: "var(--shell-fg)",
            }}
          />
          {(includeSuperseded || showPending) && (
            <input type="hidden" name="show" value={showPending ? "pending" : "all"} />
          )}
          <button
            type="submit"
            className="min-h-[40px] rounded-[4px] px-4 text-[0.85rem] font-medium"
            style={{ background: "var(--shell-accent)", color: "#12100b" }}
          >
            Search
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-4 font-mono text-[0.68rem]">
          <Link
            href={buildHref(query, includeSuperseded ? null : "all")}
            className="underline underline-offset-2"
            style={{ color: "var(--shell-muted)" }}
          >
            {includeSuperseded ? "hide superseded" : "include superseded"}
          </Link>
          <Link
            href={buildHref("", showPending ? null : "pending")}
            className="underline underline-offset-2"
            style={{ color: showPending ? "var(--shell-accent)" : "var(--shell-muted)" }}
          >
            {showPending ? "show accepted" : `review pending (${pendingCount})`}
          </Link>
          {query && (
            <Link
              href={buildHref("", showPending ? "pending" : includeSuperseded ? "all" : null)}
              className="underline underline-offset-2"
              style={{ color: "var(--shell-muted)" }}
            >
              clear search
            </Link>
          )}
        </div>

        {entities.length > 0 && (
          <section className="mt-8">
            <SectionLabel>Entities</SectionLabel>
            <ul className="mt-3 flex flex-wrap gap-2">
              {entities.map((entity) => (
                <li key={entity.id}>
                  <Link
                    href={`/entity/${entity.slug}`}
                    className="inline-flex items-center gap-2 rounded-[3px] border px-2.5 py-1.5 text-[0.84rem] transition-colors duration-150 ease-out"
                    style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-fg)" }}
                  >
                    {entity.name}
                    <span className="font-mono text-[0.62rem]" style={{ color: "var(--shell-faint)" }}>
                      {entity.kind}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {showPending ? (
          <section className="mt-9">
            <SectionLabel>Pending review</SectionLabel>
            {candidates.length > 0 ? (
              <ul className="mt-2">
                {candidates.map((candidate) => (
                  <CandidateRow key={candidate.id} candidate={candidate} />
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-[0.9rem]" style={{ color: "var(--shell-muted)" }}>
                Nothing is waiting for review.
              </p>
            )}
          </section>
        ) : (
          <section className="mt-9">
            <SectionLabel>{query ? `Results for “${query}”` : "Facts"}</SectionLabel>

            {facts.length === 0 ? (
              <EmptyMemory query={query} hasAnything={counts.live + counts.superseded > 0} />
            ) : (
              <ul className="mt-2">
                {facts.map((fact) => (
                  <FactRow key={fact.id} fact={fact} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function buildHref(query: string, show: "all" | "pending" | null): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (show) params.set("show", show);
  const suffix = params.toString();
  return suffix ? `/memory?${suffix}` : "/memory";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="font-mono text-[0.65rem] uppercase tracking-[0.14em]"
      style={{ color: "var(--shell-faint)" }}
    >
      {children}
    </h2>
  );
}

function EmptyMemory({ query, hasAnything }: { query: string; hasAnything: boolean }) {
  return (
    <div
      className="mt-4 rounded-[6px] border border-dashed px-5 py-6"
      style={{ borderColor: "var(--shell-line-strong)" }}
    >
      {query ? (
        <>
          <p className="text-[0.93rem]">Nothing here matches that.</p>
          <p className="mt-1.5 text-[0.87rem]" style={{ color: "var(--shell-muted)" }}>
            Zeus only answers from what it holds, so an empty result here is exactly what
            it would tell you in chat.
          </p>
        </>
      ) : hasAnything ? (
        <p className="text-[0.93rem]">
          Every fact is superseded.{" "}
          <Link href="/memory?show=all" className="underline underline-offset-2">
            Include superseded
          </Link>{" "}
          to see the history.
        </p>
      ) : (
        <>
          <p className="text-[0.93rem]">Zeus has not learned anything yet.</p>
          <p className="mt-1.5 text-[0.87rem]" style={{ color: "var(--shell-muted)" }}>
            <Link href="/" className="underline underline-offset-2">
              Start a conversation
            </Link>{" "}
            and facts will appear here as it distils them, each with its source.
          </p>
        </>
      )}
    </div>
  );
}

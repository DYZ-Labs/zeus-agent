import Link from "next/link";

import { CandidateRow } from "@/components/candidate-row";
import { FacetCandidateRow } from "@/components/facet-candidate-row";
import { FacetRow } from "@/components/facet-row";
import { FactRow } from "@/components/fact-row";
import { PageHeader } from "@/components/page-header";
import { listPendingReview, type CandidateView } from "@/core/candidates";
import type { Db } from "@/core/db";
import { listEntities } from "@/core/entities";
import {
  evidenceForFacet,
  listFacets,
  searchFacets,
  type UnderstandingFacetView,
} from "@/core/facets";
import { countFacts, timeline } from "@/core/facts";
import type { FactView } from "@/core/schema";
import { search } from "@/core/search";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

type AboutYouView = "current" | "review" | "history";

/** One screenful of review at a time. The header always states the true pending total. */
const REVIEW_LIMIT = 200;

export default async function AboutYouPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string; show?: string }>;
}) {
  const params = await searchParams;
  const view = parseView(params);
  const query = view === "review" ? "" : params.q?.trim() ?? "";

  const db = await requireOwnerPageDb();
  const factCounts = countFacts(db);
  const allFacets = listFacets(db, { includeClosed: true, limit: 10_000 });
  const currentFacets = allFacets.filter((facet) => facet.valid_to === null);
  const historicalFacets = allFacets.filter((facet) => facet.valid_to !== null);

  // One read for the badge and the rows, so they cannot disagree the way two pages
  // counting the same table did.
  const review = listPendingReview(db, view === "review" ? REVIEW_LIMIT : 0);

  const entities =
    view === "current"
      ? listEntities(db, { limit: 400 }).filter((entity) => entity.slug !== "self")
      : [];

  const shownFacets = await selectFacets(db, view, query, currentFacets, historicalFacets);
  const shownFacts = await selectFacts(db, view, query);
  const evidenceByFacet = new Map(
    shownFacets.map((facet) => [facet.id, evidenceForFacet(db, facet.id)] as const),
  );

  const currentCount = currentFacets.length + factCounts.live;
  const historyCount = historicalFacets.length + factCounts.live + factCounts.superseded;

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="About you"
        meta={`${currentCount} current · ${review.total} to review · ${historyCount} historical`}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-[68ch] text-[0.88rem] leading-6" style={{ color: "var(--shell-muted)" }}>
            Everything Zeus holds about you: how you work and decide, and the details it has
            learned. Inferences and sensitive material stay outside the model until you accept
            them. This is what shapes every answer, so correcting a line here changes what Zeus
            does next.
          </p>
          <Link
            href="/about-you/backfill"
            className="shrink-0 rounded-md border px-3 py-2 font-mono text-[0.68rem]"
            style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
          >
            review past conversations
          </Link>
        </div>

        <AboutYouTabs
          view={view}
          currentCount={currentCount}
          reviewCount={review.total}
          historyCount={historyCount}
        />

        {view === "review" ? (
          <Review candidates={review.items} total={review.total} />
        ) : (
          <>
            <SearchForm view={view} query={query} />

            {view === "current" && entities.length > 0 && (
              <section className="mt-8">
                <SectionLabel>People and things</SectionLabel>
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

            <FacetSection
              facets={shownFacets}
              evidenceByFacet={evidenceByFacet}
              historical={view === "history"}
              query={query}
            />

            {view === "history" && !query ? (
              <FactHistory facts={shownFacts} />
            ) : (
              <section className="mt-9">
                <SectionLabel>{query ? `Details matching “${query}”` : "Details"}</SectionLabel>
                {shownFacts.length === 0 ? (
                  <EmptyFacts
                    query={query}
                    hasAnything={factCounts.live + factCounts.superseded > 0}
                  />
                ) : (
                  <ul className="mt-2">
                    {shownFacts.map((fact) => (
                      <FactRow key={fact.id} fact={fact} />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function parseView(params: { view?: string; show?: string }): AboutYouView {
  if (params.view === "review" || params.show === "pending") return "review";
  if (params.view === "history" || params.show === "all") return "history";
  return "current";
}

/**
 * Facets are searched under the same validity predicate as the unsearched list, so a result
 * can never appear beneath a heading that contradicts it.
 */
async function selectFacets(
  db: Db,
  view: AboutYouView,
  query: string,
  currentFacets: readonly UnderstandingFacetView[],
  historicalFacets: readonly UnderstandingFacetView[],
): Promise<UnderstandingFacetView[]> {
  if (view === "review") return [];
  const closed = view === "history";
  if (!query) return [...(closed ? historicalFacets : currentFacets)];
  const hits = await searchFacets(db, query, { limit: 40 });
  return hits
    .map((hit) => hit.facet)
    .filter((facet) => (closed ? facet.valid_to !== null : facet.valid_to === null));
}

async function selectFacts(db: Db, view: AboutYouView, query: string): Promise<FactView[]> {
  if (view === "review") return [];
  if (query) {
    const hits = await search(db, query, { limit: 100, includeSuperseded: view === "history" });
    return hits.map((hit) => hit.fact);
  }
  return timeline(db, { limit: view === "history" ? 300 : 100 }).filter(
    (fact) => view === "history" || fact.valid_to === null,
  );
}

function AboutYouTabs({
  view,
  currentCount,
  reviewCount,
  historyCount,
}: {
  view: AboutYouView;
  currentCount: number;
  reviewCount: number;
  historyCount: number;
}) {
  const tabs: { href: string; label: string; count: number; value: AboutYouView }[] = [
    { href: "/about-you", label: "Current", count: currentCount, value: "current" },
    { href: "/about-you?view=review", label: "Needs review", count: reviewCount, value: "review" },
    { href: "/about-you?view=history", label: "History", count: historyCount, value: "history" },
  ];

  return (
    <nav aria-label="About you views" className="mt-7 flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = view === tab.value;
        return (
          <Link
            key={tab.value}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className="rounded-full border px-3 py-1.5 text-[0.78rem]"
            style={{
              background: active ? "var(--shell-elevated)" : "transparent",
              borderColor: active ? "var(--shell-accent-line)" : "var(--shell-line-strong)",
              color: active ? "var(--shell-fg)" : "var(--shell-muted)",
            }}
          >
            {tab.label} · {tab.count}
          </Link>
        );
      })}
    </nav>
  );
}

function SearchForm({ view, query }: { view: AboutYouView; query: string }) {
  return (
    <>
      <form method="get" className="mt-7 flex flex-wrap items-center gap-3">
        <label htmlFor="q" className="sr-only">
          Search what Zeus knows about you
        </label>
        <input
          id="q"
          name="q"
          defaultValue={query}
          placeholder={view === "history" ? "Search history" : "Search what Zeus knows about you"}
          className="min-h-[40px] min-w-0 flex-1 rounded-[4px] border px-3 text-[0.92rem]"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "var(--shell-fg)",
          }}
        />
        {view === "history" && <input type="hidden" name="view" value="history" />}
        <button
          type="submit"
          className="min-h-[40px] rounded-[4px] px-4 text-[0.85rem] font-medium"
          style={{ background: "var(--shell-accent)", color: "#12100b" }}
        >
          Search
        </button>
      </form>

      {query && (
        <Link
          href={view === "history" ? "/about-you?view=history" : "/about-you"}
          className="mt-3 inline-block font-mono text-[0.68rem] underline underline-offset-2"
          style={{ color: "var(--shell-muted)" }}
        >
          clear search
        </Link>
      )}
    </>
  );
}

function FacetSection({
  facets,
  evidenceByFacet,
  historical,
  query,
}: {
  facets: readonly UnderstandingFacetView[];
  evidenceByFacet: ReadonlyMap<number, ReturnType<typeof evidenceForFacet>>;
  historical: boolean;
  query: string;
}) {
  return (
    <section className="mt-9">
      <SectionLabel>{historical ? "Earlier understanding" : "How you work"}</SectionLabel>
      <p className="mt-2 max-w-[68ch] text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        {historical
          ? "Closed and corrected patterns remain here so changes in your life are not mistaken for contradictions."
          : "Only accepted, currently valid patterns can shape Zeus’s advice and follow-through framing."}
      </p>
      {facets.length > 0 ? (
        <ul className="mt-3 max-w-[64rem]">
          {facets.map((facet) => (
            <FacetRow
              key={facet.id}
              facet={facet}
              evidence={evidenceByFacet.get(facet.id) ?? []}
            />
          ))}
        </ul>
      ) : (
        <div
          className="mt-4 max-w-[48rem] rounded-lg border border-dashed px-5 py-6"
          style={{ borderColor: "var(--shell-line-strong)" }}
        >
          <p className="text-[0.9rem]">
            {query
              ? "No patterns match that."
              : historical
                ? "Nothing has been closed or corrected yet."
                : "Zeus has not accepted any patterns about how you work yet."}
          </p>
          {!historical && !query && (
            <p className="mt-2 text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              Zeus learns these from conversation, or you can answer one focused question under{" "}
              <Link href="/today" className="underline underline-offset-2">
                Open questions on Today
              </Link>
              .
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Both kinds of proposal in one queue, newest first. A fact gets the plain row; a facet gets
 * the editor with evidence, typed condition, and conflict preview.
 */
function Review({ candidates, total }: { candidates: readonly CandidateView[]; total: number }) {
  return (
    <section className="mt-9 max-w-[64rem]">
      <SectionLabel>Needs your review</SectionLabel>
      <p className="mt-2 max-w-[68ch] text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        Uncertain or sensitive suggestions cannot influence Zeus until you accept them. Edit the
        wording first if it is close but not quite right.
      </p>
      {candidates.length < total && (
        <p className="mt-3 font-mono text-[0.68rem]" style={{ color: "var(--shell-faint)" }}>
          showing the {candidates.length} newest of {total}
        </p>
      )}
      {candidates.length > 0 ? (
        <ul className="mt-3">
          {candidates.map((candidate) =>
            candidate.kind === "facet" ? (
              <FacetCandidateRow key={candidate.id} candidate={candidate} />
            ) : (
              <CandidateRow key={candidate.id} candidate={candidate} />
            ),
          )}
        </ul>
      ) : (
        <p className="mt-6 text-[0.9rem]" style={{ color: "var(--shell-muted)" }}>
          Nothing is waiting for review.
        </p>
      )}
    </section>
  );
}

function FactHistory({ facts }: { facts: readonly FactView[] }) {
  const days = new Map<string, FactView[]>();
  for (const fact of facts) {
    const day = fact.created_at.slice(0, 10);
    const bucket = days.get(day) ?? [];
    bucket.push(fact);
    days.set(day, bucket);
  }

  return (
    <section className="mt-9">
      <SectionLabel>What Zeus learned, and when</SectionLabel>
      {days.size === 0 ? (
        <EmptyFacts query="" hasAnything={false} />
      ) : (
        <ol className="mt-5 space-y-9">
          {[...days.entries()].map(([day, dayFacts]) => (
            <li key={day}>
              <h3 className="flex items-baseline gap-3">
                <time
                  dateTime={day}
                  className="font-mono text-[0.72rem]"
                  style={{ color: "var(--shell-accent)" }}
                >
                  {day}
                </time>
                <span className="h-px flex-1" style={{ background: "var(--shell-line)" }} aria-hidden />
                <span className="font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
                  {dayFacts.length}
                </span>
              </h3>
              <ul className="mt-1">
                {dayFacts.map((fact) => (
                  <FactRow key={fact.id} fact={fact} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
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

function EmptyFacts({ query, hasAnything }: { query: string; hasAnything: boolean }) {
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
        <p className="text-[0.93rem]">There are no current saved details.</p>
      ) : (
        <>
          <p className="text-[0.93rem]">Zeus has not learned anything yet.</p>
          <p className="mt-1.5 text-[0.87rem]" style={{ color: "var(--shell-muted)" }}>
            <Link href="/" className="underline underline-offset-2">
              Start a conversation
            </Link>{" "}
            and accepted details will appear here with their sources.
          </p>
        </>
      )}
    </div>
  );
}

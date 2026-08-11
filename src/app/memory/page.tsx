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

type MemoryView = "current" | "review" | "history";

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string; show?: string }>;
}) {
  const params = await searchParams;
  const view = parseView(params);
  const query = view === "review" ? "" : params.q?.trim() ?? "";

  const db = getDb();
  const counts = countFacts(db);
  const pendingCount = countPendingCandidates(db);
  const candidates = view === "review"
    ? listCandidates(db, { status: "pending", limit: 200 })
    : [];
  const entities = view === "current"
    ? listEntities(db, { limit: 400 }).filter((entity) => entity.slug !== "self")
    : [];

  const facts: FactView[] = query
    ? (await search(db, query, {
        limit: 100,
        includeSuperseded: view === "history",
      })).map((hit) => hit.fact)
    : timeline(db, { limit: view === "history" ? 300 : 100 }).filter(
        (fact) => view === "history" || fact.valid_to === null,
      );

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Memory"
        meta={`${counts.live} current · ${pendingCount} to review · ${counts.superseded} historical`}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <MemoryTabs
          view={view}
          currentCount={counts.live}
          reviewCount={pendingCount}
          historyCount={counts.live + counts.superseded}
        />

        {view !== "review" && (
          <>
            <form method="get" className="mt-7 flex flex-wrap items-center gap-3">
              <label htmlFor="q" className="sr-only">
                Search memory
              </label>
              <input
                id="q"
                name="q"
                defaultValue={query}
                placeholder={view === "history" ? "Search memory history" : "Search what Zeus knows"}
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
                href={view === "history" ? "/memory?view=history" : "/memory"}
                className="mt-3 inline-block font-mono text-[0.68rem] underline underline-offset-2"
                style={{ color: "var(--shell-muted)" }}
              >
                clear search
              </Link>
            )}
          </>
        )}

        {entities.length > 0 && (
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

        {view === "review" ? (
          <section className="mt-9">
            <SectionLabel>Needs your review</SectionLabel>
            <p className="mt-2 max-w-[65ch] text-[0.82rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              Uncertain or sensitive suggestions stay out of Zeus&apos;s memory until you accept them.
            </p>
            {candidates.length > 0 ? (
              <ul className="mt-2">
                {candidates.map((candidate) => (
                  <CandidateRow key={candidate.id} candidate={candidate} />
                ))}
              </ul>
            ) : (
              <p className="mt-5 text-[0.9rem]" style={{ color: "var(--shell-muted)" }}>
                Nothing is waiting for review.
              </p>
            )}
          </section>
        ) : view === "history" && !query ? (
          <History facts={facts} />
        ) : (
          <section className="mt-9">
            <SectionLabel>{query ? `Results for “${query}”` : "Saved details"}</SectionLabel>
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

function parseView(params: { view?: string; show?: string }): MemoryView {
  if (params.view === "review" || params.show === "pending") return "review";
  if (params.view === "history" || params.show === "all") return "history";
  return "current";
}

function MemoryTabs({
  view,
  currentCount,
  reviewCount,
  historyCount,
}: {
  view: MemoryView;
  currentCount: number;
  reviewCount: number;
  historyCount: number;
}) {
  const tabs: { href: string; label: string; count: number; value: MemoryView }[] = [
    { href: "/memory", label: "Current", count: currentCount, value: "current" },
    { href: "/memory?view=review", label: "Needs review", count: reviewCount, value: "review" },
    { href: "/memory?view=history", label: "History", count: historyCount, value: "history" },
  ];

  return (
    <nav aria-label="Memory views" className="flex flex-wrap gap-2">
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

function History({ facts }: { facts: FactView[] }) {
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
        <EmptyMemory query="" hasAnything={false} />
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

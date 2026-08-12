import Link from "next/link";

import { AboutYouCard } from "@/components/about-you-card";
import { PageHeader } from "@/components/page-header";
import { ReviewItemCard } from "@/components/review-item-card";
import { listCandidates } from "@/core/candidates";
import {
  aboutYouItemForFacet,
  aboutYouItemForFact,
  groupAboutYouItems,
  reviewItemForCandidate,
  type AboutYouItem,
} from "@/core/consumer-dtos";
import { getMessage } from "@/core/conversations";
import { listFacets } from "@/core/facets";
import { timeline } from "@/core/facts";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

type AboutYouView = "saved" | "review" | "history";

export default async function AboutYouPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string }>;
}) {
  const params = await searchParams;
  const view = parseView(params.view);
  const query = params.q?.replace(/\s+/gu, " ").trim().slice(0, 200) ?? "";
  const db = await requireOwnerPageDb();

  const allFacts = timeline(db, { limit: 10_000 });
  const allFacets = listFacets(db, { includeClosed: true, limit: 10_000 });
  const pendingCandidates = listCandidates(db, { status: "pending", limit: 1_000 });

  const currentItems = [
    ...allFacts.filter((fact) => fact.valid_to === null).map(aboutYouItemForFact),
    ...allFacets.filter((facet) => facet.valid_to === null).map(aboutYouItemForFacet),
  ];
  const historicalItems = [
    ...allFacts.filter((fact) => fact.valid_to !== null).map(aboutYouItemForFact),
    ...allFacets.filter((facet) => facet.valid_to !== null).map(aboutYouItemForFacet),
  ];
  const sourceDates = new Map(
    [
      ...new Set(
        pendingCandidates.flatMap((candidate) => [
          candidate.source_message_id,
          ...candidate.evidence.map((evidence) => evidence.message_id),
        ]),
      ),
    ].flatMap((messageId) => {
      const message = getMessage(db, messageId);
      return message ? ([[messageId, message.created_at]] as const) : [];
    }),
  );
  const reviewItems = pendingCandidates.map((candidate) =>
    reviewItemForCandidate(candidate, sourceDates),
  );
  const shownItems = filteredItems(view === "history" ? historicalItems : currentItems, query);

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="About you"
        meta={`${currentItems.length} saved · ${reviewItems.length} to review`}
      />

      <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto w-full max-w-[58rem]">
          <p className="max-w-[68ch] text-sm leading-6" style={{ color: "var(--shell-muted)" }}>
            See what Zeus remembers, where it came from, and anything waiting for your approval.
            You can correct a detail without erasing its history, or remove it while keeping the
            source chat.
          </p>

          <AboutYouTabs
            view={view}
            savedCount={currentItems.length}
            reviewCount={reviewItems.length}
            historyCount={historicalItems.length}
          />

          {view === "review" ? (
            <ReviewInbox items={reviewItems} />
          ) : (
            <SavedDetails
              view={view}
              items={shownItems}
              query={query}
              hasAnything={(view === "history" ? historicalItems : currentItems).length > 0}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AboutYouTabs({
  view,
  savedCount,
  reviewCount,
  historyCount,
}: {
  view: AboutYouView;
  savedCount: number;
  reviewCount: number;
  historyCount: number;
}) {
  const tabs: ReadonlyArray<{ view: AboutYouView; href: string; label: string; count: number }> = [
    { view: "saved", href: "/about-you", label: "Saved", count: savedCount },
    { view: "review", href: "/about-you?view=review", label: "Review", count: reviewCount },
    { view: "history", href: "/about-you?view=history", label: "History", count: historyCount },
  ];

  return (
    <nav aria-label="About you sections" className="mt-7 flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = tab.view === view;
        return (
          <Link
            key={tab.view}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className="rounded-full border px-3 py-1.5 text-sm"
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

function SavedDetails({
  view,
  items,
  query,
  hasAnything,
}: {
  view: Exclude<AboutYouView, "review">;
  items: AboutYouItem[];
  query: string;
  hasAnything: boolean;
}) {
  const groups = groupAboutYouItems(items);
  return (
    <>
      <form method="get" className="mt-7 flex gap-2">
        {view === "history" && <input type="hidden" name="view" value="history" />}
        <label htmlFor="about-you-search" className="sr-only">
          Search saved details
        </label>
        <input
          id="about-you-search"
          type="search"
          name="q"
          defaultValue={query}
          placeholder={view === "history" ? "Search earlier details" : "Search saved details"}
          className="min-h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "var(--shell-fg)",
          }}
        />
        <button
          type="submit"
          className="min-h-10 rounded-lg px-4 text-sm font-medium"
          style={{ background: "var(--shell-accent)", color: "#000000" }}
        >
          Search
        </button>
      </form>

      {groups.length > 0 ? (
        <div className="mt-8 space-y-9">
          {groups.map((group) => (
            <section key={group.category} aria-labelledby={`about-you-${slug(group.category)}`}>
              <div className="flex items-baseline gap-2">
                <h2 id={`about-you-${slug(group.category)}`} className="text-sm font-semibold">
                  {group.category}
                </h2>
                <span className="text-xs" style={{ color: "var(--shell-faint)" }}>
                  {group.items.length}
                </span>
              </div>
              <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                {group.items.map((item) => (
                  <AboutYouCard key={item.id} item={item} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <EmptyDetails view={view} query={query} hasAnything={hasAnything} />
      )}
    </>
  );
}

function ReviewInbox({ items }: { items: ReturnType<typeof reviewItemForCandidate>[] }) {
  return (
    <section className="mt-8" aria-labelledby="review-heading">
      <h2 id="review-heading" className="text-base font-semibold">
        Needs your review
      </h2>
      <p className="mt-1 max-w-[68ch] text-sm leading-6" style={{ color: "var(--shell-muted)" }}>
        These details are not used in later chats unless you save them.
      </p>
      {items.length > 0 ? (
        <ul className="mt-4 grid gap-3">
          {items.map((item) => (
            <ReviewItemCard key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <div
          className="mt-5 rounded-xl border border-dashed px-5 py-7"
          style={{ borderColor: "var(--shell-line-strong)" }}
        >
          <p className="text-sm">Nothing is waiting for review.</p>
        </div>
      )}
    </section>
  );
}

function EmptyDetails({
  view,
  query,
  hasAnything,
}: {
  view: Exclude<AboutYouView, "review">;
  query: string;
  hasAnything: boolean;
}) {
  return (
    <div
      className="mt-8 rounded-xl border border-dashed px-5 py-7"
      style={{ borderColor: "var(--shell-line-strong)" }}
    >
      <p className="text-sm">
        {query
          ? "Nothing matches that search."
          : view === "history"
            ? "Nothing has moved into history yet."
            : "Zeus hasn’t saved any details about you yet."}
      </p>
      {!query && view === "saved" && !hasAnything && (
        <p className="mt-2 text-sm leading-5" style={{ color: "var(--shell-muted)" }}>
          <Link href="/" className="underline underline-offset-2">
            Start a chat
          </Link>{" "}
          and tell Zeus something you want it to remember.
        </p>
      )}
    </div>
  );
}

function filteredItems(items: AboutYouItem[], query: string): AboutYouItem[] {
  if (!query) return items;
  const normalized = query.toLocaleLowerCase();
  return items.filter(
    (item) =>
      item.statement.toLocaleLowerCase().includes(normalized) ||
      item.category.toLocaleLowerCase().includes(normalized),
  );
}

function parseView(value: string | undefined): AboutYouView {
  return value === "review" || value === "history" ? value : "saved";
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

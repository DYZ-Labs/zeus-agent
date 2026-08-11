import Link from "next/link";

import { FactRow } from "@/components/fact-row";
import { PageHeader } from "@/components/page-header";
import { countFacts, timeline } from "@/core/facts";
import type { FactView } from "@/core/schema";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

/** Facts grouped by the day Zeus learned them — "what changed when". */
export default function TimelinePage() {
  const db = getDb();
  const counts = countFacts(db);
  const facts = timeline(db, { limit: 300 });

  const days = new Map<string, FactView[]>();
  for (const fact of facts) {
    const day = fact.created_at.slice(0, 10);
    const bucket = days.get(day) ?? [];
    bucket.push(fact);
    days.set(day, bucket);
  }

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader title="Timeline" meta={`${counts.live + counts.superseded} facts`} />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        {days.size === 0 ? (
          <div
            className="rounded-[6px] border border-dashed px-5 py-6"
            style={{ borderColor: "var(--shell-line-strong)" }}
          >
            <p className="text-[0.93rem]">Nothing has been learned yet.</p>
            <p className="mt-1.5 text-[0.87rem]" style={{ color: "var(--shell-muted)" }}>
              This page fills in as Zeus records facts, newest first, so you can see what
              it picked up and when.{" "}
              <Link href="/" className="underline underline-offset-2">
                Start a conversation
              </Link>
              .
            </p>
          </div>
        ) : (
          <ol className="space-y-9">
            {[...days.entries()].map(([day, dayFacts]) => (
              <li key={day}>
                <h2 className="flex items-baseline gap-3">
                  <time
                    dateTime={day}
                    className="font-mono text-[0.72rem]"
                    style={{ color: "var(--shell-accent)" }}
                  >
                    {day}
                  </time>
                  <span
                    className="h-px flex-1"
                    style={{ background: "var(--shell-line)" }}
                    aria-hidden
                  />
                  <span
                    className="font-mono text-[0.65rem]"
                    style={{ color: "var(--shell-faint)" }}
                  >
                    {dayFacts.length}
                  </span>
                </h2>
                <ul className="mt-1">
                  {dayFacts.map((fact) => (
                    <FactRow key={fact.id} fact={fact} />
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

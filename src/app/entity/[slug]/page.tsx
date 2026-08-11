import Link from "next/link";
import { notFound } from "next/navigation";

import { FactRow } from "@/components/fact-row";
import { PageHeader } from "@/components/page-header";
import { aliasesOf, getEntityBySlug } from "@/core/entities";
import { factsForEntity } from "@/core/facts";
import type { FactView } from "@/core/schema";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function EntityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const entity = getEntityBySlug(db, slug);
  if (!entity) notFound();

  const all = factsForEntity(db, entity.id, {
    includeSuperseded: true,
    includeIncoming: true,
    limit: 500,
  });

  const about = all.filter((fact) => fact.subject_id === entity.id);
  const mentions = all.filter((fact) => fact.subject_id !== entity.id);
  const live = about.filter((fact) => fact.valid_to === null);
  const history = about.filter((fact) => fact.valid_to !== null);
  const aliases = aliasesOf(db, entity.id).filter((alias) => alias !== entity.name.toLowerCase());

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        eyebrow={entity.kind}
        title={entity.slug === "self" ? "You" : entity.name}
        meta={`${live.length} live · ${history.length} past`}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <Link
          href="/memory"
          className="font-mono text-[0.68rem] underline underline-offset-2"
          style={{ color: "var(--shell-muted)" }}
        >
          ← all memory
        </Link>

        {aliases.length > 0 && (
          <p className="mt-4 font-mono text-[0.7rem]" style={{ color: "var(--shell-faint)" }}>
            also known as {aliases.join(", ")}
          </p>
        )}

        <Section title="Currently true" count={live.length}>
          {live.length > 0 ? (
            <ul>
              {live.map((fact) => (
                <FactRow key={fact.id} fact={fact} showSubject={false} />
              ))}
            </ul>
          ) : (
            <Empty>Nothing currently known.</Empty>
          )}
        </Section>

        {history.length > 0 && (
          <Section title="No longer true" count={history.length}>
            <ul>
              {history.map((fact) => (
                <FactRow key={fact.id} fact={fact} showSubject={false} />
              ))}
            </ul>
          </Section>
        )}

        {mentions.length > 0 && (
          <Section title="Mentioned by" count={mentions.length}>
            <ul>
              {mentions.map((fact: FactView) => (
                <FactRow key={fact.id} fact={fact} />
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="flex items-baseline gap-2">
        <span
          className="font-mono text-[0.65rem] uppercase tracking-[0.14em]"
          style={{ color: "var(--shell-faint)" }}
        >
          {title}
        </span>
        <span className="font-mono text-[0.65rem]" style={{ color: "var(--shell-faint)" }}>
          {count}
        </span>
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="rounded-[6px] border border-dashed px-4 py-4 text-[0.88rem]"
      style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
    >
      {children}
    </p>
  );
}

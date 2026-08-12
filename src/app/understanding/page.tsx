import Link from "next/link";

import {
  acceptFacetCandidateAction,
  answerReflectionAction,
  rejectFacetCandidateAction,
} from "@/app/actions";
import { FacetRow } from "@/components/facet-row";
import { PageHeader } from "@/components/page-header";
import { listCandidates, type CandidateView } from "@/core/candidates";
import {
  evidenceForFacet,
  listFacets,
  type FacetKind,
  type UnderstandingFacetView,
} from "@/core/facets";
import { requireOwnerPageDb } from "@/server/auth/access";

export const dynamic = "force-dynamic";

type UnderstandingView = "current" | "review" | "questions" | "history";

export default async function UnderstandingPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const params = await searchParams;
  const view = parseView(params.view);
  const db = await requireOwnerPageDb();
  const allFacets = listFacets(db, { includeClosed: true, limit: 10_000 });
  const currentFacets = allFacets.filter((facet) => facet.valid_to === null);
  const historicalFacets = allFacets.filter((facet) => facet.valid_to !== null);
  const pendingFacetCandidates = listCandidates(db, { status: "pending", limit: 1_000 }).filter(
    (candidate) => String(candidate.kind) === "facet",
  );
  const shownFacets = view === "history" ? historicalFacets : view === "current" ? currentFacets : [];
  const evidenceByFacet = new Map(
    shownFacets.map((facet) => [facet.id, evidenceForFacet(db, facet.id)] as const),
  );

  return (
    <div className="flex h-full flex-col lg:min-h-0">
      <PageHeader
        title="Understanding"
        meta={`${currentFacets.length} accepted · ${pendingFacetCandidates.length} to review · ${historicalFacets.length} historical`}
      />

      <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="max-w-[68ch] text-[0.88rem] leading-6" style={{ color: "var(--shell-muted)" }}>
            This is Zeus&apos;s evidence-backed model of how you decide, work, relate, and set
            boundaries. Inferences and sensitive material stay outside the model until you accept
            them.
          </p>
          <Link
            href="/understanding/backfill"
            className="shrink-0 rounded-md border px-3 py-2 font-mono text-[0.68rem]"
            style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
          >
            review past conversations
          </Link>
        </div>

        <UnderstandingTabs
          view={view}
          currentCount={currentFacets.length}
          reviewCount={pendingFacetCandidates.length}
          historyCount={historicalFacets.length}
        />

        {view === "review" ? (
          <Review candidates={pendingFacetCandidates} />
        ) : view === "questions" ? (
          <Reflection currentFacets={currentFacets} />
        ) : (
          <FacetList
            facets={shownFacets}
            evidenceByFacet={evidenceByFacet}
            historical={view === "history"}
          />
        )}
      </div>
    </div>
  );
}

function parseView(value: string | undefined): UnderstandingView {
  if (value === "review" || value === "questions" || value === "history") return value;
  return "current";
}

function UnderstandingTabs({
  view,
  currentCount,
  reviewCount,
  historyCount,
}: {
  view: UnderstandingView;
  currentCount: number;
  reviewCount: number;
  historyCount: number;
}) {
  const tabs: readonly {
    value: UnderstandingView;
    href: string;
    label: string;
    count?: number;
  }[] = [
    { value: "current", href: "/understanding", label: "Current model", count: currentCount },
    {
      value: "review",
      href: "/understanding?view=review",
      label: "Needs confirmation",
      count: reviewCount,
    },
    { value: "questions", href: "/understanding?view=questions", label: "Open questions" },
    {
      value: "history",
      href: "/understanding?view=history",
      label: "History",
      count: historyCount,
    },
  ];

  return (
    <nav aria-label="Understanding views" className="mt-7 flex flex-wrap gap-2">
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
            {tab.label}{tab.count === undefined ? "" : ` · ${tab.count}`}
          </Link>
        );
      })}
    </nav>
  );
}

function FacetList({
  facets,
  evidenceByFacet,
  historical,
}: {
  facets: readonly UnderstandingFacetView[];
  evidenceByFacet: ReadonlyMap<number, ReturnType<typeof evidenceForFacet>>;
  historical: boolean;
}) {
  return (
    <section className="mt-9">
      <SectionLabel>{historical ? "Earlier understanding" : "Accepted understanding"}</SectionLabel>
      <p className="mt-2 max-w-[68ch] text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        {historical
          ? "Closed and corrected facets remain here so changes in your life are not mistaken for contradictions."
          : "Only accepted, currently valid facets can shape Zeus’s advice and follow-through framing."}
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
          className="mt-6 max-w-[48rem] rounded-lg border border-dashed px-5 py-7"
          style={{ borderColor: "var(--shell-line-strong)" }}
        >
          <p className="text-[0.9rem]">
            {historical ? "Nothing has been closed or corrected yet." : "No accepted facets yet."}
          </p>
          {!historical && (
            <p className="mt-2 text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
              Zeus can learn naturally from conversation, or you can start one focused reflection in{" "}
              <Link href="/understanding?view=questions" className="underline underline-offset-2">
                Open questions
              </Link>
              .
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Review({ candidates }: { candidates: readonly CandidateView[] }) {
  return (
    <section className="mt-9 max-w-[64rem]">
      <SectionLabel>Needs your confirmation</SectionLabel>
      <p className="mt-2 max-w-[68ch] text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        These suggestions cannot influence Zeus until you accept them. Edit the wording first if
        it is close but not quite right.
      </p>
      {candidates.length > 0 ? (
        <ul className="mt-3">
          {candidates.map((candidate) => (
            <FacetCandidateRow key={candidate.id} candidate={candidate} />
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-[0.9rem]" style={{ color: "var(--shell-muted)" }}>
          Nothing is waiting for confirmation.
        </p>
      )}
    </section>
  );
}

function FacetCandidateRow({ candidate }: { candidate: CandidateView }) {
  const envelope = asRecord(candidate.payload);
  const payload = "item" in envelope ? asRecord(envelope.item) : envelope;
  const statement = stringValue(payload.statement, "Review this proposed understanding");
  const kind = stringValue(payload.kind, "facet").replace(/_/gu, " ");
  const scope = candidateScope(payload);
  const reasons = candidateReasons(candidate);
  const conflict = conflictPreview(envelope) ?? conflictPreview(payload);
  const origin = candidate.origin;

  return (
    <li className="border-b py-5" style={{ borderColor: "var(--shell-line)" }}>
      <form action={acceptFacetCandidateAction}>
        <input type="hidden" name="id" value={candidate.id} />
        <div className="flex flex-wrap items-center gap-2 font-mono text-[0.63rem]">
          <span
            className="rounded-full border px-2 py-0.5 uppercase tracking-[0.08em]"
            style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-faint)" }}
          >
            {kind}
          </span>
          <span style={{ color: "var(--shell-faint)" }}>{scope}</span>
          <span style={{ color: "var(--shell-faint)" }}>
            held for {reasons.join(" + ")} · confidence {candidate.confidence.toFixed(2)}
          </span>
          {origin === "backfill" && (
            <span style={{ color: "var(--shell-muted)" }}>historical preview</span>
          )}
        </div>

        <label htmlFor={`candidate-statement-${candidate.id}`} className="sr-only">
          Edit proposed understanding
        </label>
        <textarea
          id={`candidate-statement-${candidate.id}`}
          name="statement"
          defaultValue={statement}
          required
          rows={2}
          className="mt-3 w-full resize-y rounded-md border px-3 py-2 text-[0.92rem] leading-6"
          style={{
            background: "var(--shell-panel)",
            borderColor: "var(--shell-line-strong)",
            color: "var(--shell-fg)",
          }}
        />

        {conflict && (
          <div
            className="mt-3 rounded-md border px-3 py-2 text-[0.76rem] leading-5"
            style={{ borderColor: "var(--shell-line-strong)", color: "var(--shell-muted)" }}
          >
            <span className="font-medium" style={{ color: "var(--shell-fg)" }}>
              If accepted: {" "}
            </span>
            {conflict}
          </div>
        )}

        <CandidateEvidence candidate={candidate} />

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <label
            htmlFor={`candidate-effect-${candidate.id}`}
            className="font-mono text-[0.63rem]"
            style={{ color: "var(--shell-faint)" }}
          >
            follow-through effect
          </label>
          <select
            id={`candidate-effect-${candidate.id}`}
            name="machineEffect"
            defaultValue={machineEffectValue(payload.machine_effect)}
            className="min-h-8 rounded border px-2 text-[0.74rem]"
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
            className="rounded-md px-3 py-1.5 text-[0.76rem] font-medium"
            style={{ background: "var(--shell-accent)", color: "#12100b" }}
          >
            Accept edited understanding
          </button>
          <Link
            href={`/source/${candidate.source_message_id}`}
            className="font-mono text-[0.63rem] underline underline-offset-2"
            style={{ color: "var(--shell-faint)" }}
          >
            inspect source
          </Link>
        </div>
      </form>
      <form action={rejectFacetCandidateAction} className="mt-2">
        <input type="hidden" name="id" value={candidate.id} />
        <button type="submit" className="font-mono text-[0.63rem]" style={{ color: "var(--shell-muted)" }}>
          Reject and keep out of Zeus&apos;s model
        </button>
      </form>
    </li>
  );
}

function CandidateEvidence({ candidate }: { candidate: CandidateView }) {
  if (candidate.evidence.length === 0) {
    return (
      <blockquote className="mt-3 line-clamp-3 text-[0.76rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        “{candidate.source_excerpt}”
      </blockquote>
    );
  }

  return (
    <ul className="mt-3 space-y-2">
      {candidate.evidence.map((passage) => (
        <li
          key={passage.id}
          className="rounded-md border px-3 py-2"
          style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line)" }}
        >
          <blockquote className="text-[0.76rem] leading-5" style={{ color: "var(--shell-muted)" }}>
            “{passage.text}”
          </blockquote>
          <p className="mt-1 font-mono text-[0.6rem]" style={{ color: "var(--shell-faint)" }}>
            characters {passage.start_offset}–{passage.end_offset} ·{" "}
            <Link
              href={`/source/${passage.message_id}?passage=${passage.id}`}
              className="underline underline-offset-2"
            >
              source
            </Link>
          </p>
        </li>
      ))}
    </ul>
  );
}

function Reflection({ currentFacets }: { currentFacets: readonly UnderstandingFacetView[] }) {
  const prompt = reflectionPrompt(currentFacets);

  return (
    <section className="mt-9 max-w-[48rem]">
      <SectionLabel>One question, when you choose</SectionLabel>
      <p className="mt-2 max-w-[68ch] text-[0.8rem] leading-5" style={{ color: "var(--shell-muted)" }}>
        Zeus does not append profile questions to normal chats. This reflection begins only because
        you opened it, and your answer is stored as an ordinary user-authored source message.
      </p>
      <form
        action={answerReflectionAction}
        className="mt-6 rounded-xl border px-5 py-5"
        style={{ background: "var(--shell-panel)", borderColor: "var(--shell-line-strong)" }}
      >
        <input type="hidden" name="prompt" value={prompt.question} />
        <input type="hidden" name="kind" value={prompt.kind} />
        <p className="font-mono text-[0.62rem] uppercase tracking-[0.12em]" style={{ color: "var(--shell-faint)" }}>
          {prompt.kind.replace(/_/gu, " ")}
        </p>
        <label htmlFor="reflection-answer" className="mt-3 block text-[1rem] font-medium leading-6">
          {prompt.question}
        </label>
        <p className="mt-2 text-[0.78rem] leading-5" style={{ color: "var(--shell-muted)" }}>
          {prompt.why}
        </p>
        <textarea
          id="reflection-answer"
          name="answer"
          required
          rows={5}
          placeholder="Answer in your own words. Specific examples help, but a short answer is enough."
          className="mt-4 w-full resize-y rounded-md border px-3 py-2 text-[0.9rem] leading-6"
          style={{
            background: "var(--shell-bg)",
            borderColor: "var(--shell-line-strong)",
            color: "var(--shell-fg)",
          }}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.7rem] leading-5" style={{ color: "var(--shell-faint)" }}>
            Sensitive answers always require confirmation before use.
          </p>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-[0.78rem] font-medium"
            style={{ background: "var(--shell-accent)", color: "#12100b" }}
          >
            Save my answer
          </button>
        </div>
      </form>
    </section>
  );
}

function reflectionPrompt(currentFacets: readonly UnderstandingFacetView[]): ReflectionPrompt {
  const existingKinds = new Set(currentFacets.map((facet) => facet.kind));
  const unanswered = REFLECTION_PROMPTS.find((prompt) => !existingKinds.has(prompt.kind));
  if (unanswered) return unanswered;
  const first = REFLECTION_PROMPTS.at(0);
  if (!first) throw new Error("Understanding reflection prompts are not configured");
  return first;
}

type ReflectionPrompt = {
  kind: FacetKind;
  question: string;
  why: string;
};

const REFLECTION_PROMPTS: readonly ReflectionPrompt[] = [
  {
    kind: "value",
    question: "When two good options compete, what principle do you most want Zeus to protect?",
    why: "This helps Zeus frame real tradeoffs without deciding what matters on your behalf.",
  },
  {
    kind: "constraint",
    question: "What recurring constraint should Zeus account for before suggesting a plan?",
    why: "A real constraint is more useful than an idealized plan that does not fit your life.",
  },
  {
    kind: "decision_criterion",
    question: "What criterion usually separates a merely acceptable decision from the right one for you?",
    why: "Decision criteria help Zeus compare options in your terms rather than generic ones.",
  },
  {
    kind: "boundary",
    question: "What boundary should Zeus never trade away for speed, convenience, or progress?",
    why: "Accepted boundaries can shape advice while external actions remain under your control.",
  },
  {
    kind: "communication_style",
    question: "When a situation is difficult, how do you want Zeus to communicate with you?",
    why: "This can adapt tone and structure without turning a style preference into a claim about your identity.",
  },
];

function candidateReasons(candidate: CandidateView): string[] {
  const record = asRecord(candidate);
  const reasons = record.reasons;
  if (Array.isArray(reasons)) {
    const values = reasons.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (values.length > 0) return values.map((value) => value.replace(/_/gu, " "));
  }
  const encoded = record.reasons_json;
  if (typeof encoded === "string") {
    try {
      const parsed = JSON.parse(encoded) as unknown;
      if (Array.isArray(parsed)) {
        const values = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
        if (values.length > 0) return values.map((value) => value.replace(/_/gu, " "));
      }
    } catch {
      // The primary reason remains visible if an externally edited row is malformed.
    }
  }
  return [candidate.reason.replace(/_/gu, " ")];
}

function candidateScope(payload: Record<string, unknown>): string {
  const nested = asRecord(payload.scope);
  const kind = stringValue(nested.kind, stringValue(payload.scope_kind, "global"));
  if (kind === "global") return "across your life";
  if (kind === "domain") return stringValue(nested.label, stringValue(payload.scope_label, "domain"));
  return `${kind} scoped`;
}

function conflictPreview(payload: Record<string, unknown>): string | null {
  for (const key of ["conflict_preview", "conflict", "supersession_preview", "influence_preview"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (items.length > 0) return items.join("; ");
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function machineEffectValue(value: unknown): "" | "boost" | "deprioritize" | "block" {
  return value === "boost" || value === "deprioritize" || value === "block" ? value : "";
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

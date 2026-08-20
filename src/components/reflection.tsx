import { answerReflectionAction } from "@/app/actions";
import type { FacetKind, UnderstandingFacetView } from "@/core/facets";

/**
 * One question about how the user works, offered where they already answer things.
 *
 * Zeus never appends profile questions to a normal chat, so this stays behind a disclosure
 * the user opens: the reflection begins because they asked for it, and the answer is stored
 * as an ordinary user-authored message rather than an assistant inference.
 */
export function Reflection({ currentFacets }: { currentFacets: readonly UnderstandingFacetView[] }) {
  const prompt = reflectionPrompt(currentFacets);

  return (
    <form
      action={answerReflectionAction}
      className="mt-4 max-w-[48rem] rounded-xl border px-5 py-5"
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
  );
}

export function reflectionPrompt(
  currentFacets: readonly UnderstandingFacetView[],
): ReflectionPrompt {
  const existingKinds = new Set(currentFacets.map((facet) => facet.kind));
  const unanswered = REFLECTION_PROMPTS.find((prompt) => !existingKinds.has(prompt.kind));
  if (unanswered) return unanswered;
  const first = REFLECTION_PROMPTS.at(0);
  if (!first) throw new Error("Understanding reflection prompts are not configured");
  return first;
}

export type ReflectionPrompt = {
  kind: FacetKind;
  question: string;
  why: string;
};

export const REFLECTION_PROMPTS: readonly ReflectionPrompt[] = [
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

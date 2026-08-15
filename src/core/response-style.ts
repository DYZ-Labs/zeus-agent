/**
 * The mechanical half of Zeus's response voice.
 *
 * Tone is mostly a prompt concern and cannot be checked offline. A handful of its rules
 * are not judgement calls, though: whether Zeus refers to itself in the third person,
 * whether a reply reaches for Markdown the chat cannot render, whether it closes with the
 * assistant boilerplate the prompt forbids. Those are decidable from the text alone.
 *
 * The value is less in policing the model — nothing here runs on a reply — than in
 * pinning the copy Zeus ships with. Every fixed sentence the user reads is code, and code
 * drifts back toward "Zeus could not…" one edit at a time unless something fails when it
 * does. `styleViolations` is what the copy tests assert against.
 *
 * Deliberately conservative: a rule that fires on ordinary prose is a rule someone
 * disables. Each pattern below is scoped tightly enough to be worth trusting.
 */

export type StyleViolationKind =
  | "third_person_self"
  | "markdown_marker"
  | "list_bullet"
  | "assistant_closer"
  | "hedge_opener"
  | "over_length";

export type StyleViolation = {
  kind: StyleViolationKind;
  /** The matched text, so a failing assertion says what tripped it. */
  excerpt: string;
  index: number;
};

export type StyleOptions = {
  /** Off unless set: card copy is short by construction, model replies are not. */
  maxSentences?: number;
};

/**
 * Zeus predicating about itself. Scoped to a following verb rather than the bare name so
 * "what is Zeus?" and "Zeus, the personal agent" stay clean — the failure being caught is
 * self-narration in the third person, not every mention of the name.
 */
const THIRD_PERSON_SELF =
  /\bZeus\b(?:['’]s)?\s+(?:cannot|can(?:['’]t)?|could(?:n['’]t)?|did(?:n['’]t)?|does(?:n['’]t)?|do(?:n['’]t)?|has|have|had|is(?:n['’]t)?|was(?:n['’]t)?|will|won['’]t|would(?:n['’]t)?|found|read|last|never|still|prepared|completed|stopped|knows|needs|saw|checked|looked|acted|changed|sent|made)\b/giu;

/** Markers the chat surface renders literally, because there is no Markdown parser. */
const MARKDOWN_MARKER = /\*\*|__|`{1,3}|^#{1,6}\s|^[ \t]*\|.*\|[ \t]*$/gmu;

/** A list is a report's shape. The prompt asks for a sentence instead. */
const LIST_BULLET = /^[ \t]*(?:[-*•]\s+|\d+[.)]\s+)/gmu;

/** The closers that make a reply sound like a support ticket. */
const ASSISTANT_CLOSER =
  /\b(?:let me know if|feel free to|(?:i['’]m|i am) happy to|is there anything else|anything else i can|hope (?:this|that) helps|(?:please )?don['’]t hesitate)\b/giu;

/** Preamble before the answer. Only meaningful at the very start of a reply. */
const HEDGE_OPENER =
  /^[\s"'“‘]*(?:great question|good question|that['’]s a (?:great|good) question|excellent question|certainly[,!.]|absolutely[,!.]|sure thing|of course[,!.]|as an ai|i understand that you|thanks for asking|happy to help)/iu;

/** Rough but stable: terminal punctuation followed by whitespace, or end of text. */
const SENTENCE_END = /[.!?…](?=\s|$)/gu;

export function styleViolations(text: string, options: StyleOptions = {}): StyleViolation[] {
  const violations: StyleViolation[] = [];

  for (const [kind, pattern] of [
    ["third_person_self", THIRD_PERSON_SELF],
    ["markdown_marker", MARKDOWN_MARKER],
    ["list_bullet", LIST_BULLET],
    ["assistant_closer", ASSISTANT_CLOSER],
  ] as const) {
    // Each pattern is a module constant with the global flag, so lastIndex has to be reset
    // rather than inherited from whichever call ran last.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      violations.push({ kind, excerpt: match[0].trim(), index: match.index });
    }
  }

  const opener = HEDGE_OPENER.exec(text);
  if (opener) violations.push({ kind: "hedge_opener", excerpt: opener[0].trim(), index: 0 });

  if (options.maxSentences !== undefined && countSentences(text) > options.maxSentences) {
    violations.push({ kind: "over_length", excerpt: `${countSentences(text)} sentences`, index: 0 });
  }

  return violations.sort((a, b) => a.index - b.index);
}

export function countSentences(text: string): number {
  SENTENCE_END.lastIndex = 0;
  const terminated = [...text.matchAll(SENTENCE_END)].length;
  // An unterminated trailing fragment still reads as a sentence to the person reading it.
  return /[^\s.!?…]\s*$/u.test(text) ? terminated + 1 : terminated;
}

/** For assertion messages: "third_person_self: Zeus could not (at 14)". */
export function describeViolations(violations: StyleViolation[]): string {
  return violations.map((v) => `${v.kind}: ${v.excerpt} (at ${v.index})`).join("; ");
}

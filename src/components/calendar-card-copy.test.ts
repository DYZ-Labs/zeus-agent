import { describe, expect, it } from "vitest";

import {
  CARD_COPY,
  CLARIFICATION,
  CLARIFICATION_FALLBACK,
  FOLLOW_THROUGH_DECISION,
  NOT_DONE,
  TARGET_NOT_FOUND,
  UNVERIFIABLE,
  UNVERIFIABLE_FALLBACK,
  VERB,
  WORK_CARD_COPY,
} from "@/components/calendar-card-copy";
import { describeViolations, styleViolations } from "@/core/response-style";

/**
 * The cards are the densest concentration of fixed copy Zeus ships, and they used to be
 * written entirely in the third person. Nothing else in the suite reads them, so without
 * this the voice regresses one plausible-looking edit at a time.
 */

function everyString(): Array<[string, string]> {
  return [
    ...Object.entries(CLARIFICATION).map(([key, value]): [string, string] => [
      `CLARIFICATION.${key}`,
      value,
    ]),
    ["CLARIFICATION_FALLBACK", CLARIFICATION_FALLBACK],
    ...Object.entries(VERB).map(([key, value]): [string, string] => [`VERB.${key}`, value]),
    ...Object.entries(NOT_DONE).map(([key, value]): [string, string] => [
      `NOT_DONE.${key}`,
      value,
    ]),
    ...Object.entries(TARGET_NOT_FOUND).map(([key, value]): [string, string] => [
      `TARGET_NOT_FOUND.${key}`,
      value,
    ]),
    ...Object.entries(UNVERIFIABLE).map(([key, value]): [string, string] => [
      `UNVERIFIABLE.${key}`,
      value,
    ]),
    ["UNVERIFIABLE_FALLBACK", UNVERIFIABLE_FALLBACK],
    ...Object.entries(CARD_COPY).map(([key, value]): [string, string] => [
      `CARD_COPY.${key}`,
      value,
    ]),
    ...Object.entries(WORK_CARD_COPY).map(([key, value]): [string, string] => [
      `WORK_CARD_COPY.${key}`,
      value,
    ]),
    ...Object.entries(FOLLOW_THROUGH_DECISION).map(([key, value]): [string, string] => [
      `FOLLOW_THROUGH_DECISION.${key}`,
      value,
    ]),
  ];
}

describe("calendar card copy", () => {
  it.each(everyString())("%s reads in Zeus's own voice", (name, text) => {
    const violations = styleViolations(text);
    expect(violations, `${name}: ${describeViolations(violations)}`).toEqual([]);
  });

  it("never refers to Zeus in the third person", () => {
    const offenders = everyString().filter(([, text]) => /\bZeus\b/u.test(text));
    expect(offenders).toEqual([]);
  });

  it("covers every outcome kind that has a card, so none falls through to a blank verb", () => {
    // The Record types make this exhaustive at compile time; this catches an empty string
    // slipped in to satisfy the type, and keeps the two maps from drifting apart.
    // No `read`: a read changed nothing and renders no card, so a verb for it would be copy
    // the user can never see, and CalendarCardKind makes writing one a build error.
    expect(Object.keys(VERB).sort()).toEqual(["cancel", "create", "reschedule"]);
    expect(Object.keys(NOT_DONE).sort()).toEqual(Object.keys(VERB).sort());
    for (const [kind, verb] of Object.entries(VERB)) {
      expect(verb, `VERB.${kind}`).not.toBe("");
      // The card is the durable record of whether a change happened. If these ever
      // collide, an awaiting_confirmation turn reads as a completed one after a reload.
      expect(NOT_DONE[kind as keyof typeof NOT_DONE], `NOT_DONE.${kind}`).not.toBe(verb);
    }
  });
});

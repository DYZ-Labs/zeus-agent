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
  WORK_CARD_COPY,
  rendersCard,
} from "@/components/calendar-card-copy";
import { describeViolations, styleViolations } from "@/core/response-style";
import { CalendarOutcome } from "@/core/schema";

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

  it("covers every write kind, and only ever headlines a change that did not happen", () => {
    // The Record type makes this exhaustive at compile time; this catches an empty string
    // slipped in to satisfy it. No `read`: a read changed nothing and renders no card, so
    // copy for it could never be seen, and CalendarCardKind makes writing some a build error.
    expect(Object.keys(NOT_DONE).sort()).toEqual(["cancel", "create", "reschedule"]);
    for (const [kind, text] of Object.entries(NOT_DONE)) {
      expect(text, `NOT_DONE.${kind}`).not.toBe("");
      // There is no success verb any more, so this map is the only headline a card can
      // show. A string here that could read as a completed change is the failure the old
      // VERB/NOT_DONE collision check guarded against, one layer closer to the user.
      expect(text, `NOT_DONE.${kind}`).toMatch(/^Not /u);
    }
  });
});

/**
 * The card's whole reason to exist, in the one form a node-only suite can hold.
 *
 * `CalendarActionCard` lives in a `.tsx` file the runner never loads and there is no DOM to
 * render it into, so this predicate is the only part of the rule a test can reach. Driving
 * it off the Zod enums rather than a hand-written list means a status added later fails here
 * until someone decides which side of the rule it belongs on.
 */
describe("a card appears only when something did not happen", () => {
  const KINDS = CalendarOutcome.shape.kind.options;
  const STATUSES = CalendarOutcome.shape.status.options;

  it("shows nothing once the change went through", () => {
    for (const kind of KINDS) {
      expect(rendersCard({ kind, status: "done" }), `${kind}/done`).toBe(false);
    }
  });

  it("shows nothing for a read, whatever became of it", () => {
    for (const status of STATUSES) {
      expect(rendersCard({ kind: "read", status }), `read/${status}`).toBe(false);
    }
  });

  it("shows a card for every write that did not go through, so none goes unreported", () => {
    for (const kind of KINDS.filter((entry) => entry !== "read")) {
      for (const status of STATUSES.filter((entry) => entry !== "done")) {
        expect(rendersCard({ kind, status }), `${kind}/${status}`).toBe(true);
      }
    }
  });
});

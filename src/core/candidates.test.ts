import { beforeEach, describe, expect, it } from "vitest";

import { createCandidate, listPendingReview, resolveCandidate } from "./candidates";
import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

function source(text: string): number {
  const conversation = createConversation(db);
  return appendMessage(db, conversation.id, "user", text).id;
}

function facetPayload(
  statement: string,
  condition: string | null = null,
  structuredCondition: unknown = null,
) {
  return {
    item: {
      kind: "constraint",
      statement,
      scope: { kind: "domain", label: "work" },
      condition,
      structured_condition: structuredCondition,
      machine_effect: null,
    },
    entities: [],
  };
}

describe("candidate semantic suppression", () => {
  it("suppresses a rejected word-order paraphrase in the same facet context", () => {
    const first = createCandidate(db, {
      kind: "facet",
      payload: facetPayload("Protect quiet mornings"),
      reason: "inference",
      confidence: 0.7,
      sourceMessageId: source("Quiet mornings help."),
    });
    resolveCandidate(db, first.id, "rejected");

    const repeated = createCandidate(db, {
      kind: "facet",
      payload: facetPayload("Mornings: protect the quiet"),
      reason: "inference",
      confidence: 0.72,
      sourceMessageId: source("Protect the quiet in my mornings."),
    });

    expect(repeated.id).toBe(first.id);
    expect(repeated.status).toBe("rejected");
  });

  it("does not suppress a facet whose situational condition changed", () => {
    const first = createCandidate(db, {
      kind: "facet",
      payload: facetPayload("Protect quiet mornings", "during launches"),
      reason: "inference",
      confidence: 0.7,
      sourceMessageId: source("During launches, protect quiet mornings."),
    });
    resolveCandidate(db, first.id, "rejected");

    const distinct = createCandidate(db, {
      kind: "facet",
      payload: facetPayload("Protect quiet mornings", "during recovery"),
      reason: "inference",
      confidence: 0.72,
      sourceMessageId: source("During recovery, protect quiet mornings."),
    });

    expect(distinct.id).not.toBe(first.id);
    expect(distinct.status).toBe("pending");
  });

  it("does not deduplicate materially different typed ambient conditions", () => {
    const first = createCandidate(db, {
      kind: "facet",
      payload: facetPayload("Protect focus time", null, { weekdays: ["mon"] }),
      reason: "inference",
      confidence: 0.7,
      sourceMessageId: source("Protect focus time on Monday."),
    });
    resolveCandidate(db, first.id, "rejected");

    const distinct = createCandidate(db, {
      kind: "facet",
      payload: facetPayload("Protect focus time", null, { weekdays: ["fri"] }),
      reason: "inference",
      confidence: 0.72,
      sourceMessageId: source("Protect focus time on Friday."),
    });
    expect(distinct.id).not.toBe(first.id);
    expect(distinct.status).toBe("pending");
  });
});

describe("the one review queue behind About you", () => {
  function factPayload(subject: string, predicate: string, object: string) {
    return { item: { kind: "fact", subject, predicate, object }, entities: [] };
  }

  function pending(kind: "fact" | "facet" | "commitment", payload: unknown, text: string) {
    return createCandidate(db, {
      kind,
      payload,
      reason: "inference",
      confidence: 0.6,
      sourceMessageId: source(text),
    });
  }

  it("shows every kind of proposal, and counts exactly what it shows", () => {
    pending("fact", factPayload("Sarah", "works_at", "Sequoia"), "Sarah moved to Sequoia.");
    pending("facet", facetPayload("Protect quiet mornings"), "Mornings are for deep work.");
    pending("commitment", { item: { title: "Send the deck", status: "open" } }, "I owe Alex the deck.");

    const review = listPendingReview(db, 50);

    // The bug this replaces: a page counted all three and rendered only some of them.
    expect(review.items).toHaveLength(review.total);
    expect(review.total).toBe(3);
    expect([...review.items.map((item) => item.kind)].sort()).toEqual([
      "commitment",
      "facet",
      "fact",
    ]);
  });

  it("still reports the true total when more is pending than one screenful", () => {
    for (let index = 0; index < 5; index += 1) {
      pending("facet", facetPayload(`Pattern number ${index}`), `Evidence ${index}.`);
    }

    const review = listPendingReview(db, 2);

    expect(review.items).toHaveLength(2);
    expect(review.total).toBe(5);
  });

  it("reads the count alone when the review view is not open", () => {
    pending("fact", factPayload("Alex", "works_at", "Acme"), "Alex is at Acme.");

    const review = listPendingReview(db, 0);

    expect(review.items).toEqual([]);
    expect(review.total).toBe(1);
  });

  it("drops a proposal from both the count and the rows once it is resolved", () => {
    const accepted = pending("fact", factPayload("Sarah", "prefers", "aisle seats"), "Aisle only.");
    pending("facet", facetPayload("Protect quiet mornings"), "Mornings are for deep work.");

    resolveCandidate(db, accepted.id, "accepted");
    const review = listPendingReview(db, 50);

    expect(review.items).toHaveLength(review.total);
    expect(review.total).toBe(1);
    expect(review.items[0]?.kind).toBe("facet");
  });
});

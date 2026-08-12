import { beforeEach, describe, expect, it } from "vitest";

import { createCandidate, resolveCandidate } from "./candidates";
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

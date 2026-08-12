import { describe, expect, it } from "vitest";

import type { CandidateView } from "./candidates";
import {
  aboutYouItemForFacet,
  aboutYouItemForFact,
  groupAboutYouItems,
  reviewItemForCandidate,
} from "./consumer-dtos";
import type { FactView, UnderstandingFacetView } from "./schema";

const timestamp = "2026-08-12T08:00:00.000Z";

describe("consumer About you DTOs", () => {
  it("turns a stored fact into plain language and opaque resource ids", () => {
    const item = aboutYouItemForFact(fact({ predicate: "works_at", object: "Northstar" }));

    expect(item).toMatchObject({
      id: "fact_1",
      category: "Work",
      statement: "You work at Northstar.",
      editableText: "Northstar",
      sourceId: "message_7",
      canRestore: false,
    });
    expect(item.statement).not.toContain("works_at");
  });

  it("merges accepted facets into the same natural groups as facts", () => {
    const preference = aboutYouItemForFacet(
      facet({ kind: "communication_style", statement: "You prefer concise explanations" }),
    );
    const work = aboutYouItemForFact(fact({ predicate: "job_title", object: "Designer" }));

    expect(preference).toMatchObject({
      id: "facet_2",
      category: "Preferences",
      statement: "You prefer concise explanations.",
    });
    expect(groupAboutYouItems([preference, work]).map((group) => group.category)).toEqual([
      "Work",
      "Preferences",
    ]);
  });

  it("maps pending proposals into one plain-language review contract", () => {
    const item = reviewItemForCandidate(
      candidate({
        kind: "fact",
        payload: { subject: "self", predicate: "lives_in", object: "Singapore" },
        reason: "sensitive",
        reasons: ["inference", "sensitive"],
      }),
      new Map([[7, "2026-08-11T04:00:00.000Z"]]),
    );

    expect(item).toEqual({
      id: "candidate_3",
      category: "Places",
      statement: "You live in Singapore.",
      reason: "sensitive",
      evidence: [
        {
          quote: "I recently moved to Singapore.",
          date: "2026-08-11T04:00:00.000Z",
          sourceId: "message_7",
        },
      ],
      canEdit: true,
      editableText: "Singapore",
    });
  });

  it("allows proposed understanding wording to be edited without exposing its ontology", () => {
    const item = reviewItemForCandidate(
      candidate({
        kind: "facet",
        payload: {
          kind: "working_style",
          statement: "You do your best focused work in the morning",
          scope: { kind: "global" },
        },
        reason: "ambiguous",
        reasons: ["ambiguous"],
      }),
    );

    expect(item).toMatchObject({
      category: "Preferences",
      statement: "You do your best focused work in the morning.",
      reason: "ambiguous",
      canEdit: true,
      editableText: "You do your best focused work in the morning",
    });
    expect(JSON.stringify(item)).not.toContain("working_style");
  });
});

function fact(overrides: Partial<FactView> = {}): FactView {
  return {
    id: 1,
    subject_id: 1,
    predicate: "likes",
    object: "tea",
    object_entity_id: null,
    confidence: 0.98,
    valid_from: timestamp,
    valid_to: null,
    superseded_by: null,
    source_message_id: 7,
    assertion_count: 1,
    last_seen_at: timestamp,
    created_at: timestamp,
    subject_name: "You",
    subject_slug: "self",
    object_entity_name: null,
    object_entity_slug: null,
    ...overrides,
  };
}

function facet(overrides: Partial<UnderstandingFacetView> = {}): UnderstandingFacetView {
  return {
    id: 2,
    kind: "preference",
    statement: "You prefer concise explanations",
    scope_kind: "global",
    scope_label: null,
    scope_entity_id: null,
    scope_goal_id: null,
    scope_commitment_id: null,
    condition_text: null,
    condition_json: null,
    importance: "normal",
    sensitivity: "normal",
    confidence: 0.8,
    machine_effect: null,
    valid_from: timestamp,
    valid_to: null,
    superseded_by: null,
    source_message_id: 7,
    created_at: timestamp,
    updated_at: timestamp,
    scope_entity_name: null,
    scope_entity_slug: null,
    scope_goal_title: null,
    scope_commitment_title: null,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<CandidateView> & Pick<CandidateView, "kind" | "payload" | "reason" | "reasons">,
): CandidateView {
  const { kind, payload, reason, reasons, ...rest } = overrides;
  return {
    id: 3,
    kind,
    payload_json: JSON.stringify(payload),
    payload,
    reason,
    reasons_json: JSON.stringify(reasons),
    reasons,
    confidence: 0.66,
    source_message_id: 7,
    status: "pending",
    dedupe_key: "test",
    origin: "live",
    backfill_job_id: null,
    resolved_at: null,
    created_at: timestamp,
    source_excerpt: "I recently moved to Singapore.",
    evidence: [],
    ...rest,
  };
}

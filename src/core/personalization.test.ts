import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { selfEntity } from "./entities";
import { recordFacet } from "./facets";
import { recordFact } from "./facts";
import { createCommitment } from "./intentions";
import { ensureEvidencePassage } from "./passages";
import {
  acceptBehavioralPolicySuggestionForReview,
  aggregateBehavioralSignals,
  computePersonalizationProfile,
  dismissBehavioralPolicySuggestion,
  getBehavioralPolicySuggestion,
  listBehavioralPolicySuggestions,
  materializeBehavioralPolicySuggestions,
} from "./personalization";
import { conversationDependencies, deleteConversationWithMemory } from "./retention";

let db: Db;

beforeEach(() => {
  vi.stubEnv("ZEUS_EMBEDDINGS", "off");
  db = openTestDb();
});

function userMessage(content: string) {
  const conversation = createConversation(db);
  return appendMessage(db, conversation.id, "user", content);
}

function addFacet(
  content: string,
  input: {
    kind?: "preference" | "routine" | "communication_style" | "working_style" | "boundary" | "constraint";
    statement: string;
    machineEffect?: "boost" | "deprioritize" | "block" | null;
    condition?: string | null;
    structuredCondition?: {
      weekdays?: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
      local_time?: { start: string; end: string };
      zones?: string[];
      expires_at?: string;
    };
  },
) {
  const source = userMessage(content);
  const passage = ensureEvidencePassage(db, {
    messageId: source.id,
    quote: content,
    sensitivity: "normal",
    recallStatus: "allowed",
  });
  return recordFacet(db, {
    kind: input.kind ?? "preference",
    statement: input.statement,
    condition: input.condition,
    structuredCondition: input.structuredCondition,
    machineEffect: input.machineEffect,
    sourceMessageId: source.id,
    passageIds: [passage.id],
  });
}

describe("computed personalization", () => {
  it("uses only current, accepted, evidence-backed self memory and preserves provenance", () => {
    const likeSource = userMessage("I like espresso.");
    const likePassage = ensureEvidencePassage(db, {
      messageId: likeSource.id,
      quote: likeSource.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const liked = recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "likes",
      object: "espresso",
      sourceMessageId: likeSource.id,
      passageId: likePassage.id,
    }).fact;
    recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "likes",
      object: "legacy unsourced item",
    });
    const irrelevantSource = userMessage("I work at Northstar.");
    recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "works_at",
      object: "Northstar",
      sourceMessageId: irrelevantSource.id,
    });

    const style = addFacet("Please keep explanations concise.", {
      kind: "communication_style",
      statement: "Prefers concise explanations",
    });
    const profile = computePersonalizationProfile(db);

    expect(profile.items.map((item) => item.statement)).toEqual([
      "Prefers concise explanations",
      "espresso",
    ]);
    expect(profile.items.find((item) => item.id === `fact:${liked.id}`)?.provenance)
      .toMatchObject({
        source_kind: "fact",
        source_id: liked.id,
        source_message_id: likeSource.id,
        passage_ids: [likePassage.id],
      });
    expect(profile.items.find((item) => item.id === `facet:${style.id}`)?.provenance)
      .toMatchObject({
        source_kind: "facet",
        source_id: style.id,
        source_message_id: style.source_message_id,
      });
    expect(profile.items.some((item) => item.statement === "legacy unsourced item")).toBe(false);
    expect(profile.items.some((item) => item.statement === "Northstar")).toBe(false);
  });

  it("keeps approved machine effects in a distinct policy view", () => {
    const facet = addFacet("At work, block reminders outside weekday mornings.", {
      kind: "boundary",
      statement: "Do not interrupt outside weekday mornings",
      machineEffect: "block",
      condition: "During weekday mornings",
      structuredCondition: {
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
        local_time: { start: "08:00", end: "12:00" },
      },
    });

    const profile = computePersonalizationProfile(db);
    const descriptive = profile.items.find((item) => item.id === `facet:${facet.id}`);

    expect(descriptive).toBeDefined();
    expect(descriptive).not.toHaveProperty("machine_effect");
    expect(profile.approved_machine_effects).toEqual([
      expect.objectContaining({
        facet_id: facet.id,
        effect: "block",
        condition_json: JSON.stringify({
          weekdays: ["mon", "tue", "wed", "thu", "fri"],
          local_time: { start: "08:00", end: "12:00" },
        }),
      }),
    ]);
  });

  it("surfaces conservative conflict groups without selecting a winner", () => {
    for (const [predicate, object] of [
      ["likes", "open offices"],
      ["dislikes", "open offices"],
    ] as const) {
      const source = userMessage(`I ${predicate} ${object}.`);
      recordFact(db, {
        subjectId: selfEntity(db).id,
        predicate,
        object,
        sourceMessageId: source.id,
      });
    }
    const concise = addFacet("Keep responses short.", {
      statement: "Prefers short responses",
    });
    const detailed = addFacet("Give me detailed responses.", {
      statement: "Prefers detailed responses",
    });
    const unrelated = addFacet("I prefer tea for afternoon breaks.", {
      statement: "Prefers tea for afternoon breaks",
    });

    const profile = computePersonalizationProfile(db);

    expect(profile.conflicts).toHaveLength(2);
    expect(profile.conflicts).toContainEqual({
      item_ids: expect.arrayContaining([`facet:${concise.id}`, `facet:${detailed.id}`]),
      reasons: ["opposing_terms"],
    });
    expect(profile.conflicts.some((group) => group.item_ids.includes(`facet:${unrelated.id}`)))
      .toBe(false);
    expect(profile.items.filter((item) => item.id === `facet:${concise.id}`)).toHaveLength(1);
    expect(profile.items.filter((item) => item.id === `facet:${detailed.id}`)).toHaveLength(1);
  });
});

describe("non-canonical behavioral signals", () => {
  it("ignores surfaced opportunities and only proposes non-expansive review after repetition", () => {
    const source = userMessage("I need to research local backup options.");
    const commitment = createCommitment(db, {
      title: "Research local backup options",
      sourceMessageId: source.id,
    });
    for (let index = 0; index < 8; index += 1) {
      insertFollowThroughEvent({
        commitmentId: commitment.id,
        eventType: "surfaced",
        sourceKind: "system",
        sourceMessageId: null,
        createdAt: `2026-08-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      insertFollowThroughEvent({
        commitmentId: commitment.id,
        eventType: "dismissed",
        sourceKind: "user_action",
        sourceMessageId: index === 0 ? source.id : null,
        detail: index === 0 ? { user_reason: "Not during focus time" } : null,
        createdAt: `2026-09-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      });
    }

    const factCount = rowCount("fact");
    const facetCount = rowCount("understanding_facet");
    const eventCount = rowCount("follow_through_event");
    const summary = aggregateBehavioralSignals(db);

    expect(summary.events).toHaveLength(3);
    expect(summary.events[0]?.event_type).toBe("dismissed");
    expect(summary.events.at(-1)?.user_reason).toBe("Not during focus time");
    expect(summary.repeated_patterns).toEqual([
      expect.objectContaining({
        key: "dismissed:research",
        count: 3,
        event_ids: expect.arrayContaining(summary.events.map((event) => event.id)),
      }),
    ]);
    expect(summary.review_suggestions).toEqual([
      expect.objectContaining({
        kind: "temporary_suppression",
        allowed_interruption_change: "suppress_only",
        canonical: false,
      }),
    ]);
    expect(rowCount("fact")).toBe(factCount);
    expect(rowCount("understanding_facet")).toBe(facetCount);
    expect(rowCount("follow_through_event")).toBe(eventCount);
  });

  it("keeps repeated completion review neutral and applies a minimum threshold of two", () => {
    const source = userMessage("Draft the weekly comparison.");
    const commitment = createCommitment(db, {
      title: "Draft the weekly comparison",
      sourceMessageId: source.id,
    });
    for (let index = 0; index < 2; index += 1) {
      insertFollowThroughEvent({
        commitmentId: commitment.id,
        eventType: "completed",
        sourceKind: "message",
        sourceMessageId: source.id,
        createdAt: `2026-10-0${index + 1}T08:00:00.000Z`,
      });
    }

    const summary = aggregateBehavioralSignals(db, { repeatThreshold: 1 });
    expect(summary.repeated_patterns).toHaveLength(1);
    expect(summary.review_suggestions[0]).toMatchObject({
      kind: "confirm_routine",
      allowed_interruption_change: "none",
      canonical: false,
    });
    expect(materializeBehavioralPolicySuggestions(db, { repeatThreshold: 1 })[0])
      .toMatchObject({
        kind: "confirm_routine",
        allowed_interruption_change: "none",
        minimum_evidence_count: 2,
      });
  });

  it("persists exact explicit evidence with append-only, non-expansive review history", () => {
    const source = userMessage("Stop offering research during focus time.");
    const commitment = createCommitment(db, {
      title: "Research backup providers",
      sourceMessageId: source.id,
    });
    const feedbackIds: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      feedbackIds.push(
        insertFollowThroughEvent({
          commitmentId: commitment.id,
          eventType: "dismissed",
          sourceKind: "message",
          sourceMessageId: source.id,
          createdAt: `2026-11-0${index + 1}T08:00:00.000Z`,
        }),
      );
    }
    const factCount = rowCount("fact");
    const facetCount = rowCount("understanding_facet");
    const settingBefore = db
      .prepare("SELECT * FROM stewardship_setting WHERE id = 1")
      .get();

    const [suggestion] = materializeBehavioralPolicySuggestions(db);
    expect(suggestion).toMatchObject({
      status: "pending",
      kind: "temporary_suppression",
      allowed_interruption_change: "suppress_only",
      evidence_event_ids: feedbackIds,
      minimum_evidence_count: 3,
    });
    expect(materializeBehavioralPolicySuggestions(db)[0]?.id).toBe(suggestion?.id);
    expect(listBehavioralPolicySuggestions(db)).toHaveLength(1);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM behavioral_policy_suggestion_event")
        .get(),
    ).toMatchObject({ count: 1 });

    const acceptedSource = appendMessage(
      db,
      createConversation(db).id,
      "user",
      "Yes, keep this suggestion for review.",
      { origin: "user_action", recallState: "blocked" },
    );
    const accepted = acceptBehavioralPolicySuggestionForReview(
      db,
      suggestion!.id,
      acceptedSource.id,
      "I want to decide the duration later.",
    );
    expect(accepted?.status).toBe("accepted_for_review");
    expect(accepted?.events.at(-1)).toMatchObject({
      event_type: "accepted_for_review",
      source_message_id: acceptedSource.id,
      source_kind: "user_action",
    });

    const dismissedSource = userMessage("Dismiss that policy suggestion.");
    const dismissed = dismissBehavioralPolicySuggestion(
      db,
      suggestion!.id,
      dismissedSource.id,
    );
    expect(dismissed?.status).toBe("dismissed");
    expect(dismissed?.events.map((event) => event.event_type)).toEqual([
      "materialized",
      "accepted_for_review",
      "dismissed",
    ]);
    expect(listBehavioralPolicySuggestions(db, { status: "pending" })).toEqual([]);
    expect(listBehavioralPolicySuggestions(db, { status: "dismissed" })[0]?.id)
      .toBe(suggestion?.id);

    expect(rowCount("fact")).toBe(factCount);
    expect(rowCount("understanding_facet")).toBe(facetCount);
    expect(db.prepare("SELECT * FROM stewardship_setting WHERE id = 1").get())
      .toEqual(settingBefore);
    expect(() =>
      db
        .prepare("UPDATE behavioral_policy_suggestion_event SET source_kind = 'system'")
        .run(),
    ).toThrow(/append-only/u);
  });

  it("database constraints reject surfaced or mismatched events as policy evidence", () => {
    const source = userMessage("I dismissed three research offers.");
    const commitment = createCommitment(db, {
      title: "Research providers",
      sourceMessageId: source.id,
    });
    for (let index = 0; index < 3; index += 1) {
      insertFollowThroughEvent({
        commitmentId: commitment.id,
        eventType: "dismissed",
        sourceKind: "message",
        sourceMessageId: source.id,
        createdAt: `2026-12-0${index + 1}T08:00:00.000Z`,
      });
    }
    const suggestion = materializeBehavioralPolicySuggestions(db)[0]!;
    const surfacedId = insertFollowThroughEvent({
      commitmentId: commitment.id,
      eventType: "surfaced",
      sourceKind: "system",
      sourceMessageId: null,
      createdAt: "2026-12-10T08:00:00.000Z",
    });
    const completedId = insertFollowThroughEvent({
      commitmentId: commitment.id,
      eventType: "completed",
      sourceKind: "message",
      sourceMessageId: source.id,
      createdAt: "2026-12-11T08:00:00.000Z",
    });

    for (const eventId of [surfacedId, completedId]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO behavioral_policy_suggestion_evidence
               (suggestion_id, follow_through_event_id, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(suggestion.id, eventId, "2026-12-12T08:00:00.000Z"),
      ).toThrow(/explicit user event/u);
    }
  });

  it("source deletion removes event evidence and prunes suggestions below threshold", () => {
    const feedbackConversation = createConversation(db);
    const source = appendMessage(
      db,
      feedbackConversation.id,
      "user",
      "I explicitly dismissed these research offers.",
    );
    const commitment = createCommitment(db, {
      title: "Research an archive",
      sourceMessageId: source.id,
    });
    for (let index = 0; index < 3; index += 1) {
      insertFollowThroughEvent({
        commitmentId: commitment.id,
        eventType: "dismissed",
        sourceKind: "message",
        sourceMessageId: source.id,
        createdAt: `2027-01-0${index + 1}T08:00:00.000Z`,
      });
    }
    const suggestion = materializeBehavioralPolicySuggestions(db)[0]!;
    expect(conversationDependencies(db, feedbackConversation.id)).toMatchObject({
      followThroughEvents: 3,
      behavioralPolicySuggestions: 1,
    });

    deleteConversationWithMemory(db, feedbackConversation.id);

    expect(getBehavioralPolicySuggestion(db, suggestion.id)).toBeNull();
    expect(listBehavioralPolicySuggestions(db)).toEqual([]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM behavioral_policy_suggestion_event")
        .get(),
    ).toMatchObject({ count: 0 });
  });
});

function insertFollowThroughEvent(input: {
  commitmentId: number;
  eventType: "surfaced" | "dismissed" | "snoozed" | "completed" | "regretted";
  sourceKind: "system" | "message" | "user_action";
  sourceMessageId: number | null;
  createdAt: string;
  detail?: Record<string, unknown> | null;
}): number {
  const result = db.prepare<[
    number,
    string,
    string,
    string,
    string,
    string | null,
    number | null,
    string,
    string,
  ]>(
    `INSERT INTO follow_through_event
       (commitment_id, event_type, reason, action_kind, effect_kind, detail_json,
        source_message_id, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.commitmentId,
    input.eventType,
    "relevant",
    "research",
    "web_read",
    input.detail ? JSON.stringify(input.detail) : null,
    input.sourceMessageId,
    input.sourceKind,
    input.createdAt,
  );
  return Number(result.lastInsertRowid);
}

function rowCount(table: "fact" | "understanding_facet" | "follow_through_event"): number {
  return db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get()
    ?.count ?? 0;
}

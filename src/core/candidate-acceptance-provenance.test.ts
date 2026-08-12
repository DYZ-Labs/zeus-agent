import { describe, expect, it } from "vitest";

import {
  getCandidate,
  recordCandidateResolution,
  resolveCandidate,
} from "./candidates";
import { appendMessage, createConversation } from "./conversations";
import { openTestDb } from "./db";
import { searchEpisodes } from "./episodes";
import { acceptCandidate, applyExtraction } from "./extract";
import { evidenceForFacet } from "./facets";
import { evidenceForFact, getFact } from "./facts";
import { commitmentEvents, goalEvents } from "./intentions";
import { ensureEvidencePassage, getPassage } from "./passages";
import type {
  ExtractedCommitment,
  ExtractedFacet,
  ExtractedFact,
  ExtractedGoal,
  Extraction,
} from "./schema";

function extraction(partial: Partial<Extraction>): Extraction {
  return { entities: [], facts: [], ...partial };
}

function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    subject: "self",
    predicate: "lives_in",
    object: "Berlin",
    object_entity: null,
    confidence: 0.95,
    supersedes_previous: false,
    ...overrides,
  };
}

function goal(title: string): ExtractedGoal {
  return {
    existing_id: null,
    title,
    status: "active",
    priority: { op: "set", value: "high" },
    target_at: { op: "clear" },
    project: { op: "clear" },
    confidence: 0.95,
  };
}

function commitment(title: string): ExtractedCommitment {
  return {
    existing_id: null,
    title,
    owner: { op: "clear" },
    linked_goal: { op: "clear" },
    status: "open",
    due_at: { op: "clear" },
    project: { op: "clear" },
    confidence: 0.95,
  };
}

function facet(statement: string): ExtractedFacet {
  return {
    kind: "working_style",
    statement,
    scope: { kind: "global" },
    condition: null,
    structured_condition: null,
    importance: "normal",
    machine_effect: null,
    confidence: 0.95,
    effective_from: null,
    evidence: [],
  };
}

function curationSource(
  db: ReturnType<typeof openTestDb>,
  candidateId: number,
): {
  id: number;
  content: string;
  origin: string;
  recall_state: string;
  cross_chat_recall_eligible: number;
  title: string | null;
  decision: string;
  source_kind: string;
  edited_payload_json: string | null;
} {
  const row = db
    .prepare<
      [number],
      {
        id: number;
        content: string;
        origin: string;
        recall_state: string;
        cross_chat_recall_eligible: number;
        title: string | null;
        decision: string;
        source_kind: string;
        edited_payload_json: string | null;
      }
    >(
      `SELECT m.id, m.content, m.origin, m.recall_state,
              m.cross_chat_recall_eligible, c.title, r.decision,
              r.source_kind, r.edited_payload_json
       FROM candidate_resolution_event r
       JOIN message m ON m.id = r.source_message_id
       JOIN conversation c ON c.id = m.conversation_id
       WHERE r.candidate_id = ? ORDER BY r.id DESC LIMIT 1`,
    )
    .get(candidateId);
  if (!row) throw new Error("Missing sourced candidate resolution");
  return row;
}

function expectHiddenUserAction(
  source: ReturnType<typeof curationSource>,
  approvedText: string,
): void {
  expect(source).toMatchObject({
    origin: "user_action",
    recall_state: "blocked",
    cross_chat_recall_eligible: 0,
    title: "Memory curation",
    decision: "edited_accepted",
    source_kind: "user_action",
  });
  expect(source.content).toContain(approvedText);
  expect(source.edited_payload_json).toContain(approvedText);
}

describe("edited candidate acceptance provenance", () => {
  it("versions a fact from the newly approved wording and retains the proposal audit", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const original = appendMessage(db, conversation.id, "user", "I live in Lisbon.");
    const proposal = appendMessage(db, conversation.id, "user", "I live in Berlin.");
    const lisbon = applyExtraction(
      db,
      extraction({ facts: [fact({ object: "Lisbon" })] }),
      original.id,
    ).facts[0]!;
    const candidate = applyExtraction(
      db,
      extraction({ facts: [fact()] }),
      proposal.id,
    ).candidates[0]!;

    const accepted = acceptCandidate(db, candidate.id, {
      textEdit: { text: "Copenhagen" },
    })!;
    const written = accepted.facts[0]!;
    const source = curationSource(db, candidate.id);

    expectHiddenUserAction(source, "Copenhagen");
    expect(source.id).not.toBe(proposal.id);
    expect(written).toMatchObject({ object: "Copenhagen", source_message_id: source.id });
    expect(evidenceForFact(db, written.id).map((entry) => entry.source_message_id)).toEqual([
      source.id,
    ]);
    expect(getFact(db, lisbon.id)).toMatchObject({
      superseded_by: written.id,
    });
    expect(getFact(db, lisbon.id)?.valid_to).not.toBeNull();
    expect(getCandidate(db, candidate.id)).toMatchObject({
      source_message_id: proposal.id,
      status: "accepted",
    });
    expect(candidate.evidence.map((passage) => getPassage(db, passage.id)?.recall_status)).toEqual([
      "pending",
    ]);
    expect(await searchEpisodes(db, "Berlin", { queryVector: null })).toEqual([]);
  });

  it("sources an edited facet and its accepted event only from the curation action", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const proposal = appendMessage(
      db,
      conversation.id,
      "user",
      "I prefer important decisions in writing.",
    );
    const candidate = applyExtraction(
      db,
      extraction({ facets: [facet(proposal.content)] }),
      proposal.id,
      { forceReview: true },
    ).candidates[0]!;

    const accepted = acceptCandidate(db, candidate.id, {
      facetEdit: {
        statement: "Give me important decisions in writing.",
        machineEffect: "deprioritize",
        structuredCondition: null,
      },
    })!;
    const written = accepted.facets[0]!;
    const source = curationSource(db, candidate.id);

    expectHiddenUserAction(source, "Give me important decisions in writing.");
    expect(written).toMatchObject({
      statement: "Give me important decisions in writing.",
      source_message_id: source.id,
      machine_effect: "deprioritize",
    });
    expect(evidenceForFacet(db, written.id).map((entry) => entry.source_message_id)).toEqual([
      source.id,
    ]);
    expect(
      db.prepare<[number], { source_message_id: number; source_kind: string }>(
        `SELECT source_message_id, source_kind FROM facet_event
         WHERE facet_id = ? AND event_type = 'accepted'`,
      ).get(written.id),
    ).toEqual({ source_message_id: source.id, source_kind: "user_action" });
    expect(getCandidate(db, candidate.id)?.source_message_id).toBe(proposal.id);
  });

  it("sources an edited goal and append-only lifecycle event from the curation action", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const proposal = appendMessage(db, conversation.id, "user", "I want to launch a site.");
    const candidate = applyExtraction(
      db,
      extraction({ goals: [goal("Launch a site")] }),
      proposal.id,
      { forceReview: true },
    ).candidates[0]!;

    const accepted = acceptCandidate(db, candidate.id, {
      textEdit: { text: "Launch my portfolio" },
    })!;
    const written = accepted.goals[0]!;
    const source = curationSource(db, candidate.id);

    expectHiddenUserAction(source, "Launch my portfolio");
    expect(written).toMatchObject({
      title: "Launch my portfolio",
      source_message_id: source.id,
    });
    expect(goalEvents(db, written.id)).toMatchObject([
      { event_type: "created", source_message_id: source.id, source_kind: "user_action" },
    ]);
    expect(getCandidate(db, candidate.id)?.source_message_id).toBe(proposal.id);
  });

  it("sources an edited commitment and append-only lifecycle event from the curation action", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const proposal = appendMessage(db, conversation.id, "user", "I need to draft the memo.");
    const candidate = applyExtraction(
      db,
      extraction({ commitments: [commitment("Draft the memo")] }),
      proposal.id,
      { forceReview: true },
    ).candidates[0]!;

    const accepted = acceptCandidate(db, candidate.id, {
      textEdit: { text: "Draft the launch memo" },
    })!;
    const written = accepted.commitments[0]!;
    const source = curationSource(db, candidate.id);

    expectHiddenUserAction(source, "Draft the launch memo");
    expect(written).toMatchObject({
      title: "Draft the launch memo",
      source_message_id: source.id,
    });
    expect(commitmentEvents(db, written.id)).toMatchObject([
      { event_type: "created", source_message_id: source.id, source_kind: "user_action" },
    ]);
    expect(getCandidate(db, candidate.id)?.source_message_id).toBe(proposal.id);
  });
});

describe("candidate passage isolation", () => {
  it("keeps a shared passage private while any mixed-kind proposal is pending or rejected", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "I may move to Berlin and I might take a sabbatical.",
    );
    const shared = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const factCandidate = applyExtraction(
      db,
      extraction({
        facts: [
          fact({
            evidence: [{ source_message_id: source.id, quote: source.content }],
            ambiguity: "ambiguous",
          }),
        ],
      }),
      source.id,
    ).candidates[0]!;
    const goalCandidate = applyExtraction(
      db,
      extraction({
        goals: [
          {
            ...goal("Take a sabbatical"),
            evidence: [{ source_message_id: source.id, quote: source.content }],
            ambiguity: "ambiguous",
          },
        ],
      }),
      source.id,
    ).candidates[0]!;

    expect(factCandidate.kind).toBe("fact");
    expect(goalCandidate.kind).toBe("goal");
    expect(factCandidate.evidence[0]?.id).toBe(shared.id);
    expect(goalCandidate.evidence[0]?.id).toBe(shared.id);

    expect(acceptCandidate(db, factCandidate.id)?.facts).toHaveLength(1);
    expect(getPassage(db, shared.id)?.recall_status).not.toBe("allowed");
    expect(await searchEpisodes(db, "Berlin sabbatical", { queryVector: null })).toEqual([]);

    expect(resolveCandidate(db, goalCandidate.id, "rejected")).toBe(true);
    recordCandidateResolution(db, {
      candidateId: goalCandidate.id,
      decision: "rejected",
      sourceKind: "user_action",
    });
    expect(await searchEpisodes(db, "Berlin sabbatical", { queryVector: null })).toEqual([]);
    expect(
      db.prepare<[number], { decision: string; source_message_id: number | null }>(
        `SELECT decision, source_message_id FROM candidate_resolution_event
         WHERE candidate_id = ? ORDER BY id DESC LIMIT 1`,
      ).get(goalCandidate.id),
    ).toEqual({ decision: "rejected", source_message_id: null });
  });
});

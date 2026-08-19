import { afterEach, describe, expect, it, vi } from "vitest";

import { acceptCandidate, applyExtraction } from "./extract";
import {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
} from "./conversations";
import { recordResponseContext } from "./context";
import { openTestDb } from "./db";
import { searchEpisodes } from "./episodes";
import { allowWholeMessagePassage } from "./passages";
import {
  addFactEvidence,
  evidenceForFact,
  getFact,
  liveFacts,
  supersedeFact,
} from "./facts";
import {
  commitmentEvents,
  createCommitment,
  goalEvents,
  listCommitments,
  listGoals,
  markCommitmentSurfaced,
  updateCommitment,
  updateGoal,
} from "./intentions";
import { selfEntity } from "./entities";
import {
  deleteAllConversationsWithMemory,
  deleteConversationWithMemory,
} from "./retention";
import {
  recalledForResponse,
  responseSelectionsForResponse,
} from "./response-context";
import type { ExtractedFact, Extraction } from "./schema";
import { recommendNextAction, setStewardshipMode } from "./stewardship";

afterEach(() => vi.unstubAllEnvs());

function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    subject: "self",
    predicate: "lives_in",
    object: "Lisbon",
    object_entity: null,
    confidence: 0.95,
    supersedes_previous: false,
    ...overrides,
  };
}

function extraction(partial: Partial<Extraction>): Extraction {
  return { entities: [], facts: [], ...partial };
}

describe("evidence and trust gating", () => {
  it("records every independent assertion as evidence", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const firstSource = appendMessage(db, conversation.id, "user", "I live in Lisbon.");
    const secondSource = appendMessage(db, conversation.id, "user", "Yes, Lisbon is still home.");

    const first = applyExtraction(db, extraction({ facts: [fact()] }), firstSource.id).facts[0];
    expect(first).toBeDefined();
    applyExtraction(db, extraction({ facts: [fact()] }), secondSource.id);
    applyExtraction(db, extraction({ facts: [fact()] }), secondSource.id);

    const evidence = evidenceForFact(db, first!.id);
    expect(evidence.map((entry) => entry.source_message_id)).toEqual([
      firstSource.id,
      secondSource.id,
    ]);
    expect(evidence.map((entry) => entry.kind)).toEqual(["assertion", "reassertion"]);
    expect(getFact(db, first!.id)?.assertion_count).toBe(2);
  });

  it("holds an unexplained single-value conflict until the user accepts it", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const lisbon = appendMessage(db, conversation.id, "user", "I live in Lisbon.");
    const berlin = appendMessage(db, conversation.id, "user", "I live in Berlin.");
    applyExtraction(db, extraction({ facts: [fact()] }), lisbon.id);

    const proposed = applyExtraction(
      db,
      extraction({ facts: [fact({ object: "Berlin" })] }),
      berlin.id,
    );
    expect(proposed.facts).toHaveLength(0);
    expect(proposed.candidates).toHaveLength(1);
    expect(proposed.candidates[0]?.reason).toBe("conflict");
    expect(liveFacts(db, selfEntity(db).id, "lives_in").map((row) => row.object)).toEqual([
      "Lisbon",
    ]);

    const accepted = acceptCandidate(db, proposed.candidates[0]!.id);
    expect(accepted?.facts[0]?.object).toBe("Berlin");
    expect(liveFacts(db, selfEntity(db).id, "lives_in").map((row) => row.object)).toEqual([
      "Berlin",
    ]);
    expect(getFact(db, accepted!.supersededIds[0]!)?.valid_to).not.toBeNull();
  });

  it("does not trust a model change hint without change language from the user", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const lisbon = appendMessage(db, conversation.id, "user", "I live in Lisbon.");
    const berlin = appendMessage(db, conversation.id, "user", "I live in Berlin.");
    applyExtraction(db, extraction({ facts: [fact()] }), lisbon.id);

    const result = applyExtraction(
      db,
      extraction({ facts: [fact({ object: "Berlin", supersedes_previous: true })] }),
      berlin.id,
    );
    expect(result.facts).toHaveLength(0);
    expect(result.candidates[0]?.reason).toBe("conflict");
  });

  it("automatically versions an explicit life change", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const before = appendMessage(db, conversation.id, "user", "I live in Lisbon.");
    const after = appendMessage(db, conversation.id, "user", "I moved to Berlin.");
    applyExtraction(db, extraction({ facts: [fact()] }), before.id);
    const changed = applyExtraction(
      db,
      extraction({
        facts: [fact({ object: "Berlin", supersedes_previous: true, effective_from: "2026-08-01" })],
      }),
      after.id,
    );

    expect(changed.candidates).toHaveLength(0);
    expect(changed.supersededIds).toHaveLength(1);
    expect(changed.facts[0]?.valid_from).toBe("2026-08-01T00:00:00.000Z");
  });

  it("queues inferred and sensitive memories but discards assistant-only claims", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "We were discussing my options.");
    const result = applyExtraction(
      db,
      extraction({
        facts: [
          fact({ predicate: "likes", object: "chess", explicitness: "inferred" }),
          fact({ predicate: "note", object: "medical detail", sensitivity: "sensitive" }),
          fact({ predicate: "works_at", object: "Imaginary Co", grounding: "assistant_only" }),
        ],
      }),
      source.id,
    );

    expect(result.candidates.map((candidate) => candidate.reason)).toEqual([
      "inference",
      "sensitive",
    ]);
    expect(result.skipped[0]?.reason).toMatch(/assistant text/u);
    expect(result.facts).toHaveLength(0);

    const healthSource = appendMessage(
      db,
      conversation.id,
      "user",
      "I was diagnosed with a private condition.",
    );
    const policyCaught = applyExtraction(
      db,
      extraction({ facts: [fact({ predicate: "note", object: "private condition" })] }),
      healthSource.id,
    );
    expect(policyCaught.candidates[0]?.reason).toBe("sensitive");
  });
});

describe("goals, commitments, and nudges", () => {
  it("tracks intention state through append-only events", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const created = appendMessage(
      db,
      conversation.id,
      "user",
      "I want to launch my portfolio, and I need to write the case study.",
    );
    const goalResult = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: null,
            title: "Launch my portfolio",
            status: "active",
            target_at: "2026-09-01",
            confidence: 0.95,
          },
        ],
      }),
      created.id,
    );
    const goal = goalResult.goals[0]!;
    const commitmentResult = applyExtraction(
      db,
      extraction({
        commitments: [
          {
            existing_id: null,
            title: "Write the portfolio case study",
            owner: "self",
            linked_goal_id: goal.id,
            status: "open",
            due_at: "2026-08-20",
            confidence: 0.95,
          },
        ],
      }),
      created.id,
    );
    const commitment = commitmentResult.commitments[0]!;
    const completed = appendMessage(db, conversation.id, "user", "I finished the case study.");
    applyExtraction(
      db,
      extraction({
        commitments: [
          {
            existing_id: commitment.id,
            title: commitment.title,
            owner: "self",
            linked_goal_id: goal.id,
            status: "done",
            due_at: commitment.due_at,
            confidence: 0.98,
          },
        ],
      }),
      completed.id,
    );

    expect(listGoals(db)[0]?.title).toBe("Launch my portfolio");
    expect(goalEvents(db, goal.id).map((event) => event.event_type)).toEqual(["created"]);
    expect(listCommitments(db, { includeClosed: true })[0]?.status).toBe("done");
    expect(commitmentEvents(db, commitment.id).map((event) => event.event_type)).toEqual([
      "created",
      "status_changed",
    ]);
  });

  it("surfaces one relevant or overdue commitment and applies cooldown", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I need to send the deck.");
    // Ranking and cooldown are what this test is about, and neither runs unless the user
    // opted into unsolicited surfacing. The `today` trigger below is explicit either way.
    setStewardshipMode(db, "balanced", source.id);
    const commitment = createCommitment(db, {
      title: "Send the launch deck",
      dueAt: "2020-01-01",
      sourceMessageId: source.id,
    });

    expect(
      recommendNextAction(db, "unrelated question", { trigger: "today" })?.commitment_id,
    ).toBe(commitment.id);
    markCommitmentSurfaced(db, commitment.id);
    expect(recommendNextAction(db, "launch deck")).toBeNull();
    expect(commitmentEvents(db, commitment.id).at(-1)?.event_type).toBe("surfaced");
    createCommitment(db, {
      title: "Book the dentist",
      sourceMessageId: source.id,
    });
    expect(recommendNextAction(db, "unrelated question")).toBeNull();
    expect(
      recommendNextAction(db, "dentist appointment")?.commitment_title,
    ).toBe("Book the dentist");
  });
});

describe("episodic recall and source deletion", () => {
  it("retrieves user-authored episodes and never assistant-only text", async () => {
    vi.stubEnv("ZEUS_EMBEDDINGS", "off");
    const db = openTestDb();
    const conversation = createConversation(db, { title: "Ideas" });
    const user = appendMessage(
      db,
      conversation.id,
      "user",
      "Project Aurora should make private journaling feel calm and local-first.",
    );
    appendMessage(
      db,
      conversation.id,
      "assistant",
      "The user definitely plans to sell Project Aurora next week.",
    );

    expect(await searchEpisodes(db, "Project Aurora", { limit: 10 })).toEqual([]);
    allowWholeMessagePassage(db, user.id);
    const hits = await searchEpisodes(db, "Project Aurora", { limit: 10 });
    expect(hits.map((hit) => hit.message.id)).toEqual([user.id]);
    expect(hits[0]?.message.role).toBe("user");
    expect(
      await searchEpisodes(db, "Project Aurora", { excludeMessageIds: [user.id] }),
    ).toEqual([]);
  });

  it("does not episodically surface sensitive memory before acceptance", async () => {
    vi.stubEnv("ZEUS_EMBEDDINGS", "off");
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "My medical diagnosis is a private condition.",
    );
    const held = applyExtraction(
      db,
      extraction({ facts: [fact({ predicate: "note", object: "private condition" })] }),
      source.id,
    );
    expect(held.candidates[0]?.reason).toBe("sensitive");
    expect(await searchEpisodes(db, "medical diagnosis private condition")).toEqual([]);

    acceptCandidate(db, held.candidates[0]!.id);
    expect(
      (await searchEpisodes(db, "medical diagnosis private condition")).map(
        (episode) => episode.message.id,
      ),
    ).toEqual([source.id]);
  });

  it("rehomes multiply supported facts and removes singly supported memory", () => {
    const db = openTestDb();
    const firstConversation = createConversation(db, { title: "First" });
    const secondConversation = createConversation(db, { title: "Second" });
    const first = appendMessage(db, firstConversation.id, "user", "I live in Lisbon.");
    const second = appendMessage(db, secondConversation.id, "user", "Lisbon is still home.");
    const stored = applyExtraction(db, extraction({ facts: [fact()] }), first.id).facts[0]!;
    applyExtraction(db, extraction({ facts: [fact()] }), second.id);
    const intentions = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: null,
            title: "Plan the move",
            status: "active",
            target_at: null,
            confidence: 0.95,
          },
        ],
        commitments: [
          {
            existing_id: null,
            title: "Compare neighborhoods",
            owner: "self",
            linked_goal_title: "Plan the move",
            status: "open",
            due_at: null,
            confidence: 0.95,
          },
        ],
      }),
      first.id,
    );
    expect(intentions.commitments[0]?.linked_goal_id).toBe(intentions.goals[0]?.id);

    deleteConversationWithMemory(db, firstConversation.id);
    expect(getConversation(db, firstConversation.id)).toBeNull();
    expect(getFact(db, stored.id)?.source_message_id).toBe(second.id);
    expect(evidenceForFact(db, stored.id).map((entry) => entry.source_message_id)).toEqual([
      second.id,
    ]);
    expect(listGoals(db, { includeClosed: true })).toEqual([]);
    expect(listCommitments(db, { includeClosed: true })).toEqual([]);

    deleteConversationWithMemory(db, secondConversation.id);
    expect(getFact(db, stored.id)).toBeNull();
  });

  it("deletes every conversation and memory supported by them", () => {
    const db = openTestDb();
    const firstConversation = createConversation(db, { title: "First" });
    const secondConversation = createConversation(db, { title: "Second" });
    createConversation(db, { title: "Memory curation" });
    const first = appendMessage(db, firstConversation.id, "user", "I live in Lisbon.");
    const second = appendMessage(db, secondConversation.id, "user", "Lisbon is still home.");
    const stored = applyExtraction(db, extraction({ facts: [fact()] }), first.id).facts[0]!;
    applyExtraction(db, extraction({ facts: [fact()] }), second.id);

    expect(deleteAllConversationsWithMemory(db)).toBe(3);
    expect(listConversations(db)).toEqual([]);
    expect(getFact(db, stored.id)).toBeNull();
  });

  it("restores the last supported value when a change source is deleted", () => {
    const db = openTestDb();
    const originalConversation = createConversation(db, { title: "Original" });
    const changeConversation = createConversation(db, { title: "Change" });
    const original = appendMessage(db, originalConversation.id, "user", "I live in Lisbon.");
    const change = appendMessage(db, changeConversation.id, "user", "I moved to Berlin.");
    const lisbon = applyExtraction(db, extraction({ facts: [fact()] }), original.id).facts[0]!;
    applyExtraction(
      db,
      extraction({ facts: [fact({ object: "Berlin", supersedes_previous: true })] }),
      change.id,
    );
    expect(liveFacts(db, selfEntity(db).id, "lives_in")[0]?.object).toBe("Berlin");

    deleteConversationWithMemory(db, changeConversation.id);
    expect(getFact(db, lisbon.id)?.valid_to).toBeNull();
    expect(liveFacts(db, selfEntity(db).id, "lives_in")[0]?.object).toBe("Lisbon");
  });

  it("rehomes and reopens a reasserted fact when its sole correction is deleted", () => {
    const db = openTestDb();
    const deletingConversation = createConversation(db, { title: "Original and correction" });
    const supportingConversation = createConversation(db, { title: "Independent support" });
    const original = appendMessage(
      db,
      deletingConversation.id,
      "user",
      "I live in Lisbon.",
    );
    const supporting = appendMessage(
      db,
      supportingConversation.id,
      "user",
      "Lisbon is still home.",
    );
    const correction = appendMessage(
      db,
      deletingConversation.id,
      "user",
      "That memory is no longer true.",
    );
    const stored = applyExtraction(db, extraction({ facts: [fact()] }), original.id).facts[0]!;
    applyExtraction(db, extraction({ facts: [fact()] }), supporting.id);
    addFactEvidence(db, stored.id, correction.id, "correction", 1);
    supersedeFact(db, stored.id);
    expect(getFact(db, stored.id)?.valid_to).not.toBeNull();

    deleteConversationWithMemory(db, deletingConversation.id);
    expect(getFact(db, stored.id)?.source_message_id).toBe(supporting.id);
    expect(getFact(db, stored.id)?.valid_to).toBeNull();
    expect(evidenceForFact(db, stored.id).map((entry) => entry.source_message_id)).toEqual([
      supporting.id,
    ]);
  });

  it("does not rehome deleted intention text to a later referential update", () => {
    const db = openTestDb();
    const originalConversation = createConversation(db, { title: "Original intent" });
    const updateConversation = createConversation(db, { title: "Intent update" });
    const original = appendMessage(db, originalConversation.id, "user", "I want to launch.");
    const update = appendMessage(db, updateConversation.id, "user", "Pause that for now.");
    const created = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: null,
            title: "Launch the project",
            status: "active",
            target_at: null,
            confidence: 0.95,
          },
        ],
        commitments: [
          {
            existing_id: null,
            title: "Draft the launch plan",
            owner: "self",
            status: "open",
            due_at: null,
            confidence: 0.95,
          },
        ],
      }),
      original.id,
    );
    applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: created.goals[0]!.id,
            title: "Launch the project",
            status: "paused",
            target_at: null,
            confidence: 0.98,
          },
        ],
        commitments: [
          {
            existing_id: created.commitments[0]!.id,
            title: "Draft the launch plan",
            owner: "self",
            status: "waiting",
            due_at: null,
            confidence: 0.98,
          },
        ],
      }),
      update.id,
    );

    deleteConversationWithMemory(db, originalConversation.id);
    expect(listGoals(db)).toEqual([]);
    expect(listCommitments(db)).toEqual([]);
  });
});

describe("response provenance", () => {
  it("keeps an immutable snapshot and removes it with its source", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I want to launch.");
    const assistant = appendMessage(db, conversation.id, "assistant", "Let's plan it.");
    const goal = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: null,
            title: "Launch",
            status: "active",
            target_at: null,
            confidence: 0.95,
          },
        ],
      }),
      source.id,
    ).goals[0]!;
    recordResponseContext(db, assistant.id, [{ kind: "goal", goal }]);
    updateGoal(db, goal.id, { status: "paused", sourceKind: "user_action" });

    const recalled = recalledForResponse(db, assistant.id);
    expect(recalled[0]?.kind).toBe("goal");
    expect(recalled[0]?.kind === "goal" ? recalled[0].goal.status : null).toBe("active");

    deleteConversationWithMemory(db, conversation.id);
    expect(recalledForResponse(db, assistant.id)).toEqual([]);
  });

  it("attributes each current intention field to the event that changed it", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const created = appendMessage(
      db,
      conversation.id,
      "user",
      "Launch is high priority, and the deck is due Friday.",
    );
    const goal = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: null,
            title: "Launch",
            status: "active",
            priority: "high",
            target_at: "2030-01-01",
            confidence: 0.95,
          },
        ],
      }),
      created.id,
    ).goals[0]!;
    const commitment = createCommitment(db, {
      title: "Send the launch deck",
      linkedGoalId: goal.id,
      dueAt: "2030-01-02",
      sourceMessageId: created.id,
    });
    const changed = appendMessage(
      db,
      conversation.id,
      "user",
      "Pause the launch, and move the deck to Monday.",
    );
    const paused = updateGoal(db, goal.id, {
      status: "paused",
      sourceMessageId: changed.id,
      sourceKind: "message",
    })!;
    const rescheduled = updateCommitment(db, commitment.id, {
      dueAt: "2030-01-05",
      sourceMessageId: changed.id,
      sourceKind: "message",
    })!;
    const assistant = appendMessage(db, conversation.id, "assistant", "Understood.");
    recordResponseContext(db, assistant.id, [
      { kind: "goal", goal: paused },
      { kind: "commitment", commitment: rescheduled },
    ]);

    const selections = responseSelectionsForResponse(db, assistant.id);
    const goalTrace = selections.find((selection) => selection.item.kind === "goal");
    const commitmentTrace = selections.find(
      (selection) => selection.item.kind === "commitment",
    );
    expect(goalTrace?.fieldProvenance?.kind).toBe("goal");
    if (goalTrace?.fieldProvenance?.kind === "goal") {
      expect(goalTrace.fieldProvenance.fields.status.source_message_id).toBe(changed.id);
      expect(goalTrace.fieldProvenance.fields.title.source_message_id).toBe(created.id);
      expect(goalTrace.fieldProvenance.fields.priority.source_message_id).toBe(created.id);
      expect(goalTrace.fieldProvenance.fields.target_at.source_message_id).toBe(created.id);
    }
    expect(commitmentTrace?.fieldProvenance?.kind).toBe("commitment");
    if (commitmentTrace?.fieldProvenance?.kind === "commitment") {
      expect(commitmentTrace.fieldProvenance.fields.due_at.source_message_id).toBe(changed.id);
      expect(commitmentTrace.fieldProvenance.fields.title.source_message_id).toBe(created.id);
      expect(commitmentTrace.fieldProvenance.fields.owner_entity_id.source_message_id).toBe(
        created.id,
      );
      expect(commitmentTrace.fieldProvenance.fields.linked_goal_id.source_message_id).toBe(
        created.id,
      );
    }
  });
});

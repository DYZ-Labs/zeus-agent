import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildContext } from "./context";
import { appendMessage, createConversation } from "./conversations";
import { openTestDb } from "./db";
import { applyExtraction } from "./extract";
import {
  createCommitment,
  createGoal,
  getCommitment,
  goalEvents,
  updateCommitment,
  updateGoal,
} from "./intentions";
import { deleteConversationWithMemory } from "./retention";
import { MIGRATIONS } from "./migrations";
import { recalledForResponse } from "./response-context";
import {
  followThroughMetrics,
  listFollowThroughEvents,
  markRecommendationSurfaced,
  recommendationsForResponse,
  recommendNextAction,
  recordFollowThroughDecision,
  setStewardshipMode,
} from "./stewardship";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function source(db: ReturnType<typeof openTestDb>, content = "This matters to me.") {
  const conversation = createConversation(db);
  return appendMessage(db, conversation.id, "user", content);
}

describe("follow-through selection", () => {
  it("uses explicit goal priority and suppresses commitments linked to paused goals", () => {
    const db = openTestDb();
    const message = source(db);
    const low = createGoal(db, {
      title: "Tidy the archive",
      priority: "low",
      sourceMessageId: message.id,
    });
    const high = createGoal(db, {
      title: "Stay close to family",
      priority: "high",
      sourceMessageId: message.id,
    });
    createCommitment(db, {
      title: "Sort old receipts",
      linkedGoalId: low.id,
      sourceMessageId: message.id,
    });
    const call = createCommitment(db, {
      title: "Call Maya",
      linkedGoalId: high.id,
      sourceMessageId: message.id,
    });

    expect(recommendNextAction(db, "", { force: true })?.commitment_id).toBe(call.id);
    updateGoal(db, high.id, { status: "paused", sourceKind: "user_action" });
    expect(recommendNextAction(db, "", { force: true })?.commitment_title).toBe(
      "Sort old receipts",
    );
  });

  it("stays quiet on unrelated new work but notices relevance and severe urgency", () => {
    const db = openTestDb();
    const message = source(db, "I need to book the dentist and send the deck.");
    createCommitment(db, {
      title: "Book the dentist",
      sourceMessageId: message.id,
    });
    const deck = createCommitment(db, {
      title: "Send the launch deck",
      dueAt: "2020-01-01",
      sourceMessageId: message.id,
    });
    setStewardshipMode(db, "quiet");

    expect(recommendNextAction(db, "dentist appointment")?.commitment_title).toBe(
      "Book the dentist",
    );
    expect(recommendNextAction(db, "what is the weather")?.commitment_title).toBe(
      "Send the launch deck",
    );

    updateCommitment(db, deck.id, { status: "done", sourceKind: "user_action" });
    expect(recommendNextAction(db, "what is the weather")).toBeNull();
  });

  it("classifies useful preparation while keeping external action behind confirmation", () => {
    const db = openTestDb();
    const message = source(db);
    createCommitment(db, {
      title: "Schedule Maya's birthday dinner",
      sourceMessageId: message.id,
    });
    const schedule = recommendNextAction(db, "", { force: true });
    expect(schedule?.action_kind).toBe("schedule");
    expect(schedule?.requires_confirmation).toBe(true);
    expect(schedule?.suggested_action).toMatch(/confirm before changing any calendar/u);

    updateCommitment(db, schedule!.commitment_id, {
      title: "Research pottery gifts",
      sourceKind: "user_action",
    });
    const research = recommendNextAction(db, "", { force: true });
    expect(research?.action_kind).toBe("research");
    expect(research?.requires_confirmation).toBe(false);
    expect(research?.chat_prompt).toMatch(/do not send, schedule, purchase/u);
  });

  it("does not recommend an item in the turn where the user closes or defers it", () => {
    const db = openTestDb();
    const message = source(db);
    createCommitment(db, {
      title: "Write the case study",
      dueAt: "2020-01-01",
      sourceMessageId: message.id,
    });

    expect(recommendNextAction(db, "I just finished the case study")).toBeNull();
    expect(recommendNextAction(db, "Not now on the case study")).toBeNull();
    expect(recommendNextAction(db, "Help me finish the case study")).not.toBeNull();
  });
});

describe("user control and outcomes", () => {
  it("honors cooldowns, snoozes, and dismissals until the commitment changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T09:00:00.000Z"));
    const db = openTestDb();
    const message = source(db);
    const commitment = createCommitment(db, {
      title: "Send the overdue note",
      dueAt: "2029-12-20",
      sourceMessageId: message.id,
    });
    const recommendation = recommendNextAction(db, "")!;
    markRecommendationSurfaced(db, recommendation, null);
    expect(recommendNextAction(db, "send note")).toBeNull();

    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "snoozed",
      snoozedUntil: "2030-01-10",
    });
    expect(
      recommendNextAction(db, "", { force: true, referenceTime: new Date("2030-01-09") }),
    ).toBeNull();

    vi.setSystemTime(new Date("2030-01-11T09:00:00.000Z"));
    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "dismissed",
    });
    expect(recommendNextAction(db, "", { force: true })).toBeNull();

    vi.setSystemTime(new Date("2030-01-12T09:00:00.000Z"));
    updateCommitment(db, commitment.id, {
      title: "Send the revised overdue note",
      sourceKind: "user_action",
    });
    expect(recommendNextAction(db, "", { force: true })?.commitment_id).toBe(commitment.id);
  });

  it("records progress, control, and regret as append-only events", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const user = appendMessage(db, conversation.id, "user", "I need to send the deck.");
    const assistant = appendMessage(db, conversation.id, "assistant", "I can help with that.");
    const commitment = createCommitment(db, {
      title: "Send the launch deck",
      dueAt: "2020-01-01",
      sourceMessageId: user.id,
    });
    const recommendation = recommendNextAction(db, "")!;
    markRecommendationSurfaced(db, recommendation, assistant.id);
    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "accepted",
      responseMessageId: assistant.id,
    });
    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "completed",
    });

    expect(getCommitment(db, commitment.id)?.status).toBe("done");
    expect(followThroughMetrics(db)).toMatchObject({
      surfaced: 1,
      accepted: 1,
      progress: 1,
      progressWithoutRegret: 1,
      regrets: 0,
    });
    expect(recommendationsForResponse(db, assistant.id)[0]?.commitment_id).toBe(commitment.id);

    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "regretted",
    });
    expect(followThroughMetrics(db)).toMatchObject({
      progress: 1,
      progressWithoutRegret: 0,
      regrets: 1,
    });
    expect(listFollowThroughEvents(db).map((event) => event.event_type)).toEqual([
      "regretted",
      "completed",
      "accepted",
      "surfaced",
    ]);
  });

  it("removes proposal audit data with a deleted response source", () => {
    const db = openTestDb();
    const original = createConversation(db);
    const surviving = createConversation(db);
    const first = appendMessage(db, original.id, "user", "I need to send the deck.");
    const assistant = appendMessage(db, original.id, "assistant", "I can help.");
    const later = appendMessage(db, surviving.id, "user", "The deck is still open.");
    const commitment = createCommitment(db, {
      title: "Send the launch deck",
      dueAt: "2020-01-01",
      sourceMessageId: first.id,
    });
    updateCommitment(db, commitment.id, {
      sourceMessageId: later.id,
      sourceKind: "message",
    });
    markRecommendationSurfaced(db, recommendNextAction(db, "")!, assistant.id);
    expect(listFollowThroughEvents(db)).toHaveLength(1);

    deleteConversationWithMemory(db, original.id);
    expect(getCommitment(db, commitment.id)?.source_message_id).toBe(later.id);
    expect(listFollowThroughEvents(db)).toEqual([]);
  });
});

describe("priority history and response context", () => {
  it("backfills priority inside pre-existing immutable goal snapshots", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration.sql);
    const timestamp = "2029-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO conversation (id, title, source, started_at, updated_at)
       VALUES (1, 'Before priorities', 'web', ?, ?)`,
    ).run(timestamp, timestamp);
    db.prepare(
      `INSERT INTO message (id, conversation_id, role, content, created_at)
       VALUES (1, 1, 'user', 'I want to launch.', ?),
              (2, 1, 'assistant', 'Let us plan it.', ?)`,
    ).run(timestamp, timestamp);
    db.prepare(
      `INSERT INTO goal
         (id, title, status, target_at, confidence, source_message_id,
          created_at, updated_at, closed_at)
       VALUES (1, 'Launch', 'active', NULL, 0.95, 1, ?, ?, NULL)`,
    ).run(timestamp, timestamp);
    db.prepare(
      `INSERT INTO response_context
         (assistant_message_id, item_kind, item_id, rank, created_at, snapshot_json)
       VALUES (2, 'goal', 1, 0, ?, ?)`,
    ).run(
      timestamp,
      JSON.stringify({
        kind: "goal",
        goal: {
          id: 1,
          title: "Launch",
          status: "active",
          target_at: null,
          confidence: 0.95,
          source_message_id: 1,
          created_at: timestamp,
          updated_at: timestamp,
          closed_at: null,
        },
      }),
    );

    db.exec(MIGRATIONS[4]!.sql);
    const recalled = recalledForResponse(db, 2);
    expect(recalled[0]?.kind).toBe("goal");
    expect(recalled[0]?.kind === "goal" ? recalled[0].goal.priority : null).toBe("normal");
    db.close();
  });

  it("keeps priority changes in the goal event history", () => {
    const db = openTestDb();
    const message = source(db);
    const goal = createGoal(db, {
      title: "Launch the portfolio",
      priority: "high",
      sourceMessageId: message.id,
    });
    updateGoal(db, goal.id, { status: "paused", sourceKind: "user_action" });

    expect(goalEvents(db, goal.id).map((event) => JSON.parse(event.detail_json ?? "{}"))).toEqual([
      expect.objectContaining({ priority: "high" }),
      expect.objectContaining({
        before: expect.objectContaining({ priority: "high" }),
        after: expect.objectContaining({ priority: "high" }),
      }),
    ]);
  });

  it("does not reset an explicit priority when a later extraction omits it", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const first = appendMessage(db, conversation.id, "user", "This launch is high priority.");
    const created = applyExtraction(
      db,
      {
        entities: [],
        facts: [],
        goals: [
          {
            existing_id: null,
            title: "Launch the product",
            status: "active",
            priority: "high",
            target_at: null,
            confidence: 0.98,
          },
        ],
      },
      first.id,
    ).goals[0]!;
    const second = appendMessage(db, conversation.id, "user", "Pause the launch for now.");
    const updated = applyExtraction(
      db,
      {
        entities: [],
        facts: [],
        goals: [
          {
            existing_id: created.id,
            title: created.title,
            status: "paused",
            target_at: null,
            confidence: 0.98,
          },
        ],
      },
      second.id,
    ).goals[0]!;

    expect(updated.priority).toBe("high");
    expect(updated.status).toBe("paused");
  });

  it("labels the recommendation as a proposal and traces its accepted sources", async () => {
    vi.stubEnv("ZEUS_EMBEDDINGS", "off");
    const db = openTestDb();
    const message = source(db, "Staying healthy matters; I need to book the dentist.");
    const goal = createGoal(db, {
      title: "Stay healthy",
      priority: "high",
      sourceMessageId: message.id,
    });
    const commitment = createCommitment(db, {
      title: "Book the dentist",
      linkedGoalId: goal.id,
      sourceMessageId: message.id,
    });

    const context = await buildContext(db, "dentist appointment", { queryVector: null });
    expect(context.recommendation?.commitment_id).toBe(commitment.id);
    expect(context.text).toContain("a system proposal, not a fact about the user");
    expect(context.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "goal" }),
        expect.objectContaining({ kind: "commitment" }),
      ]),
    );
  });

  it("retrieves relationship context for follow-through even when the question is unrelated", async () => {
    vi.stubEnv("ZEUS_EMBEDDINGS", "off");
    const db = openTestDb();
    const conversation = createConversation(db);
    const memory = appendMessage(
      db,
      conversation.id,
      "user",
      "Maya started a pottery class, and I want to stay closer after missing her graduation.",
    );
    applyExtraction(
      db,
      {
        entities: [{ name: "Maya", kind: "person", aliases: [] }],
        facts: [
          {
            subject: "Maya",
            predicate: "likes",
            object: "pottery classes",
            object_entity: null,
            confidence: 0.82,
            supersedes_previous: false,
          },
        ],
      },
      memory.id,
    );
    createCommitment(db, {
      title: "Send Maya a birthday message",
      dueAt: "2020-01-01",
      sourceMessageId: memory.id,
    });

    const context = await buildContext(db, "What is on my reading list?", { queryVector: null });
    expect(context.recommendation?.commitment_title).toContain("Maya");
    expect(context.text).toContain("pottery classes");
    expect(context.text).toContain("DATED EPISODES");
  });
});

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildContext } from "./context";
import { appendMessage, createConversation } from "./conversations";
import { openTestDb } from "./db";
import { applyExtraction } from "./extract";
import { recordFacet } from "./facets";
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
import { allowWholeMessagePassage } from "./passages";
import { listBehavioralPolicySuggestions } from "./personalization";
import {
  createEvaluationContext,
  evaluateOpportunity,
  followThroughMetrics,
  getRecommendationCycle,
  listFollowThroughEvents,
  listOpportunityDeliveries,
  markOpportunityDelivered,
  recommendationForOpportunity,
  recommendationsForResponse,
  recommendNextAction,
  recordFollowThroughDecision,
  recordFollowThroughFeedback,
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

function explicitContext(referenceTime: Date = new Date()) {
  return createEvaluationContext({ trigger: "today", timezone: "UTC", referenceTime });
}

function surfaceNext(
  db: ReturnType<typeof openTestDb>,
  responseMessageId: number | null = null,
) {
  const cycle = evaluateOpportunity(db, explicitContext());
  const recommendation = recommendationForOpportunity(db, cycle.id);
  if (!recommendation) throw new Error("Expected a recommendation to surface");
  markOpportunityDelivered(
    db,
    cycle.id,
    responseMessageId === null ? "today" : "chat",
    responseMessageId,
  );
  return recommendation;
}

describe("follow-through selection", () => {
  it("uses only accepted structured machine effects to alter deterministic ranking", () => {
    const db = openTestDb();
    const message = source(db, "I need to write the brief and prepare the demo.");
    const first = createCommitment(db, {
      title: "Write the brief",
      sourceMessageId: message.id,
    });
    const second = createCommitment(db, {
      title: "Prepare the demo",
      sourceMessageId: message.id,
    });
    const evidence = allowWholeMessagePassage(db, message.id);

    recordFacet(db, {
      kind: "preference",
      statement: "The demo sounds more exciting",
      scope: { kind: "commitment", commitmentId: second.id },
      sourceMessageId: message.id,
      passageIds: [evidence.id],
    });
    expect(recommendNextAction(db, "", { context: explicitContext() })?.commitment_id).toBe(first.id);

    recordFacet(db, {
      kind: "decision_criterion",
      statement: "Prioritize this commitment",
      scope: { kind: "commitment", commitmentId: second.id },
      machineEffect: "boost",
      sourceMessageId: message.id,
      passageIds: [evidence.id],
    });
    expect(recommendNextAction(db, "", { context: explicitContext() })?.commitment_id).toBe(second.id);

    recordFacet(db, {
      kind: "boundary",
      statement: "Do not surface this commitment",
      scope: { kind: "commitment", commitmentId: second.id },
      machineEffect: "block",
      sourceMessageId: message.id,
      passageIds: [evidence.id],
    });
    expect(recommendNextAction(db, "", { context: explicitContext() })?.commitment_id).toBe(first.id);
  });

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

    expect(recommendNextAction(db, "", { context: explicitContext() })?.commitment_id).toBe(call.id);
    updateGoal(db, high.id, { status: "paused", sourceKind: "user_action" });
    expect(recommendNextAction(db, "", { context: explicitContext() })?.commitment_title).toBe(
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
    const schedule = recommendNextAction(db, "", { context: explicitContext() });
    expect(schedule?.action_kind).toBe("schedule");
    expect(schedule?.effect_kind).toBe("schedule");
    expect(schedule?.requires_confirmation).toBe(true);
    expect(schedule?.suggested_action).toMatch(/confirm before changing any calendar/u);

    updateCommitment(db, schedule!.commitment_id, {
      title: "Research pottery gifts",
      sourceKind: "user_action",
    });
    const research = recommendNextAction(db, "", { context: explicitContext() });
    expect(research?.action_kind).toBe("research");
    expect(research?.effect_kind).toBe("web_read");
    expect(research?.requires_confirmation).toBe(false);
    expect(research?.chat_prompt).toMatch(/do not send, schedule, purchase/u);

    updateCommitment(db, research!.commitment_id, {
      title: "Buy pottery gifts",
      sourceKind: "user_action",
    });
    const purchase = recommendNextAction(db, "", { context: explicitContext() });
    expect(purchase?.effect_kind).toBe("purchase");
    expect(purchase?.requires_confirmation).toBe(true);
    expect(purchase?.suggested_action).toMatch(/stop before any booking, order, or payment/u);

    updateCommitment(db, purchase!.commitment_id, {
      title: "Delete the event listing",
      sourceKind: "user_action",
    });
    const externalChange = recommendNextAction(db, "", { context: explicitContext() });
    expect(externalChange?.effect_kind).toBe("modify_external");
    expect(externalChange?.requires_confirmation).toBe(true);

    updateCommitment(db, externalChange!.commitment_id, {
      title: "Register for the conference",
      sourceKind: "user_action",
    });
    const registration = recommendNextAction(db, "", { context: explicitContext() });
    expect(registration?.effect_kind).toBe("modify_external");
    expect(registration?.requires_confirmation).toBe(true);
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

  it("keeps off mode silent except for explicit user-invoked triggers", () => {
    const db = openTestDb();
    const message = source(db, "I need to write a launch brief.");
    const commitment = createCommitment(db, {
      title: "Write the launch brief",
      sourceMessageId: message.id,
    });
    setStewardshipMode(db, "off");

    expect(recommendNextAction(db, "launch brief")).toBeNull();
    expect(recommendNextAction(db, "What should I focus on?")?.commitment_id).toBe(
      commitment.id,
    );
    expect(
      recommendNextAction(db, "", {
        context: createEvaluationContext({ trigger: "today", timezone: "UTC" }),
      })?.commitment_id,
    ).toBe(commitment.id);
    expect(
      recommendNextAction(db, "", {
        context: createEvaluationContext({ trigger: "mcp", timezone: "UTC" }),
      })?.commitment_id,
    ).toBe(commitment.id);
    expect(
      recommendNextAction(db, "What should I focus on?", {
        context: createEvaluationContext({ trigger: "worker", timezone: "UTC" }),
      }),
    ).toBeNull();
  });

  it("applies structured conditions with overnight weekdays and fresh coarse zones", () => {
    const db = openTestDb();
    const message = source(db, "I need to write the brief and prepare the demo.");
    const first = createCommitment(db, {
      title: "Write the brief",
      sourceMessageId: message.id,
    });
    const second = createCommitment(db, {
      title: "Prepare the demo",
      sourceMessageId: message.id,
    });
    const evidence = allowWholeMessagePassage(db, message.id);
    const facet = recordFacet(db, {
      kind: "decision_criterion",
      statement: "Prioritize the demo late on Monday when I am at home",
      scope: { kind: "commitment", commitmentId: second.id },
      condition: "late on Monday at home",
      machineEffect: "boost",
      sourceMessageId: message.id,
      passageIds: [evidence.id],
    });
    db.prepare<[string, number]>(
      "UPDATE understanding_facet SET condition_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({
        weekdays: ["mon"],
        local_time: { start: "22:00", end: "02:00" },
        zones: ["Home"],
        expires_at: "2030-01-01T00:00:00.000Z",
      }),
      facet.id,
    );

    const mondayNight = createEvaluationContext({
      trigger: "today",
      referenceTime: new Date("2024-01-01T17:00:00.000Z"),
      timezone: "Asia/Singapore",
      locationZone: " home ",
      locationObservedAt: "2024-01-01T16:50:00.000Z",
    });
    expect(mondayNight.local_weekday).toBe("tue");
    expect(mondayNight.local_time).toBe("01:00");
    expect(recommendNextAction(db, "", { context: mondayNight })?.commitment_id).toBe(
      second.id,
    );

    const afterWindow = createEvaluationContext({
      trigger: "today",
      referenceTime: new Date("2024-01-01T19:00:00.000Z"),
      timezone: "Asia/Singapore",
      locationZone: "home",
      locationObservedAt: "2024-01-01T18:55:00.000Z",
    });
    expect(recommendNextAction(db, "", { context: afterWindow })?.commitment_id).toBe(
      first.id,
    );

    const staleLocation = createEvaluationContext({
      trigger: "today",
      referenceTime: new Date("2024-01-01T17:00:00.000Z"),
      timezone: "Asia/Singapore",
      locationZone: "home",
      locationObservedAt: "2024-01-01T16:29:59.000Z",
    });
    expect(recommendNextAction(db, "", { context: staleLocation })?.commitment_id).toBe(
      first.id,
    );

    db.prepare<[string, number]>(
      "UPDATE understanding_facet SET condition_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({ expires_at: mondayNight.evaluated_at }),
      facet.id,
    );
    expect(recommendNextAction(db, "", { context: mondayNight })?.commitment_id).toBe(
      first.id,
    );
  });

  it("derives local policy time across a daylight-saving transition", () => {
    const before = createEvaluationContext({
      trigger: "worker",
      referenceTime: new Date("2024-03-10T06:30:00.000Z"),
      timezone: "America/New_York",
    });
    const after = createEvaluationContext({
      trigger: "worker",
      referenceTime: new Date("2024-03-10T07:30:00.000Z"),
      timezone: "America/New_York",
    });

    expect(before).toMatchObject({ local_weekday: "sun", local_time: "01:30" });
    expect(after).toMatchObject({ local_weekday: "sun", local_time: "03:30" });
  });

  it("keeps legacy and invalid conditional machine effects inactive", () => {
    const db = openTestDb();
    const message = source(db, "I need to write the brief and prepare the demo.");
    const first = createCommitment(db, {
      title: "Write the brief",
      sourceMessageId: message.id,
    });
    const second = createCommitment(db, {
      title: "Prepare the demo",
      sourceMessageId: message.id,
    });
    const evidence = allowWholeMessagePassage(db, message.id);
    const facet = recordFacet(db, {
      kind: "decision_criterion",
      statement: "Prioritize the demo in the evening",
      scope: { kind: "commitment", commitmentId: second.id },
      condition: "in the evening",
      machineEffect: "boost",
      sourceMessageId: message.id,
      passageIds: [evidence.id],
    });
    const context = createEvaluationContext({
      trigger: "today",
      referenceTime: new Date("2024-01-01T18:00:00.000Z"),
      timezone: "UTC",
    });

    expect(recommendNextAction(db, "", { context })?.commitment_id).toBe(first.id);
    db.prepare<[string, number]>(
      "UPDATE understanding_facet SET condition_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({ local_time: { start: "18:00", end: "18:00" } }),
      facet.id,
    );
    expect(recommendNextAction(db, "", { context })?.commitment_id).toBe(first.id);

    const cycle = evaluateOpportunity(db, context);
    expect(JSON.parse(cycle.exclusions_json)).toContainEqual({
      facet_id: facet.id,
      reason: "invalid_condition",
    });
  });
});

describe("user control and outcomes", () => {
  it("materializes a pending review suggestion after three explicit feedback events", () => {
    const db = openTestDb();
    const message = source(db);
    const commitment = createCommitment(db, {
      title: "Research archive providers",
      sourceMessageId: message.id,
    });
    surfaceNext(db);

    for (let index = 0; index < 3; index += 1) {
      recordFollowThroughDecision(db, {
        commitmentId: commitment.id,
        decision: "dismissed",
      });
      expect(listBehavioralPolicySuggestions(db)).toHaveLength(index === 2 ? 1 : 0);
    }

    expect(listBehavioralPolicySuggestions(db)[0]).toMatchObject({
      status: "pending",
      event_type: "dismissed",
      allowed_interruption_change: "suppress_only",
      evidence_event_ids: expect.arrayContaining(
        listFollowThroughEvents(db)
          .filter((event) => event.event_type === "dismissed")
          .map((event) => event.id),
      ),
    });
  });

  it("stores only reasons the user actually authors", () => {
    const db = openTestDb();
    const message = source(db);
    const commitment = createCommitment(db, {
      title: "Send the note",
      sourceMessageId: message.id,
    });
    surfaceNext(db);
    const dismissed = recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "dismissed",
      userReason: "  The timing is wrong   this week. ",
    });
    expect(JSON.parse(dismissed?.detail_json ?? "{}")).toMatchObject({
      decision: { user_reason: "The timing is wrong this week." },
    });

    const blank = recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "accepted",
      userReason: "   ",
    });
    expect(JSON.parse(blank?.detail_json ?? "{}").decision).toBeUndefined();
  });

  it("appends optional feedback without recording a second control decision", () => {
    const db = openTestDb();
    const message = source(db);
    const commitment = createCommitment(db, {
      title: "Send the note",
      sourceMessageId: message.id,
    });
    surfaceNext(db);
    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "dismissed",
    });

    const feedback = recordFollowThroughFeedback(db, {
      commitmentId: commitment.id,
      decision: "dismissed",
      userReason: "The timing is wrong this week.",
    });

    expect(feedback).not.toBeNull();
    expect(JSON.parse(feedback?.detail_json ?? "{}")).toMatchObject({
      decision: {
        feedback_only: true,
        user_reason: "The timing is wrong this week.",
      },
    });
    expect(followThroughMetrics(db).controlsExercised).toBe(1);
  });

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
    surfaceNext(db);
    expect(recommendNextAction(db, "send note")).toBeNull();

    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "snoozed",
      snoozedUntil: "2030-01-10",
    });
    expect(
      recommendNextAction(db, "", {
        context: explicitContext(new Date("2030-01-09")),
      }),
    ).toBeNull();

    vi.setSystemTime(new Date("2030-01-11T09:00:00.000Z"));
    recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "dismissed",
    });
    expect(recommendNextAction(db, "", { context: explicitContext() })).toBeNull();

    vi.setSystemTime(new Date("2030-01-12T09:00:00.000Z"));
    updateCommitment(db, commitment.id, {
      title: "Send the revised overdue note",
      sourceKind: "user_action",
    });
    expect(recommendNextAction(db, "", { context: explicitContext() })?.commitment_id).toBe(commitment.id);
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
    surfaceNext(db, assistant.id);
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
    surfaceNext(db, assistant.id);
    expect(listFollowThroughEvents(db)).toHaveLength(1);

    deleteConversationWithMemory(db, original.id);
    expect(getCommitment(db, commitment.id)).toBeNull();
    expect(listFollowThroughEvents(db)).toEqual([]);
  });
});

describe("opportunity audit and delivery", () => {
  it("persists a reproducible cycle before delivery and surfaces it exactly once", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const user = appendMessage(
      db,
      conversation.id,
      "user",
      "I need to research workspace options.",
    );
    const assistant = appendMessage(db, conversation.id, "assistant", "Here is the result.");
    const commitment = createCommitment(db, {
      title: "Research workspace options",
      sourceMessageId: user.id,
    });
    const context = createEvaluationContext({
      trigger: "today",
      referenceTime: new Date("2030-01-07T09:00:00.000Z"),
      timezone: "UTC",
    });

    const cycle = evaluateOpportunity(db, context, "workspace");
    expect(cycle.policy_version).toBe("2");
    expect(cycle.selected_commitment_id).toBe(commitment.id);
    expect(getRecommendationCycle(db, cycle.id)).toEqual(cycle);
    expect(recommendationForOpportunity(db, cycle.id)).toMatchObject({
      commitment_id: commitment.id,
      effect_kind: "web_read",
      requires_confirmation: false,
    });
    expect(JSON.parse(cycle.context_json)).toMatchObject({
      trigger: "today",
      timezone: "UTC",
      stewardship_mode: "balanced",
      explicitly_requested: true,
    });
    expect(JSON.parse(cycle.candidate_scores_json)).toEqual([
      expect.objectContaining({ commitment_id: commitment.id }),
    ]);
    expect(JSON.parse(cycle.applied_facet_ids_json)).toEqual([]);
    expect(listOpportunityDeliveries(db, cycle.id)).toEqual([]);
    expect(followThroughMetrics(db).surfaced).toBe(0);
    expect(getCommitment(db, commitment.id)?.last_surfaced_at).toBeNull();

    const firstDelivery = markOpportunityDelivered(db, cycle.id, "chat", assistant.id);
    expect(firstDelivery).toMatchObject({
      opportunity_id: cycle.id,
      channel: "chat",
      response_message_id: assistant.id,
    });
    expect(followThroughMetrics(db).surfaced).toBe(1);
    expect(getCommitment(db, commitment.id)?.last_surfaced_at).not.toBeNull();

    const duplicate = markOpportunityDelivered(db, cycle.id, "chat", assistant.id);
    expect(duplicate?.id).toBe(firstDelivery?.id);
    markOpportunityDelivered(db, cycle.id, "macos");
    expect(listOpportunityDeliveries(db, cycle.id).map((delivery) => delivery.channel)).toEqual([
      "chat",
      "macos",
    ]);
    expect(followThroughMetrics(db).surfaced).toBe(1);
    expect(listFollowThroughEvents(db)).toEqual([
      expect.objectContaining({
        event_type: "surfaced",
        effect_kind: "web_read",
        opportunity_id: cycle.id,
      }),
    ]);
  });

  it("does not deliver an empty cycle or accept a user message as a chat receipt", () => {
    const db = openTestDb();
    const context = createEvaluationContext({
      trigger: "today",
      referenceTime: new Date("2030-01-07T09:00:00.000Z"),
      timezone: "UTC",
    });
    const empty = evaluateOpportunity(db, context);
    expect(empty.selected_commitment_id).toBeNull();
    expect(markOpportunityDelivered(db, empty.id, "today")).toBeNull();
    expect(listOpportunityDeliveries(db, empty.id)).toEqual([]);

    const user = source(db, "I need to prepare a brief.");
    createCommitment(db, { title: "Prepare a brief", sourceMessageId: user.id });
    const cycle = evaluateOpportunity(db, context);
    expect(() => markOpportunityDelivered(db, cycle.id, "chat", user.id)).toThrow(
      /stored assistant message/u,
    );
    expect(listOpportunityDeliveries(db, cycle.id)).toEqual([]);
  });

  it("links later response delivery to the same surfaced opportunity", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const user = appendMessage(db, conversation.id, "user", "I need to prepare a brief.");
    const assistant = appendMessage(db, conversation.id, "assistant", "Let us prepare it.");
    const commitment = createCommitment(db, {
      title: "Prepare a brief",
      sourceMessageId: user.id,
    });
    const cycle = evaluateOpportunity(
      db,
      createEvaluationContext({ trigger: "today", timezone: "UTC" }),
    );

    markOpportunityDelivered(db, cycle.id, "today");
    markOpportunityDelivered(db, cycle.id, "chat", assistant.id);
    expect(recommendationsForResponse(db, assistant.id)[0]?.commitment_id).toBe(
      commitment.id,
    );
    const accepted = recordFollowThroughDecision(db, {
      commitmentId: commitment.id,
      decision: "accepted",
      responseMessageId: assistant.id,
    });
    expect(accepted?.response_message_id).toBe(assistant.id);
    expect(followThroughMetrics(db).surfaced).toBe(1);
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
    const snapshot = db
      .prepare("SELECT snapshot_json FROM response_context WHERE assistant_message_id = 2")
      .get() as { snapshot_json: string };
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({
      kind: "goal",
      goal: { priority: "normal" },
    });
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

  it("retrieves canonical relationship context without recalling an unclassified source", async () => {
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
    expect(context.text).not.toContain("DATED EVIDENCE PASSAGES");
  });
});

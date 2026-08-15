import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTodayOpportunity } from "./ambient";
import { mayBeCalendarRequest } from "./calendar-intent";
import { cacheCalendarEvents } from "./calendar-sync";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import { listOpenSignals, runDetectors } from "./detectors";
import { createCommitment, createGoal, updateGoal } from "./intentions";
import { recordFacet } from "./facets";
import { ensureEvidencePassage } from "./passages";
import {
  createEvaluationContext,
  evaluateOpportunity,
  markOpportunityDelivered,
  recordSignalDecision,
  setStewardshipMode,
  signalAlertForOpportunity,
  signalChatPrompt,
} from "./stewardship";

/**
 * Detectors exist so Zeus can notice something the user never wrote down. That power is
 * only acceptable because it enters through the same gates as every other interruption,
 * so most of these tests are about what does *not* get raised.
 */

const NOW = new Date("2026-08-14T09:00:00.000Z");

let db: Db;
let userMessageId: number;
let conversationId: number;

beforeEach(() => {
  db = openTestDb();
  const conversation = createConversation(db, { title: "Chat", source: "web" });
  conversationId = conversation.id;
  userMessageId = appendMessage(db, conversationId, "user", "I fly in on the 20th", {
    origin: "user_action",
    recallState: "blocked",
  }).id;
  // A connector row is needed only as the owner of cached signals; no server is contacted.
  db.exec(`
    INSERT INTO connector (id, label, transport, command, source_message_id, status, enabled,
                           created_at, updated_at)
    VALUES (1, 'Calendar', 'stdio', 'node', ${userMessageId}, 'ready', 1,
            '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
  `);
});

function cache(events: Array<Record<string, unknown>>): void {
  cacheCalendarEvents(db, 1, { events }, NOW);
}

const FLIGHT = {
  id: "evt-flight",
  title: "Flight lands",
  starts_at: "2026-08-20T18:00:00Z",
  ends_at: "2026-08-20T18:40:00Z",
  location: "Airport",
};
const DINNER = {
  id: "evt-dinner",
  title: "Dinner with Sam",
  starts_at: "2026-08-20T18:30:00Z",
  ends_at: "2026-08-20T20:00:00Z",
  location: "Lisbon centre",
};

describe("what a detector notices", () => {
  it("finds two events claiming the same minutes", () => {
    cache([FLIGHT, DINNER]);

    const { created } = runDetectors(db, { at: NOW });

    const overlap = created.find((signal) => signal.detector === "calendar_overlap");
    expect(overlap).toBeDefined();
    expect(overlap?.why).toContain("“Flight lands” runs until 18:40");
    expect(overlap?.why).toContain("“Dinner with Sam” starts at 18:30");
    expect(overlap?.effect_kind).toBe("modify_external");
  });

  it("claims only what it can see about travel, not that the user will be late", () => {
    cache([
      { ...FLIGHT, ends_at: "2026-08-20T18:00:00Z", starts_at: "2026-08-20T17:00:00Z" },
      { ...DINNER, starts_at: "2026-08-20T18:15:00Z" },
    ]);

    const { created } = runDetectors(db, { at: NOW });

    const gap = created.find((signal) => signal.detector === "travel_gap");
    expect(gap?.why).toBe(
      "15 minutes separate “Flight lands” at Airport from “Dinner with Sam” at Lisbon centre.",
    );
    // It suggests checking, not a conclusion about being late.
    expect(gap?.suggested_action).toContain("Check whether");
  });

  it("notices a near deadline with no time set aside for it", () => {
    createCommitment(db, {
      title: "Finish the quarterly review",
      dueAt: "2026-08-17T17:00:00Z",
      sourceMessageId: userMessageId,
    });
    cache([FLIGHT]);

    const { created } = runDetectors(db, { at: NOW });

    const unscheduled = created.find(
      (signal) => signal.detector === "commitment_unscheduled",
    );
    expect(unscheduled?.why).toContain("“Finish the quarterly review” is due 2026-08-17");
    expect(unscheduled?.effect_kind).toBe("schedule");
  });

  it("stays quiet when the calendar already holds time for the commitment", () => {
    createCommitment(db, {
      title: "Finish the quarterly review",
      dueAt: "2026-08-17T17:00:00Z",
      sourceMessageId: userMessageId,
    });
    cache([
      {
        id: "evt-block",
        title: "Quarterly review writing",
        starts_at: "2026-08-16T09:00:00Z",
        ends_at: "2026-08-16T11:00:00Z",
      },
    ]);

    const { created } = runDetectors(db, { at: NOW });

    expect(created.filter((signal) => signal.detector === "commitment_unscheduled")).toEqual(
      [],
    );
  });

  it("says nothing about a commitment under a paused goal", () => {
    const goal = createGoal(db, { title: "Ship the review", sourceMessageId: userMessageId });
    createCommitment(db, {
      title: "Finish the quarterly review",
      dueAt: "2026-08-17T17:00:00Z",
      linkedGoalId: goal.id,
      sourceMessageId: userMessageId,
    });
    updateGoal(db, goal.id, { status: "paused", sourceMessageId: userMessageId });

    const { created } = runDetectors(db, { at: NOW });

    expect(created).toEqual([]);
  });
});

describe("running again is not a new interruption", () => {
  it("keeps one signal per conflict across repeated sweeps", () => {
    cache([FLIGHT, DINNER]);

    const first = runDetectors(db, { at: NOW });
    const second = runDetectors(db, { at: new Date(NOW.getTime() + 60_000) });

    expect(second.created.map((signal) => signal.id)).toEqual(
      first.created.map((signal) => signal.id),
    );
    expect(listOpenSignals(db, { at: NOW })).toHaveLength(first.created.length);
  });

  it("resolves a conflict the user fixed, without being told", () => {
    cache([FLIGHT, DINNER]);
    runDetectors(db, { at: NOW });
    expect(listOpenSignals(db, { at: NOW }).length).toBeGreaterThan(0);

    // The user moved dinner; the next read no longer shows a clash.
    cache([FLIGHT, { ...DINNER, starts_at: "2026-08-20T20:00:00Z", ends_at: "2026-08-20T21:30:00Z" }]);
    const { resolved } = runDetectors(db, { at: NOW });

    expect(resolved).toBeGreaterThan(0);
    expect(listOpenSignals(db, { at: NOW })).toEqual([]);
  });
});

describe("signals enter through the existing gates, or not at all", () => {
  function opportunity(at: Date = NOW) {
    vi.setSystemTime(at);
    return evaluateOpportunity(
      db,
      createEvaluationContext({ trigger: "worker", referenceTime: at }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("surfaces an imminent conflict through the ordinary opportunity pipeline", () => {
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T18:30:00Z", ends_at: "2026-08-14T20:00:00Z" },
    ]);
    runDetectors(db, { at: NOW });

    const cycle = opportunity();

    expect(cycle.selected_signal_id).not.toBeNull();
    expect(cycle.selected_commitment_id).toBeNull();
    expect(cycle.recommendation_json).toContain("calendar_overlap");
  });

  it("stays silent when the user turned stewardship off", () => {
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T18:30:00Z" },
    ]);
    runDetectors(db, { at: NOW });
    setStewardshipMode(db, "off", userMessageId);

    expect(opportunity().selected_signal_id).toBeNull();
  });

  it("respects an accepted facet that blocks", () => {
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T18:30:00Z" },
    ]);
    runDetectors(db, { at: NOW });
    const passage = ensureEvidencePassage(db, {
      messageId: userMessageId,
      quote: "I fly in on the 20th",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    recordFacet(db, {
      kind: "boundary",
      statement: "Never interrupt me about anything",
      machineEffect: "block",
      sourceMessageId: userMessageId,
      passageIds: [passage.id],
    });

    expect(opportunity().selected_signal_id).toBeNull();
  });

  it("does not raise the same signal twice inside its cooldown", () => {
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T18:30:00Z" },
    ]);
    runDetectors(db, { at: NOW });
    const first = opportunity();
    expect(first.selected_signal_id).not.toBeNull();
    markOpportunityDelivered(db, first.id, "macos");

    const second = opportunity(new Date(NOW.getTime() + 3_600_000));

    expect(second.selected_signal_id).toBeNull();
  });

  it("keeps a dismissed signal dismissed", () => {
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T18:30:00Z" },
    ]);
    runDetectors(db, { at: NOW });
    const cycle = opportunity();
    const signalId = cycle.selected_signal_id;
    if (signalId === null) throw new Error("expected a signal");
    markOpportunityDelivered(db, cycle.id, "macos");
    const decision = appendMessage(db, conversationId, "user", "not now", {
      origin: "user_action",
      recallState: "blocked",
    }).id;

    recordSignalDecision(db, {
      signalId,
      decision: "dismissed",
      sourceMessageId: decision,
    });

    // Far past any cooldown, and still not raised.
    expect(opportunity(new Date(NOW.getTime() + 40 * 86_400_000)).selected_signal_id)
      .toBeNull();
  });

  it("shows the notified signal on Today rather than an empty page", () => {
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T18:30:00Z" },
    ]);
    runDetectors(db, { at: NOW });
    const worker = evaluateOpportunity(
      db,
      createEvaluationContext({ trigger: "worker", referenceTime: NOW }),
    );
    expect(worker.selected_signal_id).not.toBeNull();
    markOpportunityDelivered(db, worker.id, "macos");

    // The notification started the cooldown, so a fresh evaluation would now pick nothing.
    // Someone tapping through must still see the thing they were told about.
    const todayContext = createEvaluationContext({
      trigger: "today",
      referenceTime: new Date(NOW.getTime() + 60_000),
    });
    const reused = resolveTodayOpportunity(db, todayContext);

    expect(reused?.id).toBe(worker.id);
    expect(signalAlertForOpportunity(db, worker.id)?.detector).toBe("calendar_overlap");
  });

  it("stops reusing a signal once it is resolved", () => {
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T18:30:00Z" },
    ]);
    runDetectors(db, { at: NOW });
    const worker = evaluateOpportunity(
      db,
      createEvaluationContext({ trigger: "worker", referenceTime: NOW }),
    );
    markOpportunityDelivered(db, worker.id, "macos");
    // The user moved dinner, so the next sweep resolves it.
    cache([
      { ...FLIGHT, starts_at: "2026-08-14T18:00:00Z", ends_at: "2026-08-14T18:40:00Z" },
      { ...DINNER, starts_at: "2026-08-14T21:00:00Z", ends_at: "2026-08-14T22:30:00Z" },
    ]);
    runDetectors(db, { at: NOW });

    const reused = resolveTodayOpportunity(
      db,
      createEvaluationContext({
        trigger: "today",
        referenceTime: new Date(NOW.getTime() + 60_000),
      }),
    );

    expect(reused).toBeNull();
  });

  it("never lets an assistant message record a decision", () => {
    cache([FLIGHT, DINNER]);
    const signal = runDetectors(db, { at: NOW }).created[0];
    if (!signal) throw new Error("expected a signal");
    const assistant = appendMessage(db, conversationId, "assistant", "I dismissed it").id;

    expect(() =>
      recordSignalDecision(db, {
        signalId: signal.id,
        decision: "dismissed",
        sourceMessageId: assistant,
      }),
    ).toThrow();
  });
});

describe("handing a detected signal to chat", () => {
  it("phrases a clash as a request the calendar router will act on", () => {
    cache([FLIGHT, DINNER]);
    const overlap = runDetectors(db, { at: NOW }).created.find(
      (signal) => signal.detector === "calendar_overlap",
    );
    expect(overlap).toBeDefined();

    const prompt = signalChatPrompt(overlap!);

    expect(mayBeCalendarRequest(prompt)).toBe(true);
    // The why rides along, because it names both events and their times — the context the
    // calendar path needs to resolve which event to move.
    expect(prompt).toContain("Flight lands");
    expect(prompt).toContain("Dinner with Sam");
    expect(prompt).toContain("without my explicit confirmation");
  });

  it("does not depend on the event titles happening to sound like a calendar", () => {
    // "Decide which of “Aurora” and “Borealis” to move." carries no calendar noun, so the
    // detector's own wording falls below the router's prefilter and the turn it opens is
    // ordinary conversation about the clash. The asked-for version never depends on what
    // the user happened to name their meetings.
    cache([
      { ...FLIGHT, title: "Aurora" },
      { ...DINNER, title: "Borealis" },
    ]);
    const overlap = runDetectors(db, { at: NOW }).created.find(
      (signal) => signal.detector === "calendar_overlap",
    );

    expect(mayBeCalendarRequest(overlap!.suggested_action)).toBe(false);
    expect(mayBeCalendarRequest(signalChatPrompt(overlap!))).toBe(true);
  });

  it("asks for time to be held when a commitment has none", () => {
    const source = appendMessage(db, conversationId, "user", "I owe Sam the deck by Monday", {
      origin: "user_action",
      recallState: "blocked",
    });
    createCommitment(db, {
      title: "Send Sam the deck",
      dueAt: "2026-08-17T09:00:00.000Z",
      sourceMessageId: source.id,
    });

    const unscheduled = runDetectors(db, { at: NOW }).created.find(
      (signal) => signal.detector === "commitment_unscheduled",
    );

    expect(mayBeCalendarRequest(signalChatPrompt(unscheduled!))).toBe(true);
  });

  it("leaves a full day in the detector's own words rather than inventing a target", () => {
    // Nothing here is one event to move, so there is nothing honest to ask the calendar
    // path for. The prompt stays descriptive instead of sending it hunting.
    expect(
      signalChatPrompt({
        detector: "deadline_collision",
        why: "“Ship the report” is due on 2026-08-20, which already has 420 booked minutes.",
        suggested_action: "Start “Ship the report” earlier, or move its deadline.",
      }),
    ).toBe(
      "Start “Ship the report” earlier, or move its deadline. " +
        "Nothing outside this conversation changes without my explicit confirmation.",
    );
  });
});

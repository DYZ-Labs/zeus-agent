import { beforeEach, describe, expect, it } from "vitest";

import {
  calendarHistoryFor,
  calendarOutcomesIn,
  recordCalendarOutcome,
} from "./calendar-outcome";
import { appendMessage, createConversation } from "./conversations";
import { type Db, now, openTestDb } from "./db";
import { deleteConversationWithMemory } from "./retention";
import { CalendarOutcome } from "./schema";

/**
 * The durable account of what a calendar request did.
 *
 * Live, the outcome rides the streaming frame. Reload, or take one more turn, and that frame
 * is gone — which left the assistant's prose as the only surviving account of whether
 * anything happened. That is the one thing this table exists so as not to depend on, for the
 * page and, through `calendarHistoryFor`, for the model.
 */

let db: Db;
let conversationId: number;

const OUTCOME: CalendarOutcome = {
  kind: "reschedule",
  status: "target_not_found",
  reason: null,
  note: "target_time_was_destination",
  conflicts: [],
  alternatives: [],
  candidates: [],
  nearMisses: [
    { externalId: "sushi", title: "Sushi with Mark", startsAt: "2026-08-20T18:00:00.000Z" },
  ],
  consideredEvents: 1,
  coverage: {
    from: "2026-08-15T09:00:00.000Z",
    to: "2026-09-14T09:00:00.000Z",
    fetchedAt: "2026-08-15T09:00:00.000Z",
    eventCount: 1,
  },
  preview: null,
  overlaps: [],
  confirmationHash: null,
};

beforeEach(() => {
  db = openTestDb();
  conversationId = createConversation(db, { title: "Calendar", source: "web" }).id;
});

function assistantTurn(): number {
  appendMessage(db, conversationId, "user", "move dinner to 7:30pm");
  return appendMessage(db, conversationId, "assistant", "I could not find a dinner.").id;
}

function turnWithOutcome(outcome: CalendarOutcome): number {
  const messageId = assistantTurn();
  recordCalendarOutcome(db, messageId, outcome);
  return messageId;
}

describe("what Zeus did survives the page that showed it", () => {
  it("stores and returns the outcome for its own turn", () => {
    const messageId = assistantTurn();
    recordCalendarOutcome(db, messageId, OUTCOME);
    expect(calendarOutcomesIn(db, conversationId).get(messageId)).toEqual(OUTCOME);
  });

  it("keeps one outcome per turn rather than accumulating them", () => {
    const messageId = assistantTurn();
    recordCalendarOutcome(db, messageId, OUTCOME);
    recordCalendarOutcome(db, messageId, { ...OUTCOME, status: "done" });
    const stored = calendarOutcomesIn(db, conversationId);
    expect(stored.size).toBe(1);
    expect(stored.get(messageId)?.status).toBe("done");
  });

  it("returns nothing for another conversation's turns", () => {
    const messageId = assistantTurn();
    recordCalendarOutcome(db, messageId, OUTCOME);
    const other = createConversation(db, { title: "Other", source: "web" }).id;
    expect(calendarOutcomesIn(db, other).size).toBe(0);
  });

  it("goes when the source conversation goes", () => {
    // Assistant-authored data about a deleted conversation is exactly what explicit deletion
    // is supposed to remove, and the cascade is what makes that true without a second list.
    const messageId = assistantTurn();
    recordCalendarOutcome(db, messageId, OUTCOME);
    deleteConversationWithMemory(db, conversationId);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM calendar_outcome").get(),
    ).toEqual({ count: 0 });
  });

  it("drops a row it cannot read rather than failing the page", () => {
    const messageId = assistantTurn();
    recordCalendarOutcome(db, messageId, OUTCOME);
    db.prepare<[string]>("UPDATE calendar_outcome SET outcome_json = ?").run("{ not json");
    expect(calendarOutcomesIn(db, conversationId).size).toBe(0);
  });
});

/**
 * The reported failure this reader exists to fix: a turn that acted, then a turn that did
 * not, and a model with no evidence the first turn ever happened.
 */
describe("what Zeus already did, for the model rather than the page", () => {
  it("reports a completed change so a later turn is not left denying it", () => {
    turnWithOutcome({ ...OUTCOME, kind: "create", status: "done", preview: "Create “Lunch”." });
    const history = calendarHistoryFor(db, conversationId);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("done");
    expect(history[0]?.preview).toBe("Create “Lunch”.");
    expect(history[0]?.confirmationHash).toBeNull();
  });

  it("reads oldest first, so the model sees the order things happened in", () => {
    turnWithOutcome({ ...OUTCOME, kind: "create", status: "done", preview: "first" });
    turnWithOutcome({ ...OUTCOME, kind: "cancel", status: "done", preview: "second" });
    expect(calendarHistoryFor(db, conversationId).map((entry) => entry.preview)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps the most recent when the cap bites, not the first it happened to read", () => {
    for (const preview of ["one", "two", "three"]) {
      turnWithOutcome({ ...OUTCOME, status: "done", preview });
    }
    expect(calendarHistoryFor(db, conversationId, 2).map((entry) => entry.preview)).toEqual([
      "two",
      "three",
    ]);
  });

  it("stays inside its own conversation", () => {
    turnWithOutcome({ ...OUTCOME, status: "done", preview: "mine" });
    const other = createConversation(db, { title: "Other", source: "web" }).id;
    expect(calendarHistoryFor(db, other)).toEqual([]);
  });

  /**
   * A required addition would have failed `safeParse` on every row written before it, and a
   * dropped row is a change Zeus made and can no longer say it made — the exact failure the
   * history exists to prevent, reintroduced by the fix for it.
   */
  it("still reads a row written before the newer fields existed", () => {
    const messageId = assistantTurn();
    const legacy = {
      kind: "create",
      status: "done",
      reason: null,
      note: null,
      conflicts: [],
      alternatives: [],
      candidates: [],
      nearMisses: [],
      consideredEvents: 2,
      coverage: null,
    };
    db.prepare<[number, string, string]>(
      `INSERT INTO calendar_outcome
         (assistant_message_id, kind, status, outcome_json, created_at)
       VALUES (?, 'create', 'done', ?, ?)`,
    ).run(messageId, JSON.stringify(legacy), now());

    expect(calendarHistoryFor(db, conversationId)).toHaveLength(1);
    const parsed = CalendarOutcome.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.preview).toBeNull();
    expect(parsed.success && parsed.data.overlaps).toEqual([]);
  });

  /** So a later "no" reaches the set the user was actually asked about, and nothing else. */
  it("carries the hash the turn asked the user to send", () => {
    turnWithOutcome({
      ...OUTCOME,
      kind: "clear",
      status: "awaiting_confirmation",
      confirmationHash: "a".repeat(64),
    });
    expect(calendarHistoryFor(db, conversationId)[0]?.confirmationHash).toBe("a".repeat(64));
  });
});

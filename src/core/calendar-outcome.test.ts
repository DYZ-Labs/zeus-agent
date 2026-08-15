import { beforeEach, describe, expect, it } from "vitest";

import { calendarOutcomesIn, recordCalendarOutcome } from "./calendar-outcome";
import { appendMessage, createConversation } from "./conversations";
import { type Db, openTestDb } from "./db";
import { deleteConversationWithMemory } from "./retention";
import type { CalendarOutcome } from "./schema";

/**
 * The durable half of the calendar card.
 *
 * Live, the outcome rides the streaming frame. Reload, and that frame is gone — which left
 * the assistant's prose as the only surviving account of whether anything happened. That is
 * the one thing the deterministic card exists so as not to depend on.
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
};

beforeEach(() => {
  db = openTestDb();
  conversationId = createConversation(db, { title: "Calendar", source: "web" }).id;
});

function assistantTurn(): number {
  appendMessage(db, conversationId, "user", "move dinner to 7:30pm");
  return appendMessage(db, conversationId, "assistant", "I could not find a dinner.").id;
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

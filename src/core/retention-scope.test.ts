import { beforeEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { listFacets, recordFacet } from "./facets";
import { createGoal, getGoal } from "./intentions";
import { allowWholeMessagePassage } from "./passages";
import { deleteConversationWithMemory } from "./retention";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

describe("scoped understanding retention", () => {
  it("removes a goal-scoped facet before deleting its sole scope target", () => {
    const goalConversation = createConversation(db);
    const goalSource = appendMessage(
      db,
      goalConversation.id,
      "user",
      "I want to launch the studio.",
    );
    const goal = createGoal(db, {
      title: "Launch the studio",
      sourceMessageId: goalSource.id,
    });

    const facetConversation = createConversation(db);
    const facetSource = appendMessage(
      db,
      facetConversation.id,
      "user",
      "For the studio launch, protect creative control.",
    );
    const passage = allowWholeMessagePassage(db, facetSource.id);
    recordFacet(db, {
      kind: "decision_criterion",
      statement: "Protect creative control for the studio launch",
      scope: { kind: "goal", goalId: goal.id },
      confidence: 0.98,
      sourceMessageId: facetSource.id,
      passageIds: [passage.id],
    });

    expect(() => deleteConversationWithMemory(db, goalConversation.id)).not.toThrow();
    expect(getGoal(db, goal.id)).toBeNull();
    expect(listFacets(db, { includeClosed: true })).toHaveLength(0);
  });
});

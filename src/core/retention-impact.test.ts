import { describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import { recordResponseContext } from "./context";
import { openTestDb } from "./db";
import { selfEntity } from "./entities";
import { recordFact } from "./facts";
import { createGoal } from "./intentions";
import { allowWholeMessagePassage } from "./passages";
import { conversationDeletionImpact } from "./retention";

describe("conversation deletion impact", () => {
  it("separates memories removed with a source from shared memories that survive", () => {
    const db = openTestDb();
    const deletingConversation = createConversation(db, { title: "Delete this source" });
    const survivingConversation = createConversation(db, { title: "Independent source" });
    const deletingSource = appendMessage(
      db,
      deletingConversation.id,
      "user",
      "I like espresso and keep a private launch note.",
    );
    const survivingSource = appendMessage(
      db,
      survivingConversation.id,
      "user",
      "I still like espresso.",
    );
    const passage = allowWholeMessagePassage(db, deletingSource.id);
    const self = selfEntity(db);

    recordFact(db, {
      subjectId: self.id,
      predicate: "likes",
      object: "espresso",
      sourceMessageId: deletingSource.id,
      passageId: passage.id,
    });
    recordFact(db, {
      subjectId: self.id,
      predicate: "likes",
      object: "espresso",
      sourceMessageId: survivingSource.id,
    });
    recordFact(db, {
      subjectId: self.id,
      predicate: "note",
      object: "private launch note",
      sourceMessageId: deletingSource.id,
      passageId: passage.id,
    });
    createGoal(db, {
      title: "Ship the launch",
      sourceMessageId: deletingSource.id,
      passageId: passage.id,
    });

    const impact = conversationDeletionImpact(db, deletingConversation.id);

    expect(impact).toMatchObject({
      messages: 1,
      removedMemories: 1,
      retainedSharedMemories: 1,
      affectedPlans: 1,
    });
    expect(impact.affectedAuditRecords).toBeGreaterThan(0);
  });

  it("returns a stable empty impact for an unknown conversation", () => {
    const impact = conversationDeletionImpact(openTestDb(), 99_999);
    expect(impact).toEqual({
      messages: 0,
      removedMemories: 0,
      retainedSharedMemories: 0,
      affectedPlans: 0,
      affectedAuditRecords: 0,
    });
  });

  it("counts a response trace outside the source conversation that deletion invalidates", () => {
    const db = openTestDb();
    const sourceConversation = createConversation(db, { title: "Source" });
    const responseConversation = createConversation(db, { title: "Other response" });
    const source = appendMessage(db, sourceConversation.id, "user", "I like espresso.");
    const response = appendMessage(db, responseConversation.id, "assistant", "Espresso suits you.");
    const fact = recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "likes",
      object: "espresso",
      sourceMessageId: source.id,
    }).fact;
    const before = conversationDeletionImpact(db, sourceConversation.id);

    recordResponseContext(db, response.id, [{ kind: "fact", fact, evidence: [] }]);

    const after = conversationDeletionImpact(db, sourceConversation.id);
    expect(after.affectedAuditRecords).toBe(before.affectedAuditRecords + 1);
  });
});

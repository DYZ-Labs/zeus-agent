import { describe, expect, it, vi } from "vitest";

import { hydrateConversationTurns } from "./chat-hydration";
import { appendMessage, createConversation } from "./conversations";
import { recordResponseContext } from "./context";
import { openTestDb } from "./db";
import { selfEntity } from "./entities";
import { evidenceForFact, getFact, recordFact } from "./facts";
import { createMemoryJob, processMemoryJob } from "./memory-jobs";
import type { ParsedExtraction } from "./schema";

describe("chat hydration", () => {
  it("restores opaque response ids, provenance counts, and exact memory job state", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const earlier = appendMessage(db, conversation.id, "user", "I work at Acme");
    appendMessage(db, conversation.id, "assistant", "Understood");
    const fact = recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "works_at",
      object: "Acme",
      sourceMessageId: earlier.id,
    });
    const source = appendMessage(db, conversation.id, "user", "I like espresso");
    const response = appendMessage(db, conversation.id, "assistant", "That suits you");
    const recalledFact = getFact(db, fact.fact.id)!;
    recordResponseContext(db, response.id, [
      {
        kind: "fact",
        fact: recalledFact,
        evidence: evidenceForFact(db, recalledFact.id),
      },
    ]);
    const job = createMemoryJob(db, {
      conversationId: conversation.id,
      sourceMessageId: source.id,
      assistantMessageId: response.id,
      promptVersion: "hydrate-v1",
      rememberingMode: "automatic",
      id: "opaque-memory-job",
    });
    const extraction: ParsedExtraction = {
      entities: [],
      facts: [
        {
          subject: "self",
          predicate: "prefers",
          object: "espresso",
          object_entity: null,
          operation: "assert",
          grounding: "user_statement",
          explicitness: "explicit",
          sensitivity: "normal",
          ambiguity: "clear",
          confidence: 0.95,
          supersedes_previous: false,
          effective_from: null,
          evidence: [{ source_message_id: source.id, quote: "I like espresso" }],
        },
      ],
      goals: [],
      commitments: [],
      facets: [],
      source_assessments: [
        {
          source_message_id: source.id,
          sensitivity: "normal",
          sensitive_quotes: [],
        },
      ],
    };
    await processMemoryJob(db, job.id, {
      extractMessages: vi.fn().mockResolvedValue(extraction),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    const turns = hydrateConversationTurns(db, conversation.id);
    expect(turns.every((turn) => /^message_[1-9a-z][0-9a-z]*$/u.test(turn.id))).toBe(true);
    expect(turns.at(-1)).toMatchObject({
      id: `message_${response.id.toString(36)}`,
      responseId: `message_${response.id.toString(36)}`,
      recalled: 1,
      memoryJobId: "opaque-memory-job",
      memory: {
        id: "opaque-memory-job",
        status: "completed",
        items: [
          expect.objectContaining({
            change: "saved",
            label: "You prefer espresso",
          }),
        ],
      },
    });
  });
});

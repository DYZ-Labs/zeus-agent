import { describe, expect, it, vi } from "vitest";

import { createConversation, appendMessage, getMessage } from "./conversations";
import { openTestDb } from "./db";
import { fromBlob, putEmbedding } from "./embed";
import { getFact, recordFact } from "./facts";
import {
  createMemoryJob,
  getMemoryJob,
  processPendingMemoryJobs,
  processMemoryJob,
  recoverInterruptedMemoryJobs,
  undoMemoryJob,
} from "./memory-jobs";
import { selfEntity } from "./entities";
import { clearZeusData, deleteConversationWithMemory } from "./retention";
import type { ParsedExtraction } from "./schema";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function extractionFor(messageId: number, input: {
  predicate?: string;
  object?: string;
  quote?: string;
} = {}): ParsedExtraction {
  const quote = input.quote ?? "I like espresso";
  return {
    entities: [],
    facts: [
      {
        subject: "self",
        predicate: input.predicate ?? "prefers",
        object: input.object ?? "espresso",
        object_entity: null,
        operation: "assert",
        grounding: "user_statement",
        explicitness: "explicit",
        sensitivity: "normal",
        ambiguity: "clear",
        confidence: 0.95,
        supersedes_previous: false,
        effective_from: null,
        evidence: [{ source_message_id: messageId, quote }],
      },
    ],
    goals: [],
    commitments: [],
    facets: [],
    source_assessments: [
      {
        source_message_id: messageId,
        sensitivity: "normal",
        sensitive_quotes: [],
      },
    ],
  };
}

function jobFixture(mode: "automatic" | "confirm" = "automatic") {
  const db = openTestDb();
  const conversation = createConversation(db);
  const source = appendMessage(db, conversation.id, "user", "I like espresso");
  const assistant = appendMessage(db, conversation.id, "assistant", "Got it");
  const job = createMemoryJob(db, {
    conversationId: conversation.id,
    sourceMessageId: source.id,
    assistantMessageId: assistant.id,
    promptVersion: "test-v1",
    rememberingMode: mode,
    id: "job_test_id",
  });
  return { db, conversation, source, assistant, job };
}

describe("memory jobs", () => {
  it("is idempotent by source message and prompt version", () => {
    const fixture = jobFixture();
    const second = createMemoryJob(fixture.db, {
      conversationId: fixture.conversation.id,
      sourceMessageId: fixture.source.id,
      assistantMessageId: fixture.assistant.id,
      promptVersion: "test-v1",
      rememberingMode: "automatic",
      id: "a_different_id",
    });
    expect(second.id).toBe(fixture.job.id);
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_job").get(),
    ).toEqual({ count: 1 });
  });

  it("applies an automatic extraction and reports exact activity", async () => {
    const fixture = jobFixture();
    const extractMessages = vi.fn().mockResolvedValue(extractionFor(fixture.source.id));
    const result = await processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages,
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toMatchObject({
      status: "completed",
      items: [
        {
          kind: "preference",
          change: "saved",
          label: "You prefer espresso",
          sourceId: `message_${fixture.source.id.toString(36)}`,
        },
      ],
      canUndo: true,
    });
    expect(extractMessages).toHaveBeenCalledOnce();
  });

  it("uses reassertion evidence for a legacy fact whose canonical source is null", async () => {
    const fixture = jobFixture();
    const legacy = recordFact(fixture.db, {
      subjectId: selfEntity(fixture.db).id,
      predicate: "prefers",
      object: "espresso",
      sourceMessageId: null,
    }).fact;
    expect(legacy.source_message_id).toBeNull();
    expect(
      fixture.db
        .prepare("SELECT COUNT(*) AS count FROM fact_evidence WHERE fact_id = ?")
        .get(legacy.id),
    ).toEqual({ count: 0 });

    const result = await processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toMatchObject({
      status: "completed",
      items: [
        {
          id: `fact_${legacy.id.toString(36)}`,
          change: "updated",
          sourceId: `message_${fixture.source.id.toString(36)}`,
        },
      ],
    });
    expect(getFact(fixture.db, legacy.id)?.source_message_id).toBeNull();
    expect(
      fixture.db
        .prepare(
          `SELECT source_message_id FROM fact_evidence
           WHERE fact_id = ? ORDER BY id`,
        )
        .all(legacy.id),
    ).toEqual([{ source_message_id: fixture.source.id }]);
  });

  it("routes clear material to review when remembering is confirm", async () => {
    const fixture = jobFixture("confirm");
    const result = await processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toMatchObject({
      status: "completed",
      items: [expect.objectContaining({ change: "needs_review" })],
      canUndo: false,
    });
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM fact").get(),
    ).toEqual({ count: 0 });
    expect(getMessage(fixture.db, fixture.source.id)).toMatchObject({
      recall_state: "blocked",
    });
  });

  it("routes clear goals to review without creating an intention in confirm mode", async () => {
    const fixture = jobFixture("confirm");
    const extraction: ParsedExtraction = {
      entities: [],
      facts: [],
      goals: [
        {
          existing_id: null,
          title: "Learn Italian",
          status: "active",
          priority: { op: "clear" },
          target_at: { op: "clear" },
          project: { op: "clear" },
          evidence: [{ source_message_id: fixture.source.id, quote: "I like espresso" }],
          confidence: 0.95,
          grounding: "user_statement",
          explicitness: "explicit",
          sensitivity: "normal",
          ambiguity: "clear",
        },
      ],
      commitments: [],
      facets: [],
      source_assessments: [
        { source_message_id: fixture.source.id, sensitivity: "normal", sensitive_quotes: [] },
      ],
    };
    const result = await processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extraction),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });
    expect(result?.items).toEqual([
      expect.objectContaining({ kind: "plan", change: "needs_review", label: "Learn Italian" }),
    ]);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM goal").get()).toEqual({ count: 0 });
  });

  it("never reuses a Remembering Off message as evidence in a later job", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const excluded = appendMessage(db, conversation.id, "user", "I like espresso", {
      recallState: "blocked",
      crossChatRecallEligible: false,
    });
    appendMessage(db, conversation.id, "assistant", "Understood", {
      crossChatRecallEligible: false,
    });
    const source = appendMessage(db, conversation.id, "user", "Continue");
    const assistant = appendMessage(db, conversation.id, "assistant", "Sure");
    const job = createMemoryJob(db, {
      conversationId: conversation.id,
      sourceMessageId: source.id,
      assistantMessageId: assistant.id,
      promptVersion: "test-v1",
      rememberingMode: "automatic",
      id: "job_after_off",
    });

    const result = await processMemoryJob(db, job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(excluded.id)),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toMatchObject({ status: "completed", items: [] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM fact").get()).toEqual({ count: 0 });
    expect(getMessage(db, excluded.id)).toMatchObject({
      recall_state: "blocked",
      cross_chat_recall_eligible: 0,
    });
  });

  it("serializes per conversation and claims the oldest pending job", async () => {
    const fixture = jobFixture();
    const secondSource = appendMessage(fixture.db, fixture.conversation.id, "user", "I like tea");
    const secondAssistant = appendMessage(fixture.db, fixture.conversation.id, "assistant", "Noted");
    const second = createMemoryJob(fixture.db, {
      conversationId: fixture.conversation.id,
      sourceMessageId: secondSource.id,
      assistantMessageId: secondAssistant.id,
      promptVersion: "test-v1",
      rememberingMode: "automatic",
      id: "job_second",
    });
    const extractMessages = vi.fn().mockResolvedValue(extractionFor(fixture.source.id));

    const requested = await processMemoryJob(fixture.db, second.id, {
      extractMessages,
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    expect(requested?.status).toBe("pending");
    expect(getMemoryJob(fixture.db, fixture.job.id)?.status).toBe("completed");
    expect(extractMessages).toHaveBeenCalledOnce();
  });

  it("recovers a stale running claim", async () => {
    const fixture = jobFixture();
    fixture.db.prepare(
      "UPDATE memory_job SET status = 'running', started_at = ? WHERE id = ?",
    ).run("2020-01-01T00:00:00.000Z", fixture.job.id);

    const result = await processMemoryJob(fixture.db, fixture.job.id, {
      clock: () => new Date("2026-08-12T00:00:00.000Z"),
      staleAfterMs: 1_000,
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });
    expect(result?.status).toBe("completed");
  });

  it("drains pending durable jobs without a browser-selected id", async () => {
    const first = jobFixture();
    const secondConversation = createConversation(first.db);
    const secondSource = appendMessage(
      first.db,
      secondConversation.id,
      "user",
      "I like tea",
    );
    const secondAssistant = appendMessage(
      first.db,
      secondConversation.id,
      "assistant",
      "Noted",
    );
    const second = createMemoryJob(first.db, {
      conversationId: secondConversation.id,
      sourceMessageId: secondSource.id,
      assistantMessageId: secondAssistant.id,
      promptVersion: "test-v1",
      rememberingMode: "automatic",
      id: "job_independent_second",
    });
    const extractMessages = vi
      .fn()
      .mockResolvedValueOnce(extractionFor(first.source.id))
      .mockResolvedValueOnce(
        extractionFor(secondSource.id, {
          object: "tea",
          quote: "I like tea",
        }),
      );

    const processed = await processPendingMemoryJobs(first.db, {
      extractMessages,
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    expect(processed).toBe(2);
    expect(getMemoryJob(first.db, first.job.id)?.status).toBe("completed");
    expect(getMemoryJob(first.db, second.id)?.status).toBe("completed");
  });

  it("recovers a stale running job through the independent drain", async () => {
    const fixture = jobFixture();
    fixture.db.prepare(
      "UPDATE memory_job SET status = 'running', started_at = ? WHERE id = ?",
    ).run("2020-01-01T00:00:00.000Z", fixture.job.id);

    const processed = await processPendingMemoryJobs(fixture.db, {
      clock: () => new Date("2026-08-12T00:00:00.000Z"),
      staleAfterMs: 1_000,
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });

    expect(processed).toBe(1);
    expect(getMemoryJob(fixture.db, fixture.job.id)?.status).toBe("completed");
  });

  it("releases an interrupted process lease for immediate restart recovery", () => {
    const fixture = jobFixture();
    fixture.db.prepare(
      "UPDATE memory_job SET status = 'running', started_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), fixture.job.id);

    expect(recoverInterruptedMemoryJobs(fixture.db)).toBe(1);
    expect(getMemoryJob(fixture.db, fixture.job.id)?.status).toBe("pending");
  });

  it("keeps applied memory completed and undoable when derived indexing fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fixture = jobFixture();

    const result = await processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: vi.fn().mockRejectedValue(new Error("embedding unavailable")),
    });

    expect(result).toMatchObject({
      status: "completed",
      canUndo: true,
      error: null,
      items: [expect.objectContaining({ label: "You prefer espresso" })],
    });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM fact").get()).toEqual({ count: 1 });
    warning.mockRestore();
  });

  it("fences a deferred embedding write after all Zeus data is cleared", async () => {
    const fixture = jobFixture();
    const embeddingStarted = deferred();
    const releaseEmbedding = deferred();
    let staleWrite: boolean | null = null;

    const processing = processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: async (db, _sourceMessageId, applied, _mode, guard) => {
        const fact = applied.facts[0];
        if (!fact) throw new Error("Expected an applied fact");
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
        staleWrite = putEmbedding(
          db,
          "fact",
          fact.id,
          new Float32Array([1, 2, 3]),
          guard,
        );
      },
    });

    await embeddingStarted.promise;
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM fact").get()).toEqual({ count: 1 });

    clearZeusData(fixture.db);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM embedding").get()).toEqual({ count: 0 });
    releaseEmbedding.resolve();
    await processing;

    expect(staleWrite).toBe(false);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM conversation").get()).toEqual({ count: 0 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM message").get()).toEqual({ count: 0 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM fact").get()).toEqual({ count: 0 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM memory_job").get()).toEqual({ count: 0 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM embedding").get()).toEqual({ count: 0 });
  });

  it("cannot attach a stale deferred vector to an id reused after source deletion", async () => {
    const fixture = jobFixture();
    const embeddingStarted = deferred();
    const releaseEmbedding = deferred();
    let originalFactId = 0;
    let staleWrite: boolean | null = null;

    const processing = processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: async (db, _sourceMessageId, applied, _mode, guard) => {
        const fact = applied.facts[0];
        if (!fact) throw new Error("Expected an applied fact");
        originalFactId = fact.id;
        embeddingStarted.resolve();
        await releaseEmbedding.promise;
        staleWrite = putEmbedding(
          db,
          "fact",
          fact.id,
          new Float32Array([1, 2, 3]),
          guard,
        );
      },
    });

    await embeddingStarted.promise;
    deleteConversationWithMemory(fixture.db, fixture.conversation.id);

    const replacementConversation = createConversation(fixture.db);
    const replacementSource = appendMessage(
      fixture.db,
      replacementConversation.id,
      "user",
      "I prefer a different detail",
    );
    const replacement = recordFact(fixture.db, {
      subjectId: selfEntity(fixture.db).id,
      predicate: "prefers",
      object: "a different detail",
      sourceMessageId: replacementSource.id,
    }).fact;
    expect(replacement.id).toBe(originalFactId);
    putEmbedding(
      fixture.db,
      "fact",
      replacement.id,
      new Float32Array([9, 8, 7]),
    );

    releaseEmbedding.resolve();
    await processing;

    expect(staleWrite).toBe(false);
    const row = fixture.db
      .prepare<[number], { vec: Buffer }>(
        "SELECT vec FROM embedding WHERE owner_kind = 'fact' AND owner_id = ?",
      )
      .get(replacement.id);
    expect(row).toBeDefined();
    expect(Array.from(fromBlob(row!.vec))).toEqual([9, 8, 7]);
    expect(getFact(fixture.db, replacement.id)?.object).toBe("a different detail");
  });

  it("undoes an untouched safe insert", async () => {
    const fixture = jobFixture();
    const completed = await processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });
    const factId = Number.parseInt(completed?.items[0]?.id.split("_")[1] ?? "", 36);

    const result = undoMemoryJob(fixture.db, fixture.job.id);
    expect(result.outcome).toBe("undone");
    expect(getFact(fixture.db, factId)).toBeNull();
    expect(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM evidence_passage WHERE message_id = ?").get(fixture.source.id),
    ).toEqual({ count: 0 });
    expect(getMessage(fixture.db, fixture.source.id)?.recall_state).toBe("blocked");
    expect(getMemoryJob(fixture.db, fixture.job.id)).toMatchObject({
      canUndo: false,
      undone: true,
    });
  });

  it("returns a conflict after later evidence touches the inserted fact", async () => {
    const fixture = jobFixture();
    const completed = await processMemoryJob(fixture.db, fixture.job.id, {
      extractMessages: vi.fn().mockResolvedValue(extractionFor(fixture.source.id)),
      embedApplied: vi.fn().mockResolvedValue(undefined),
    });
    const factId = Number.parseInt(completed?.items[0]?.id.split("_")[1] ?? "", 36);
    const later = appendMessage(fixture.db, fixture.conversation.id, "user", "Still true");
    recordFact(fixture.db, {
      subjectId: selfEntity(fixture.db).id,
      predicate: "prefers",
      object: "espresso",
      sourceMessageId: later.id,
    });

    const result = undoMemoryJob(fixture.db, fixture.job.id);
    expect(result.outcome).toBe("conflict");
    expect(getFact(fixture.db, factId)).not.toBeNull();
    expect(getMemoryJob(fixture.db, fixture.job.id)?.canUndo).toBe(false);
  });
});

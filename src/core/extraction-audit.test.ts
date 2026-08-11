import { beforeEach, describe, expect, it } from "vitest";

import { createCandidate } from "./candidates";
import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import {
  applyExtraction,
  acceptCandidate,
  buildExtractionInput,
  EXTRACTION_INPUT_TOKEN_BUDGET,
  extractionContext,
  finishExtractionRun,
  getExtractionRun,
  startExtractionRun,
} from "./extract";
import { evidenceForFact, liveFacts, recordFact } from "./facts";
import { commitmentEvents, goalEvents } from "./intentions";
import { passagesForMessage } from "./passages";
import { selfEntity } from "./entities";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

describe("bounded extraction input", () => {
  it("keeps the current message plus at most twelve preceding messages", () => {
    const conversation = createConversation(db);
    const messages = Array.from({ length: 15 }, (_, index) =>
      appendMessage(
        db,
        conversation.id,
        index % 2 === 0 ? "user" : "assistant",
        `unique-turn-marker-${index}`,
      ),
    );

    const input = buildExtractionInput({
      messages,
      context: extractionContext(db),
    });

    expect(input.length).toBeLessThanOrEqual(EXTRACTION_INPUT_TOKEN_BUDGET * 4);
    expect(input).not.toContain(`message:${messages[0]!.id}: unique-turn-marker-0`);
    expect(input).not.toContain(`message:${messages[1]!.id}: unique-turn-marker-1`);
    expect(input).toContain("unique-turn-marker-2");
    expect(input).toContain("unique-turn-marker-14");
    expect(input).toContain(`ASSISTANT CONTEXT ONLY message:${messages[13]!.id}`);
    expect(input).toContain(`USER EVIDENCE message:${messages[14]!.id}`);
  });

  it("enforces the dynamic input budget even for oversized transcripts", () => {
    const conversation = createConversation(db);
    const messages = Array.from({ length: 13 }, (_, index) =>
      appendMessage(db, conversation.id, "user", `${index}:${"x".repeat(10_000)}`),
    );

    const input = buildExtractionInput({ messages, context: extractionContext(db) });

    expect(input.length).toBeLessThanOrEqual(EXTRACTION_INPUT_TOKEN_BUDGET * 4);
    expect(input).toContain(`USER EVIDENCE message:${messages.at(-1)!.id}`);
  });
});

describe("extraction-run provenance", () => {
  it("links validated evidence passages to a completed production run", () => {
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I prefer concise answers.");
    const run = startExtractionRun(db, source.id);

    const applied = applyExtraction(
      db,
      {
        entities: [],
        facts: [],
        facets: [
          {
            kind: "communication_style",
            statement: "Prefers concise answers",
            scope: { kind: "global" },
            confidence: 0.98,
            evidence: [
              {
                source_message_id: source.id,
                quote: "I prefer concise answers.",
              },
            ],
          },
        ],
        source_assessments: [
          {
            source_message_id: source.id,
            sensitivity: "normal",
            sensitive_quotes: [],
          },
        ],
      },
      source.id,
      { requireEvidence: true, extractionRunId: run.id },
    );
    const finished = finishExtractionRun(db, run.id, "completed");

    expect(applied.facets).toHaveLength(1);
    expect(finished?.status).toBe("completed");
    expect(finished?.completed_at).not.toBeNull();
    expect(passagesForMessage(db, source.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ extraction_run_id: run.id })]),
    );
  });

  it("links facts and every intention event to its exact validated claim span", () => {
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "I like espresso. I want to launch the site. I will draft the homepage.",
    );
    const run = startExtractionRun(db, source.id);
    const result = applyExtraction(
      db,
      {
        entities: [],
        facts: [
          {
            subject: "self",
            predicate: "likes",
            object: "espresso",
            object_entity: null,
            confidence: 0.98,
            supersedes_previous: false,
            evidence: [{ source_message_id: source.id, quote: "I like espresso." }],
          },
        ],
        goals: [
          {
            existing_id: null,
            title: "Launch the site",
            status: "active",
            priority: { op: "clear" },
            target_at: { op: "clear" },
            confidence: 0.98,
            evidence: [
              { source_message_id: source.id, quote: "I want to launch the site." },
            ],
          },
        ],
        commitments: [
          {
            existing_id: null,
            title: "Draft the homepage",
            owner: { op: "clear" },
            linked_goal: { op: "clear" },
            status: "open",
            due_at: { op: "clear" },
            confidence: 0.98,
            evidence: [
              { source_message_id: source.id, quote: "I will draft the homepage." },
            ],
          },
        ],
        source_assessments: [
          { source_message_id: source.id, sensitivity: "normal", sensitive_quotes: [] },
        ],
      },
      source.id,
      {
        requireEvidence: true,
        extractionRunId: run.id,
        allowedSourceMessageIds: [source.id],
      },
    );
    finishExtractionRun(db, run.id, "completed");

    expect(evidenceForFact(db, result.facts[0]!.id)[0]?.passage_id).not.toBeNull();
    expect(goalEvents(db, result.goals[0]!.id)[0]?.passage_id).not.toBeNull();
    expect(commitmentEvents(db, result.commitments[0]!.id)[0]?.passage_id).not.toBeNull();
    const passages = passagesForMessage(db, source.id);
    expect(passages.map((passage) => passage.text)).toEqual(
      expect.arrayContaining([
        "I like espresso.",
        "I want to launch the site.",
        "I will draft the homepage.",
      ]),
    );
  });

  it("retracts only the explicitly named live multi-valued fact", () => {
    const me = selfEntity(db).id;
    recordFact(db, { subjectId: me, predicate: "likes", object: "espresso" });
    recordFact(db, { subjectId: me, predicate: "likes", object: "tea" });
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I no longer like espresso.");

    const result = applyExtraction(
      db,
      {
        entities: [],
        facts: [
          {
            subject: "self",
            predicate: "likes",
            object: "espresso",
            object_entity: null,
            operation: "retract",
            confidence: 0.99,
            supersedes_previous: false,
            evidence: [
              { source_message_id: source.id, quote: "I no longer like espresso." },
            ],
          },
        ],
        source_assessments: [
          { source_message_id: source.id, sensitivity: "normal", sensitive_quotes: [] },
        ],
      },
      source.id,
      { requireEvidence: true, allowedSourceMessageIds: [source.id] },
    );

    expect(result.supersededIds).toHaveLength(1);
    expect(liveFacts(db, me, "likes").map((fact) => fact.object)).toEqual(["tea"]);
    expect(evidenceForFact(db, result.facts[0]!.id).at(-1)?.passage_id).not.toBeNull();
  });

  it("records a sanitized failure code and rejects assistant focus messages", () => {
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "Nothing was learned.");
    const run = startExtractionRun(db, source.id);
    finishExtractionRun(db, run.id, "failed", "API key / private detail");

    expect(getExtractionRun(db, run.id)).toMatchObject({
      status: "failed",
      error_code: "API_key_private_detail",
    });

    const assistant = appendMessage(db, conversation.id, "assistant", "Assistant-only text");
    expect(() => startExtractionRun(db, assistant.id)).toThrow(/stored user message/u);
  });

  it("never unlocks a whole legacy sensitive source when candidate spans are absent", () => {
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "My medical diagnosis is private, and this neighboring sentence is unrelated.",
    );
    const candidate = createCandidate(db, {
      kind: "fact",
      payload: {
        subject: "self",
        predicate: "note",
        object: "private diagnosis",
        object_entity: null,
        confidence: 0.95,
        supersedes_previous: false,
        sensitivity: "sensitive",
      },
      reason: "sensitive",
      confidence: 0.95,
      sourceMessageId: source.id,
    });

    expect(acceptCandidate(db, candidate.id)?.facts).toHaveLength(1);
    expect(
      passagesForMessage(db, source.id).filter((passage) => passage.recall_status === "allowed"),
    ).toEqual([]);
  });
});

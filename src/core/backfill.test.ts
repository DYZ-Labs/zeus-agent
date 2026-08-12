import { describe, expect, it, vi } from "vitest";

import {
  acceptEligibleBackfillFacets,
  processUnderstandingBackfillBatch,
  startUnderstandingBackfill,
} from "./backfill";
import {
  createCandidate,
  getCandidate,
  listCandidates,
  recordCandidateResolution,
  resolveCandidate,
} from "./candidates";
import { appendMessage, createConversation } from "./conversations";
import { openTestDb } from "./db";
import { acceptCandidate } from "./extract";
import { evidenceForFacet, listFacets } from "./facets";
import { ensureEvidencePassage } from "./passages";
import { Extraction as ExtractionSchema } from "./schema";
import type { FacetKind, ParsedExtraction } from "./schema";

describe("understanding history backfill", () => {
  it("snapshots only unclassified natural user history", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    appendMessage(db, conversation.id, "user", "Natural history one.");
    appendMessage(db, conversation.id, "assistant", "Assistant context.");
    appendMessage(db, conversation.id, "user", "Already classified.", {
      recallState: "classified",
    });
    appendMessage(db, conversation.id, "user", "Generated curation prose.", {
      origin: "user_action",
      recallState: "blocked",
    });

    const job = startUnderstandingBackfill(db);

    expect(job.conversation_count).toBe(1);
    expect(job.message_count).toBe(1);
    expect(job.processed_count).toBe(0);
    expect(job.status).toBe("preview");
  });

  it("creates preview candidates without rewriting canonical memory", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "I protect quiet mornings when I plan my week.",
    );
    const job = startUnderstandingBackfill(db);

    const result = await processUnderstandingBackfillBatch(db, job.id, {
      extractor: async () =>
        extraction({
          sourceId: source.id,
          quote: source.content,
          kind: "value",
          statement: "I protect quiet mornings when planning my week.",
        }),
    });

    expect(result.job.status).toBe("completed");
    expect(result.job.processed_count).toBe(1);
    expect(listFacets(db)).toEqual([]);
    const candidates = listCandidates(db, {
      kind: "facet",
      backfillJobId: job.id,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      origin: "backfill",
      status: "pending",
      reason: "backfill_preview",
      source_message_id: source.id,
    });
    expect(candidates[0]?.evidence.map((item) => item.text)).toEqual([source.content]);
    expect(
      db.prepare<[number], { recall_state: string }>(
        "SELECT recall_state FROM message WHERE id = ?",
      ).get(source.id)?.recall_state,
    ).toBe("classified");
  });

  it("batch accepts only direct clear normal previews", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const direct = appendMessage(
      db,
      conversation.id,
      "user",
      "I prefer a written comparison before a big purchase.",
    );
    const sensitive = appendMessage(
      db,
      conversation.id,
      "user",
      "My medical privacy must never be traded for convenience.",
    );
    const job = startUnderstandingBackfill(db);

    await processUnderstandingBackfillBatch(db, job.id, {
      batchSize: 5,
      extractor: async ({ messages }) => {
        const focus = messages.at(-1)!;
        return focus.id === direct.id
          ? extraction({
              sourceId: direct.id,
              quote: direct.content,
              kind: "decision_criterion",
              statement: "I want a written comparison before a big purchase.",
            })
          : extraction({
              sourceId: sensitive.id,
              quote: sensitive.content,
              kind: "boundary",
              statement: "My medical privacy must not be traded for convenience.",
              sensitivity: "sensitive",
            });
      },
    });

    const before = listCandidates(db, { kind: "facet", backfillJobId: job.id });
    expect(before).toHaveLength(2);
    expect(before.find((candidate) => candidate.source_message_id === sensitive.id)?.reasons).toEqual(
      ["sensitive", "backfill_preview"],
    );

    expect(acceptEligibleBackfillFacets(db, job.id)).toMatchObject({
      accepted: 1,
      facets: [{ kind: "decision_criterion" }],
    });
    expect(listFacets(db).map((facet) => facet.kind)).toEqual(["decision_criterion"]);
    expect(listCandidates(db, { kind: "facet", backfillJobId: job.id })).toHaveLength(1);
  });

  it("resumes a failed item and remains idempotent after completion", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I like concise plans.");
    const job = startUnderstandingBackfill(db);
    let attempt = 0;
    const extractor = vi.fn(async (): Promise<ParsedExtraction> => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary model outage");
      return ExtractionSchema.parse({
          entities: [],
          facts: [],
          facets: [],
          source_assessments: [
            { source_message_id: source.id, sensitivity: "normal", sensitive_quotes: [] },
          ],
        });
    });

    const first = await processUnderstandingBackfillBatch(db, job.id, { extractor });
    expect(first.job.status).toBe("preview");
    expect(first.job.processed_count).toBe(0);
    expect(first.job.error_message).toContain("temporary model outage");

    const resumed = await processUnderstandingBackfillBatch(db, job.id, { extractor });
    expect(resumed.job.status).toBe("completed");
    expect(resumed.job.processed_count).toBe(1);
    const again = await processUnderstandingBackfillBatch(db, job.id, { extractor });
    expect(again.processed).toBe(0);
    expect(extractor).toHaveBeenCalledTimes(2);
  });

  it("keeps edited acceptance source-backed and records the edited decision", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I prefer decisions in writing.");
    const job = startUnderstandingBackfill(db);
    await processUnderstandingBackfillBatch(db, job.id, {
      extractor: async () =>
        extraction({
          sourceId: source.id,
          quote: source.content,
          kind: "communication_style",
          statement: "I prefer decisions in writing.",
        }),
    });
    const candidate = listCandidates(db, { kind: "facet", backfillJobId: job.id })[0]!;

    const applied = acceptCandidate(db, candidate.id, {
      facetEdit: {
        statement: "Give me important decisions in writing.",
        machineEffect: "deprioritize",
        structuredCondition: null,
      },
    });

    expect(applied?.facets[0]).toMatchObject({
      statement: "Give me important decisions in writing.",
      machine_effect: "deprioritize",
      source_message_id: source.id,
    });
    expect(evidenceForFacet(db, applied!.facets[0]!.id)[0]).toMatchObject({
      source_message_id: source.id,
      quote: source.content,
    });
    expect(
      db.prepare<[number], { decision: string; edited_payload_json: string | null }>(
        `SELECT decision, edited_payload_json FROM candidate_resolution_event
         WHERE candidate_id = ? ORDER BY id DESC LIMIT 1`,
      ).get(candidate.id),
    ).toMatchObject({ decision: "edited_accepted" });
  });

  it("suppresses an exactly rejected facet across later sources", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const first = appendMessage(db, conversation.id, "user", "I always need a checklist.");
    const firstPassage = ensureEvidencePassage(db, {
      messageId: first.id,
      quote: first.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const payload = {
      item: facetItem("working_style", "I always need a checklist.", first.id, first.content),
      entities: [],
    };
    const rejected = createCandidate(db, {
      kind: "facet",
      payload,
      reason: "inference",
      confidence: 0.5,
      sourceMessageId: first.id,
      passageIds: [firstPassage.id],
    });
    expect(resolveCandidate(db, rejected.id, "rejected")).toBe(true);
    recordCandidateResolution(db, {
      candidateId: rejected.id,
      decision: "rejected",
    });

    const later = appendMessage(db, conversation.id, "user", "A checklist is always necessary.");
    const laterPassage = ensureEvidencePassage(db, {
      messageId: later.id,
      quote: later.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const repeated = createCandidate(db, {
      kind: "facet",
      payload: {
        item: facetItem("working_style", "I always need a checklist.", later.id, later.content),
        entities: [],
      },
      reason: "inference",
      confidence: 0.55,
      sourceMessageId: later.id,
      passageIds: [laterPassage.id],
    });

    expect(repeated.id).toBe(rejected.id);
    expect(getCandidate(db, rejected.id)?.status).toBe("rejected");
    expect(listCandidates(db, { kind: "facet" })).toEqual([]);
  });
});

function extraction(input: {
  sourceId: number;
  quote: string;
  kind: FacetKind;
  statement: string;
  sensitivity?: "normal" | "sensitive";
}): ParsedExtraction {
  const sensitivity = input.sensitivity ?? "normal";
  return ExtractionSchema.parse({
    entities: [],
    facts: [],
    goals: [],
    commitments: [],
    facets: [facetItem(input.kind, input.statement, input.sourceId, input.quote, sensitivity)],
    source_assessments: [
      {
        source_message_id: input.sourceId,
        sensitivity,
        sensitive_quotes: sensitivity === "sensitive" ? [input.quote] : [],
      },
    ],
  });
}

function facetItem(
  kind: FacetKind,
  statement: string,
  sourceId: number,
  quote: string,
  sensitivity: "normal" | "sensitive" = "normal",
) {
  return {
    kind,
    statement,
    scope: { kind: "global" as const },
    condition: null,
    importance: "normal" as const,
    machine_effect: null,
    confidence: 0.95,
    effective_from: null,
    evidence: [{ source_message_id: sourceId, quote }],
    grounding: "user_statement" as const,
    explicitness: "explicit" as const,
    sensitivity,
    ambiguity: "clear" as const,
  };
}

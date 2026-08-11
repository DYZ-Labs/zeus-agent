import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { searchEpisodes } from "./episodes";
import { acceptCandidate, applyExtraction } from "./extract";
import {
  correctFacet,
  evidenceForFacet,
  getFacet,
  listFacets,
  recordFacet,
} from "./facets";
import { liveFacts } from "./facts";
import {
  allowWholeMessagePassage,
  ensureEvidencePassage,
  passagesForMessage,
} from "./passages";
import { selfEntity } from "./entities";
import type { ExtractedFacet, Extraction } from "./schema";

let db: Db;

beforeEach(() => {
  vi.stubEnv("ZEUS_EMBEDDINGS", "off");
  db = openTestDb();
});

function message(content: string, role: "user" | "assistant" = "user") {
  const conversation = createConversation(db);
  return appendMessage(db, conversation.id, role, content);
}

function facet(
  sourceMessageId: number,
  quote: string,
  overrides: Partial<ExtractedFacet> = {},
): ExtractedFacet {
  return {
    kind: "preference",
    statement: "Prefers concise explanations",
    scope: { kind: "global" },
    condition: null,
    importance: "normal",
    machine_effect: null,
    confidence: 0.95,
    effective_from: null,
    evidence: [{ source_message_id: sourceMessageId, quote }],
    grounding: "user_statement",
    explicitness: "explicit",
    sensitivity: "normal",
    ambiguity: "clear",
    ...overrides,
  };
}

function extraction(partial: Partial<Extraction>): Extraction {
  return { entities: [], facts: [], ...partial };
}

describe("claim-level episodic privacy", () => {
  it("proves exact quotes and derives stable source offsets", () => {
    const source = message("Café plans, then café plans again.");
    const quote = "Café plans";
    const first = ensureEvidencePassage(db, {
      messageId: source.id,
      quote,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const repeated = ensureEvidencePassage(db, {
      messageId: source.id,
      quote,
      sensitivity: "normal",
      recallStatus: "allowed",
    });

    expect(first.id).toBe(repeated.id);
    expect(first.start_offset).toBe(source.content.indexOf(quote));
    expect(first.end_offset).toBe(first.start_offset + quote.length);
    expect(() =>
      ensureEvidencePassage(db, {
        messageId: source.id,
        quote: "a paraphrase",
        sensitivity: "normal",
        recallStatus: "allowed",
      }),
    ).toThrow(/does not occur/u);

    const assistant = message("The user values speed.", "assistant");
    expect(() =>
      ensureEvidencePassage(db, {
        messageId: assistant.id,
        quote: assistant.content,
        sensitivity: "normal",
        recallStatus: "allowed",
      }),
    ).toThrow(/user message/u);
  });

  it("keeps new messages unrecalled until classification succeeds", async () => {
    const source = message("Project Aurora is a calm, local-first journal.");
    expect(await searchEpisodes(db, "Project Aurora")).toEqual([]);

    applyExtraction(
      db,
      extraction({
        source_assessments: [
          { source_message_id: source.id, sensitivity: "normal", sensitive_quotes: [] },
        ],
      }),
      source.id,
      { requireEvidence: true },
    );

    expect((await searchEpisodes(db, "Project Aurora"))[0]?.message.id).toBe(source.id);
  });

  it("unlocks only an accepted sensitive evidence span", async () => {
    const source = message(
      "I enjoy hiking. My medical diagnosis is migraine. I prefer jasmine tea.",
    );
    const quote = "My medical diagnosis is migraine.";
    const held = applyExtraction(
      db,
      extraction({
        facts: [
          {
            subject: "self",
            predicate: "health_note",
            object: "migraine",
            object_entity: null,
            confidence: 0.99,
            supersedes_previous: false,
            effective_from: null,
            evidence: [{ source_message_id: source.id, quote }],
            grounding: "user_statement",
            explicitness: "explicit",
            sensitivity: "sensitive",
            ambiguity: "clear",
          },
        ],
        source_assessments: [
          { source_message_id: source.id, sensitivity: "sensitive", sensitive_quotes: [quote] },
        ],
      }),
      source.id,
      { requireEvidence: true },
    );

    expect(held.candidates[0]?.reason).toBe("sensitive");
    expect(await searchEpisodes(db, "migraine")).toEqual([]);
    expect(await searchEpisodes(db, "hiking")).toEqual([]);

    acceptCandidate(db, held.candidates[0]!.id);
    expect((await searchEpisodes(db, "migraine"))[0]?.excerpt).toBe(quote);
    expect(await searchEpisodes(db, "hiking")).toEqual([]);
    expect(liveFacts(db, selfEntity(db).id, "health_note")[0]?.object).toBe("migraine");
  });

  it("rejects assistant evidence and invalid quotes on the strict live path", () => {
    const source = message("Sure, let us continue.");
    const assistant = message("The user loves skydiving.", "assistant");
    const result = applyExtraction(
      db,
      extraction({
        facts: [
          {
            subject: "self",
            predicate: "likes",
            object: "skydiving",
            object_entity: null,
            confidence: 0.99,
            supersedes_previous: false,
            effective_from: null,
            evidence: [
              { source_message_id: assistant.id, quote: "The user loves skydiving." },
            ],
            grounding: "user_statement",
            explicitness: "explicit",
            sensitivity: "normal",
            ambiguity: "clear",
          },
        ],
      }),
      source.id,
      { requireEvidence: true },
    );

    expect(result.facts).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/missing exact user evidence/u);
  });
});

describe("accepted understanding facets", () => {
  it("auto-accepts a direct, clear, non-sensitive facet with exact evidence", () => {
    const source = message("When choices are technical, I prefer concise explanations.");
    const result = applyExtraction(
      db,
      extraction({
        facets: [facet(source.id, source.content)],
        source_assessments: [
          { source_message_id: source.id, sensitivity: "normal", sensitive_quotes: [] },
        ],
      }),
      source.id,
      { requireEvidence: true },
    );

    expect(result.candidates).toEqual([]);
    expect(result.facets).toHaveLength(1);
    expect(listFacets(db).map((item) => item.statement)).toEqual([
      "Prefers concise explanations",
    ]);
    expect(evidenceForFacet(db, result.facets[0]!.id)[0]).toMatchObject({
      source_message_id: source.id,
      quote: source.content,
    });
  });

  it("keeps recurring patterns in review and requires two independent passages", () => {
    const first = message("I do my hardest work before lunch.");
    const second = message("Morning is when focused work feels easiest.");
    const result = applyExtraction(
      db,
      extraction({
        facets: [
          facet(first.id, first.content, {
            kind: "capacity_pattern",
            statement: "Focused work is easiest in the morning",
            explicitness: "inferred",
            confidence: 0.75,
            evidence: [
              { source_message_id: first.id, quote: first.content },
              { source_message_id: second.id, quote: second.content },
            ],
          }),
          facet(second.id, second.content, {
            kind: "working_style",
            statement: "Works best alone",
            explicitness: "inferred",
            confidence: 0.7,
          }),
        ],
        source_assessments: [
          { source_message_id: first.id, sensitivity: "normal", sensitive_quotes: [] },
          { source_message_id: second.id, sensitivity: "normal", sensitive_quotes: [] },
        ],
      }),
      second.id,
      { requireEvidence: true },
    );

    expect(result.facets).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.reasons).toContain("inference");
    expect(result.candidates[0]?.evidence).toHaveLength(2);

    const accepted = acceptCandidate(db, result.candidates[0]!.id);
    expect(accepted?.facets).toHaveLength(1);
    expect(evidenceForFacet(db, accepted!.facets[0]!.id)).toHaveLength(2);
  });

  it("requires explicit review before a machine effect can influence policy", () => {
    const source = message("Please never recommend work tasks on Sunday.");
    const held = applyExtraction(
      db,
      extraction({
        facets: [
          facet(source.id, source.content, {
            kind: "boundary",
            statement: "No work recommendations on Sunday",
            scope: { kind: "domain", label: "work" },
            machine_effect: "block",
          }),
        ],
        source_assessments: [
          { source_message_id: source.id, sensitivity: "normal", sensitive_quotes: [] },
        ],
      }),
      source.id,
      { requireEvidence: true },
    );

    expect(held.facets).toEqual([]);
    expect(held.candidates[0]?.reason).toBe("ambiguous");
    const accepted = acceptCandidate(db, held.candidates[0]!.id);
    expect(accepted?.facets[0]?.machine_effect).toBe("block");
  });

  it("deduplicates reassertions and versions sourced corrections", () => {
    const first = message("I prefer written summaries after meetings.");
    const firstPassage = allowWholeMessagePassage(db, first.id);
    const original = recordFacet(db, {
      kind: "communication_style",
      statement: "Prefers written meeting summaries",
      sourceMessageId: first.id,
      passageIds: [firstPassage.id],
    });
    const reassertion = message("Written meeting summaries still help me.");
    const reassertionPassage = allowWholeMessagePassage(db, reassertion.id);
    const same = recordFacet(db, {
      kind: "communication_style",
      statement: "Prefers written meeting summaries",
      sourceMessageId: reassertion.id,
      passageIds: [reassertionPassage.id],
    });

    expect(same.id).toBe(original.id);
    expect(evidenceForFacet(db, original.id)).toHaveLength(2);

    const correction = message("Correction: give me spoken recaps, not written ones.");
    const correctionPassage = ensureEvidencePassage(db, {
      messageId: correction.id,
      quote: correction.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const replacement = correctFacet(db, original.id, {
      statement: "Prefers spoken meeting recaps",
      sourceMessageId: correction.id,
      passageIds: [correctionPassage.id],
      confidence: 1,
      sourceKind: "user_action",
    });

    expect(replacement?.id).not.toBe(original.id);
    expect(getFacet(db, original.id)).toMatchObject({
      valid_to: replacement?.valid_from,
      superseded_by: replacement?.id,
    });
    expect(listFacets(db).map((item) => item.id)).toEqual([replacement?.id]);
    expect(listFacets(db, { includeClosed: true })).toHaveLength(2);
    expect(passagesForMessage(db, correction.id)).toHaveLength(1);
  });

  it("creates a new version when a correction changes only the machine effect", () => {
    const source = message("Written summaries are best for me.");
    const original = recordFacet(db, {
      kind: "communication_style",
      statement: "Prefers written summaries",
      sourceMessageId: source.id,
      passageIds: [allowWholeMessagePassage(db, source.id).id],
    });
    const action = message("Block suggestions that replace written summaries.");
    const replacement = correctFacet(db, original.id, {
      statement: original.statement,
      machineEffect: "block",
      sourceMessageId: action.id,
      passageIds: [allowWholeMessagePassage(db, action.id).id],
      confidence: 1,
      sourceKind: "user_action",
    });

    expect(replacement).toMatchObject({ machine_effect: "block", valid_to: null });
    expect(replacement?.id).not.toBe(original.id);
    expect(getFacet(db, original.id)).toMatchObject({
      superseded_by: replacement?.id,
      valid_to: replacement?.valid_from,
    });
  });
});

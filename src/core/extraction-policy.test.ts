import { beforeEach, describe, expect, it } from "vitest";

import { resolveCandidate } from "./candidates";
import {
  acceptCandidate,
  applyExtraction,
  extractionContext,
  extractionSourceMessageIds,
} from "./extract";
import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { listFacets } from "./facets";
import { ensureEvidencePassage, passagesForMessage } from "./passages";
import type { Extraction } from "./schema";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

function userMessage(content: string) {
  const conversation = createConversation(db);
  return appendMessage(db, conversation.id, "user", content);
}

const clearNormal = {
  grounding: "user_statement" as const,
  explicitness: "explicit" as const,
  sensitivity: "normal" as const,
  ambiguity: "clear" as const,
};

describe("protected extraction evidence", () => {
  it("routes every item type through review when its source assessment is protected", () => {
    const source = userMessage(
      "I identify as queer. I want to build a neighborhood archive. I will draft its charter. Openness is a boundary for me.",
    );
    const extraction: Extraction = {
      entities: [],
      facts: [
        {
          subject: "self",
          predicate: "identity_note",
          object: "queer",
          object_entity: null,
          confidence: 0.99,
          supersedes_previous: false,
          effective_from: null,
          evidence: [
            { source_message_id: source.id, quote: "I identify as queer." },
          ],
          ...clearNormal,
        },
      ],
      goals: [
        {
          existing_id: null,
          title: "Build a neighborhood archive",
          status: "active",
          priority: { op: "clear" },
          target_at: { op: "clear" },
          confidence: 0.98,
          evidence: [
            {
              source_message_id: source.id,
              quote: "I want to build a neighborhood archive.",
            },
          ],
          ...clearNormal,
        },
      ],
      commitments: [
        {
          existing_id: null,
          title: "Draft the archive charter",
          owner: { op: "clear" },
          linked_goal: { op: "clear" },
          status: "open",
          due_at: { op: "clear" },
          confidence: 0.98,
          evidence: [
            {
              source_message_id: source.id,
              quote: "I will draft its charter.",
            },
          ],
          ...clearNormal,
        },
      ],
      facets: [
        {
          kind: "boundary",
          statement: "Openness is a boundary",
          scope: { kind: "global" },
          condition: null,
          importance: "normal",
          machine_effect: null,
          confidence: 0.98,
          effective_from: null,
          evidence: [
            {
              source_message_id: source.id,
              quote: "Openness is a boundary for me.",
            },
          ],
          ...clearNormal,
        },
      ],
      source_assessments: [
        {
          source_message_id: source.id,
          sensitivity: "sensitive",
          sensitive_quotes: ["I identify as queer."],
        },
      ],
    };

    const applied = applyExtraction(db, extraction, source.id, {
      requireEvidence: true,
      allowedSourceMessageIds: [source.id],
    });

    expect(applied.facts).toEqual([]);
    expect(applied.goals).toEqual([]);
    expect(applied.commitments).toEqual([]);
    expect(applied.facets).toEqual([]);
    expect(applied.candidates.map((candidate) => candidate.kind)).toEqual([
      "fact",
      "goal",
      "commitment",
      "facet",
    ]);
    for (const candidate of applied.candidates) {
      expect(candidate.reasons).toContain("sensitive");
      expect(candidate.evidence.length).toBeGreaterThan(0);
      expect(candidate.evidence.every((passage) => passage.sensitivity !== "normal")).toBe(
        true,
      );
    }

    const facetCandidate = applied.candidates.find((candidate) => candidate.kind === "facet")!;
    const accepted = acceptCandidate(db, facetCandidate.id);
    expect(accepted?.facets[0]).toMatchObject({
      statement: "Openness is a boundary",
      sensitivity: "sensitive",
    });
    expect(listFacets(db)).toHaveLength(1);
  });

  it("keeps a pre-existing protected passage authoritative over a normal assessment", () => {
    const source = userMessage("I prefer written plans for large purchases.");
    ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "uncertain",
      recallStatus: "pending",
    });

    const applied = applyExtraction(
      db,
      {
        entities: [],
        facts: [
          {
            subject: "self",
            predicate: "likes",
            object: "written plans for large purchases",
            object_entity: null,
            confidence: 0.99,
            supersedes_previous: false,
            effective_from: null,
            evidence: [{ source_message_id: source.id, quote: source.content }],
            ...clearNormal,
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
      { requireEvidence: true, allowedSourceMessageIds: [source.id] },
    );

    expect(applied.facts).toEqual([]);
    expect(applied.candidates[0]?.reasons).toContain("sensitive");
    expect(passagesForMessage(db, source.id)).toEqual([
      expect.objectContaining({ sensitivity: "uncertain", recall_status: "blocked" }),
    ]);
  });
});

describe("bounded extraction evidence IDs", () => {
  it("exposes only user IDs from the exact bounded transcript", () => {
    const conversation = createConversation(db);
    const messages = Array.from({ length: 15 }, (_, index) =>
      appendMessage(
        db,
        conversation.id,
        index % 2 === 0 ? "user" : "assistant",
        `turn-${index}`,
      ),
    );

    const ids = extractionSourceMessageIds({
      messages,
      context: extractionContext(db),
    });

    expect(ids).toEqual(
      messages
        .slice(-13)
        .filter((message) => message.role === "user")
        .map((message) => message.id),
    );
    expect(ids).not.toContain(messages[0]!.id);
    expect(ids).not.toContain(messages[13]!.id);
  });

  it("ignores citations and assessments for stored messages outside the allowlist", () => {
    const allowed = userMessage("I prefer short answers.");
    const hidden = userMessage("I prefer acquiring competitors.");

    const applied = applyExtraction(
      db,
      {
        entities: [],
        facts: [
          {
            subject: "self",
            predicate: "likes",
            object: "acquiring competitors",
            object_entity: null,
            confidence: 0.99,
            supersedes_previous: false,
            effective_from: null,
            evidence: [{ source_message_id: hidden.id, quote: hidden.content }],
            ...clearNormal,
          },
        ],
        source_assessments: [
          {
            source_message_id: allowed.id,
            sensitivity: "normal",
            sensitive_quotes: [],
          },
          {
            source_message_id: hidden.id,
            sensitivity: "normal",
            sensitive_quotes: [],
          },
        ],
      },
      allowed.id,
      { requireEvidence: true, allowedSourceMessageIds: [allowed.id] },
    );

    expect(applied.facts).toEqual([]);
    expect(applied.candidates).toEqual([]);
    expect(applied.skipped[0]?.reason).toMatch(/missing exact user evidence/u);
    expect(passagesForMessage(db, hidden.id)).toEqual([]);
    expect(
      db
        .prepare<[number], { recall_state: string }>(
          "SELECT recall_state FROM message WHERE id = ?",
        )
        .get(hidden.id)?.recall_state,
    ).toBe("unclassified");
  });
});

describe("candidate suppression receipts", () => {
  it("does not return accepted or rejected dedupe records as pending review", () => {
    const proposeSensitiveFact = (source: ReturnType<typeof userMessage>, object: string) =>
      applyExtraction(
        db,
        {
          entities: [],
          facts: [
            {
              subject: "self",
              predicate: "private_preference",
              object,
              object_entity: null,
              confidence: 0.99,
              supersedes_previous: false,
              effective_from: null,
              evidence: [{ source_message_id: source.id, quote: source.content }],
              ...clearNormal,
            },
          ],
          source_assessments: [
            {
              source_message_id: source.id,
              sensitivity: "sensitive",
              sensitive_quotes: [source.content],
            },
          ],
        },
        source.id,
        { requireEvidence: true, allowedSourceMessageIds: [source.id] },
      );

    const acceptedSource = userMessage("I privately prefer option alpha.");
    const acceptedProposal = proposeSensitiveFact(acceptedSource, "option alpha");
    expect(acceptedProposal.candidates).toHaveLength(1);
    expect(acceptCandidate(db, acceptedProposal.candidates[0]!.id)?.facts).toHaveLength(1);

    const acceptedRepeat = userMessage("Option alpha remains my private preference.");
    expect(proposeSensitiveFact(acceptedRepeat, "option alpha").candidates).toEqual([]);

    const rejectedSource = userMessage("I privately prefer option beta.");
    const rejectedProposal = proposeSensitiveFact(rejectedSource, "option beta");
    expect(rejectedProposal.candidates).toHaveLength(1);
    expect(resolveCandidate(db, rejectedProposal.candidates[0]!.id, "rejected")).toBe(true);

    const rejectedRepeat = userMessage("Option beta remains my private preference.");
    expect(proposeSensitiveFact(rejectedRepeat, "option beta").candidates).toEqual([]);
  });
});

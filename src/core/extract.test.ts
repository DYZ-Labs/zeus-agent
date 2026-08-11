import { beforeEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { listEntities, resolveEntity, selfEntity } from "./entities";
import { applyExtraction, extractionContext } from "./extract";
import { countFacts, factsForEntity, liveFacts } from "./facts";
import { Extraction as ExtractionSchema, type Extraction } from "./schema";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

function sourceMessage(text: string): number {
  const conversation = createConversation(db, { source: "seed" });
  return appendMessage(db, conversation.id, "user", text).id;
}

/** Convenience builder so fixtures read as the model's output, not as boilerplate. */
function extraction(partial: Partial<Extraction>): Extraction {
  return {
    entities: partial.entities ?? [],
    facts: partial.facts ?? [],
    goals: partial.goals,
    commitments: partial.commitments,
  };
}

describe("applyExtraction", () => {
  it("writes facts about the user against the self entity, with provenance", () => {
    const source = sourceMessage("I work at Acme and I live in Lisbon.");

    const result = applyExtraction(
      db,
      extraction({
        entities: [{ name: "Acme", kind: "org", aliases: [] }],
        facts: [
          {
            subject: "self",
            predicate: "works_at",
            object: "Acme",
            object_entity: "Acme",
            confidence: 0.95,
            supersedes_previous: false,
          },
          {
            subject: "self",
            predicate: "lives_in",
            object: "Lisbon",
            object_entity: null,
            confidence: 0.95,
            supersedes_previous: false,
          },
        ],
      }),
      source,
    );

    expect(result.facts).toHaveLength(2);
    expect(result.skipped).toEqual([]);

    const me = selfEntity(db).id;
    expect(liveFacts(db, me, "works_at")[0]?.object).toBe("Acme");
    expect(liveFacts(db, me, "works_at")[0]?.source_message_id).toBe(source);
    // The graph edge was linked, not just stored as a string.
    expect(liveFacts(db, me, "works_at")[0]?.object_entity_slug).toBe("acme");
  });

  it("links a fact between two other entities", () => {
    applyExtraction(
      db,
      extraction({
        entities: [
          { name: "Sarah Chen", kind: "person", aliases: ["Sarah"] },
          { name: "Acme", kind: "org", aliases: [] },
        ],
        facts: [
          {
            subject: "Sarah Chen",
            predicate: "works_at",
            object: "Acme",
            object_entity: "Acme",
            confidence: 0.8,
            supersedes_previous: false,
          },
        ],
      }),
    );

    const acme = resolveEntity(db, "Acme");
    expect(acme).not.toBeNull();

    // Asking about Acme reaches Sarah — the point of storing the edge.
    const incoming = factsForEntity(db, acme!.id, { includeIncoming: true });
    expect(incoming.map((fact) => fact.subject_name)).toEqual(["Sarah Chen"]);
  });

  it("resolves a later short name to the entity created earlier", () => {
    applyExtraction(
      db,
      extraction({
        entities: [{ name: "Sarah Chen", kind: "person", aliases: ["Sarah"] }],
        facts: [
          {
            subject: "Sarah Chen",
            predicate: "works_at",
            object: "Acme",
            object_entity: null,
            confidence: 0.8,
            supersedes_previous: false,
          },
        ],
      }),
    );

    // A later turn refers to her by first name only.
    applyExtraction(
      db,
      extraction({
        entities: [{ name: "Sarah", kind: "person", aliases: [] }],
        facts: [
          {
            subject: "Sarah",
            predicate: "likes",
            object: "bouldering",
            object_entity: null,
            confidence: 0.8,
            supersedes_previous: false,
          },
        ],
      }),
    );

    const people = listEntities(db, { kind: "person" }).filter((e) => e.slug !== "self");
    expect(people).toHaveLength(1);
    expect(factsForEntity(db, people[0]!.id).map((f) => f.object).sort()).toEqual([
      "Acme",
      "bouldering",
    ]);
  });

  it("supersedes across separate extractions, the job-change case", () => {
    applyExtraction(
      db,
      extraction({
        entities: [{ name: "Acme", kind: "org", aliases: [] }],
        facts: [
          {
            subject: "self",
            predicate: "works_at",
            object: "Acme",
            object_entity: "Acme",
            confidence: 0.95,
            supersedes_previous: false,
          },
        ],
      }),
      sourceMessage("I work at Acme."),
    );

    applyExtraction(
      db,
      extraction({
        entities: [{ name: "Beta", kind: "org", aliases: [] }],
        facts: [
          {
            subject: "self",
            predicate: "works_at",
            object: "Beta",
            object_entity: "Beta",
            confidence: 0.95,
            supersedes_previous: true,
          },
        ],
      }),
      sourceMessage("I left Acme, I'm at Beta now."),
    );

    const me = selfEntity(db).id;
    expect(liveFacts(db, me, "works_at").map((f) => f.object)).toEqual(["Beta"]);
    expect(countFacts(db)).toEqual({ live: 1, superseded: 1 });
  });

  it("does not retire a multi-valued fact even when the model claims supersession", () => {
    const me = selfEntity(db).id;

    applyExtraction(
      db,
      extraction({
        facts: [
          {
            subject: "self",
            predicate: "likes",
            object: "espresso",
            object_entity: null,
            confidence: 0.9,
            supersedes_previous: false,
          },
        ],
      }),
    );

    // A wrong hint here would silently retire a true fact. Cardinality wins.
    applyExtraction(
      db,
      extraction({
        facts: [
          {
            subject: "self",
            predicate: "likes",
            object: "filter coffee",
            object_entity: null,
            confidence: 0.9,
            supersedes_previous: true,
          },
        ],
      }),
    );

    expect(liveFacts(db, me, "likes").map((f) => f.object).sort()).toEqual([
      "espresso",
      "filter coffee",
    ]);
  });

  it("drops facts whose subject was never declared, rather than inventing an entity", () => {
    const result = applyExtraction(
      db,
      extraction({
        entities: [],
        facts: [
          {
            subject: "Some Person We Never Met",
            predicate: "likes",
            object: "sailing",
            object_entity: null,
            confidence: 0.5,
            supersedes_previous: false,
          },
        ],
      }),
    );

    expect(result.facts).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/not declared/u);
    expect(countFacts(db).live).toBe(0);
  });

  it("normalizes a predicate the model wrote loosely", () => {
    applyExtraction(
      db,
      extraction({
        facts: [
          {
            subject: "self",
            predicate: "Cares About",
            object: "local-first software",
            object_entity: null,
            confidence: 0.9,
            supersedes_previous: false,
          },
        ],
      }),
    );

    expect(liveFacts(db, selfEntity(db).id, "cares_about")).toHaveLength(1);
  });

  it("accepts an empty extraction without touching the store", () => {
    const result = applyExtraction(db, extraction({}));
    expect(result.facts).toEqual([]);
    expect(countFacts(db)).toEqual({ live: 0, superseded: 0 });
  });

  it("skips facts with an empty object instead of throwing", () => {
    const result = applyExtraction(
      db,
      extraction({
        facts: [
          {
            subject: "self",
            predicate: "note",
            object: "   ",
            object_entity: null,
            confidence: 0.9,
            supersedes_previous: false,
          },
        ],
      }),
    );

    expect(result.skipped).toHaveLength(1);
    expect(countFacts(db).live).toBe(0);
  });

  it("keeps goal priority and target unless an update explicitly clears them", () => {
    const created = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: null,
            title: "Ship Zeus",
            status: "active",
            priority: { op: "set", value: "high" },
            target_at: { op: "set", value: "2026-10-01" },
            confidence: 0.98,
          },
        ],
      }),
      sourceMessage("Shipping Zeus by October is high priority."),
    ).goals[0]!;

    const kept = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: created.id,
            title: created.title,
            status: "paused",
            priority: { op: "keep" },
            target_at: { op: "keep" },
            confidence: 0.99,
          },
        ],
      }),
      sourceMessage("Pause the Zeus launch goal."),
    ).goals[0]!;

    expect(kept.priority).toBe("high");
    expect(kept.target_at).toBe("2026-10-01T00:00:00.000Z");

    const legacyOmission = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: created.id,
            title: created.title,
            status: "active",
            confidence: 0.99,
          },
        ],
      }),
      sourceMessage("Resume the Zeus launch goal."),
    ).goals[0]!;

    expect(legacyOmission.priority).toBe("high");
    expect(legacyOmission.target_at).toBe("2026-10-01T00:00:00.000Z");

    const cleared = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: created.id,
            title: created.title,
            status: "active",
            priority: { op: "clear" },
            target_at: { op: "clear" },
            confidence: 0.99,
          },
        ],
      }),
      sourceMessage("Remove the deadline and reset its priority."),
    ).goals[0]!;

    expect(cleared.priority).toBe("normal");
    expect(cleared.target_at).toBeNull();
  });

  it("keeps commitment owner, goal link, and due date unless explicitly cleared", () => {
    const source = sourceMessage("Morgan owns the launch review due October 5.");
    const goal = applyExtraction(
      db,
      extraction({
        goals: [
          {
            existing_id: null,
            title: "Launch Zeus",
            status: "active",
            priority: { op: "clear" },
            target_at: { op: "clear" },
            confidence: 0.95,
          },
        ],
      }),
      source,
    ).goals[0]!;
    const created = applyExtraction(
      db,
      extraction({
        entities: [{ name: "Morgan", kind: "person", aliases: [] }],
        commitments: [
          {
            existing_id: null,
            title: "Review the Zeus launch",
            owner: { op: "set", value: "Morgan" },
            linked_goal: { op: "set", value: { kind: "id", id: goal.id } },
            status: "open",
            due_at: { op: "set", value: "2026-10-05" },
            confidence: 0.95,
          },
        ],
      }),
      source,
    ).commitments[0]!;

    const kept = applyExtraction(
      db,
      extraction({
        commitments: [
          {
            existing_id: created.id,
            title: created.title,
            owner: { op: "keep" },
            linked_goal: { op: "keep" },
            status: "waiting",
            due_at: { op: "keep" },
            confidence: 0.98,
          },
        ],
      }),
      sourceMessage("The launch review is waiting."),
    ).commitments[0]!;

    expect(kept.owner_name).toBe("Morgan");
    expect(kept.linked_goal_id).toBe(goal.id);
    expect(kept.due_at).toBe("2026-10-05T00:00:00.000Z");

    const legacyOmission = applyExtraction(
      db,
      extraction({
        commitments: [
          {
            existing_id: created.id,
            title: created.title,
            status: "open",
            confidence: 0.98,
          },
        ],
      }),
      sourceMessage("Resume the launch review."),
    ).commitments[0]!;

    expect(legacyOmission.owner_name).toBe("Morgan");
    expect(legacyOmission.linked_goal_id).toBe(goal.id);
    expect(legacyOmission.due_at).toBe("2026-10-05T00:00:00.000Z");

    const cleared = applyExtraction(
      db,
      extraction({
        commitments: [
          {
            existing_id: created.id,
            title: created.title,
            owner: { op: "clear" },
            linked_goal: { op: "clear" },
            status: "open",
            due_at: { op: "clear" },
            confidence: 0.99,
          },
        ],
      }),
      sourceMessage("I'll own it now; remove the goal link and deadline."),
    ).commitments[0]!;

    expect(cleared.owner_slug).toBe("self");
    expect(cleared.linked_goal_id).toBeNull();
    expect(cleared.due_at).toBeNull();
  });
});

describe("Extraction schema", () => {
  it("requires explicit patches in model output instead of overloaded nulls", () => {
    const legacy = {
      entities: [],
      facts: [],
      goals: [
        {
          existing_id: 1,
          title: "Ship Zeus",
          status: "active",
          priority: null,
          target_at: null,
          confidence: 0.95,
        },
      ],
      commitments: [],
    };

    expect(ExtractionSchema.safeParse(legacy).success).toBe(false);
    expect(
      ExtractionSchema.parse({
        ...legacy,
        goals: [
          {
            ...legacy.goals[0],
            priority: { op: "keep" },
            target_at: { op: "clear" },
          },
        ],
      }).goals[0],
    ).toMatchObject({ priority: { op: "keep" }, target_at: { op: "clear" } });
  });
});

describe("extractionContext", () => {
  it("offers the seeded predicates so the model reuses rather than invents", () => {
    const context = extractionContext(db);
    expect(context.knownPredicates).toContain("works_at");
    expect(context.knownPredicates).toContain("cares_about");
  });

  it("lists known entities but never the self placeholder", () => {
    applyExtraction(
      db,
      extraction({
        entities: [{ name: "Acme", kind: "org", aliases: [] }],
        facts: [
          {
            subject: "self",
            predicate: "works_at",
            object: "Acme",
            object_entity: "Acme",
            confidence: 0.95,
            supersedes_previous: false,
          },
        ],
      }),
    );

    const context = extractionContext(db);
    expect(context.knownEntities).toContain("Acme");
    expect(context.knownEntities).not.toContain("You");
  });
});

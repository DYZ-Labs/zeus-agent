import { beforeEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { selfEntity, upsertEntity } from "./entities";
import {
  countFacts,
  correctFact,
  ensurePredicate,
  factsForEntity,
  forgetFact,
  getFact,
  getPredicate,
  liveFacts,
  recordFact,
  reindexFacts,
  setPredicateCardinality,
  supersedeFact,
  timeline,
} from "./facts";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

function messageId(): number {
  const conversation = createConversation(db, { source: "seed" });
  return appendMessage(db, conversation.id, "user", "a thing I said").id;
}

describe("supersession", () => {
  it("closes the old value for a single-valued predicate and keeps it readable", () => {
    const me = selfEntity(db).id;
    const acme = upsertEntity(db, { name: "Acme", kind: "org" });
    const beta = upsertEntity(db, { name: "Beta", kind: "org" });

    const first = recordFact(db, {
      subjectId: me,
      predicate: "works_at",
      object: "Acme",
      objectEntityId: acme.id,
      sourceMessageId: messageId(),
    });
    expect(first.outcome).toBe("inserted");
    expect(first.supersededIds).toEqual([]);

    const second = recordFact(db, {
      subjectId: me,
      predicate: "works_at",
      object: "Beta",
      objectEntityId: beta.id,
      sourceMessageId: messageId(),
    });

    // The new fact closed the old one and claimed it.
    expect(second.supersededIds).toEqual([first.fact.id]);

    const live = liveFacts(db, me, "works_at");
    expect(live).toHaveLength(1);
    expect(live[0]?.object).toBe("Beta");

    // Crucially, the old fact is not gone — it is dated.
    const all = factsForEntity(db, me, { includeSuperseded: true });
    const acmeFact = all.find((fact) => fact.object === "Acme");
    expect(acmeFact).toBeDefined();
    expect(acmeFact?.valid_to).not.toBeNull();
    expect(acmeFact?.superseded_by).toBe(second.fact.id);

    expect(countFacts(db)).toEqual({ live: 1, superseded: 1 });
  });

  it("keeps both values for a multi-valued predicate", () => {
    const me = selfEntity(db).id;

    recordFact(db, { subjectId: me, predicate: "likes", object: "espresso" });
    recordFact(db, { subjectId: me, predicate: "likes", object: "rock climbing" });

    const live = liveFacts(db, me, "likes");
    expect(live.map((fact) => fact.object).sort()).toEqual(["espresso", "rock climbing"]);
    expect(countFacts(db).superseded).toBe(0);
  });

  it("defaults unknown predicates to multi so nothing is silently retired", () => {
    const me = selfEntity(db).id;

    recordFact(db, { subjectId: me, predicate: "collects", object: "vinyl" });
    recordFact(db, { subjectId: me, predicate: "collects", object: "fountain pens" });

    expect(getPredicate(db, "collects")?.cardinality).toBe("multi");
    expect(liveFacts(db, me, "collects")).toHaveLength(2);
  });

  it("honours a predicate promoted to single-valued after the fact", () => {
    const me = selfEntity(db).id;

    recordFact(db, { subjectId: me, predicate: "primary_laptop", object: "MacBook Air" });
    setPredicateCardinality(db, "primary_laptop", "single");
    const result = recordFact(db, {
      subjectId: me,
      predicate: "primary_laptop",
      object: "MacBook Pro",
    });

    expect(result.supersededIds).toHaveLength(1);
    expect(liveFacts(db, me, "primary_laptop").map((f) => f.object)).toEqual(["MacBook Pro"]);
  });
});

describe("reassertion", () => {
  it("reinforces an identical fact instead of duplicating it", () => {
    const me = selfEntity(db).id;

    const first = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Lisbon",
      confidence: 0.7,
    });
    const again = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "  lisbon  ",
      confidence: 0.6,
    });

    expect(again.outcome).toBe("reasserted");
    expect(again.fact.id).toBe(first.fact.id);
    expect(again.fact.assertion_count).toBe(2);
    // Repetition is evidence: confidence rises, never falls, and never exceeds 1.
    expect(again.fact.confidence).toBeGreaterThan(first.fact.confidence);
    expect(again.fact.confidence).toBeLessThanOrEqual(1);
    expect(countFacts(db).live).toBe(1);
  });

  it("never pushes confidence above 1 no matter how often a fact repeats", () => {
    const me = selfEntity(db).id;
    for (let i = 0; i < 40; i += 1) {
      recordFact(db, { subjectId: me, predicate: "timezone", object: "WET", confidence: 0.99 });
    }
    expect(liveFacts(db, me, "timezone")[0]?.confidence).toBe(1);
  });
});

describe("provenance", () => {
  it("links every fact back to the message that produced it", () => {
    const me = selfEntity(db).id;
    const source = messageId();

    const { fact } = recordFact(db, {
      subjectId: me,
      predicate: "goal",
      object: "ship Zeus",
      sourceMessageId: source,
    });

    expect(fact.source_message_id).toBe(source);
  });

  it("refuses to record an empty object", () => {
    const me = selfEntity(db).id;
    expect(() => recordFact(db, { subjectId: me, predicate: "note", object: "   " })).toThrow();
  });
});

describe("curation", () => {
  it("closes a fact by hand and can reopen it", () => {
    const me = selfEntity(db).id;
    const { fact } = recordFact(db, { subjectId: me, predicate: "likes", object: "coffee" });

    supersedeFact(db, fact.id);
    expect(liveFacts(db, me, "likes")).toHaveLength(0);
    expect(countFacts(db)).toEqual({ live: 0, superseded: 1 });
  });

  it("corrects a fact by preserving the original and sourcing its replacement", () => {
    const me = selfEntity(db).id;
    const source = messageId();
    const { fact } = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Lisben",
      sourceMessageId: source,
    });

    const correctionSource = messageId();
    const fixed = correctFact(db, fact.id, {
      object: "Lisbon",
      sourceMessageId: correctionSource,
    });
    expect(fixed?.object).toBe("Lisbon");
    expect(fixed?.source_message_id).toBe(correctionSource);
    expect(getFact(db, fact.id)?.object).toBe("Lisben");
    expect(getFact(db, fact.id)?.valid_to).not.toBeNull();
    expect(getFact(db, fact.id)?.source_message_id).toBe(source);
  });

  it("actually forgets when asked to forget", () => {
    const me = selfEntity(db).id;
    const { fact } = recordFact(db, { subjectId: me, predicate: "note", object: "a secret" });

    expect(forgetFact(db, fact.id)).toBe(true);
    expect(countFacts(db)).toEqual({ live: 0, superseded: 0 });

    const remaining = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM fact_fts")
      .get();
    expect(remaining?.n).toBe(0);
  });

  it("does not orphan a superseding link when the newer fact is forgotten", () => {
    const me = selfEntity(db).id;
    const first = recordFact(db, { subjectId: me, predicate: "works_at", object: "Acme" });
    const second = recordFact(db, { subjectId: me, predicate: "works_at", object: "Beta" });

    forgetFact(db, second.fact.id);

    const stale = factsForEntity(db, me, { includeSuperseded: true }).find(
      (fact) => fact.id === first.fact.id,
    );
    expect(stale?.superseded_by).toBeNull();
    // Still closed — forgetting the replacement does not resurrect the old truth.
    expect(stale?.valid_to).not.toBeNull();
  });
});

describe("graph edges", () => {
  it("finds facts pointing at an entity, not just from it", () => {
    const me = selfEntity(db).id;
    const acme = upsertEntity(db, { name: "Acme", kind: "org" });
    const sarah = upsertEntity(db, { name: "Sarah Chen", kind: "person" });

    recordFact(db, {
      subjectId: me,
      predicate: "works_at",
      object: "Acme",
      objectEntityId: acme.id,
    });
    recordFact(db, {
      subjectId: sarah.id,
      predicate: "works_at",
      object: "Acme",
      objectEntityId: acme.id,
    });

    const incoming = factsForEntity(db, acme.id, { includeIncoming: true });
    expect(incoming).toHaveLength(2);
    expect(incoming.map((fact) => fact.subject_name).sort()).toEqual(["Sarah Chen", "You"]);
  });
});

describe("indexing", () => {
  it("rebuilds the full-text index from the facts table", () => {
    const me = selfEntity(db).id;
    recordFact(db, { subjectId: me, predicate: "works_at", object: "Acme" });
    recordFact(db, { subjectId: me, predicate: "likes", object: "espresso" });

    db.exec("DELETE FROM fact_fts");
    expect(reindexFacts(db)).toBe(2);

    const hits = db
      .prepare<[string], { rowid: number }>(
        "SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?",
      )
      .all("espresso");
    expect(hits).toHaveLength(1);
  });
});

describe("timeline", () => {
  it("returns facts newest-first", () => {
    const me = selfEntity(db).id;
    ensurePredicate(db, "note");
    recordFact(db, { subjectId: me, predicate: "note", object: "first" });
    recordFact(db, { subjectId: me, predicate: "note", object: "second" });

    const entries = timeline(db, { limit: 10 });
    expect(entries[0]?.object).toBe("second");
    expect(entries).toHaveLength(2);
  });
});

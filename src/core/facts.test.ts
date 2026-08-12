import { beforeEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { selfEntity, upsertEntity } from "./entities";
import {
  countFacts,
  correctFact,
  ensurePredicate,
  evidenceForFact,
  factsForEntity,
  forgetFact,
  getFact,
  getPredicate,
  liveFacts,
  recordFact,
  recomputeFactEvidenceAggregates,
  reindexFacts,
  retractFact,
  setPredicateCardinality,
  supersedeFact,
  timeline,
} from "./facts";
import { recordMcpRecallAudit } from "./mcp-audit";
import { authorizeWorkPlan, createWorkArtifact, createWorkPlan, getWorkPlan, runWorkPlan } from "./work-plans";

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

  it("closes a prior value when a dated replacement became effective", () => {
    const me = selfEntity(db).id;
    const first = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Lisbon",
      validFrom: "2024-01-01",
    });
    const second = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Berlin",
      validFrom: "2025-03-15",
    });

    expect(getFact(db, first.fact.id)?.valid_to).toBe("2025-03-15T00:00:00.000Z");
    expect(getFact(db, first.fact.id)?.superseded_by).toBe(second.fact.id);
  });

  it("inserts a backdated value into history without replacing current truth", () => {
    const me = selfEntity(db).id;
    const current = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Lisbon",
      validFrom: "2025-06-01",
    });
    const historical = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Berlin",
      validFrom: "2025-01-01",
    });

    expect(getFact(db, current.fact.id)?.valid_to).toBeNull();
    expect(getFact(db, historical.fact.id)).toMatchObject({
      valid_to: "2025-06-01T00:00:00.000Z",
      superseded_by: current.fact.id,
    });
    expect(liveFacts(db, me, "lives_in").map((fact) => fact.object)).toEqual(["Lisbon"]);
  });

  it("splices a backdated value between two established periods", () => {
    const me = selfEntity(db).id;
    const oldest = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Berlin",
      validFrom: "2024-01-01",
    });
    const current = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Lisbon",
      validFrom: "2025-01-01",
    });
    const middle = recordFact(db, {
      subjectId: me,
      predicate: "lives_in",
      object: "Paris",
      validFrom: "2024-06-01",
    });

    expect(getFact(db, oldest.fact.id)).toMatchObject({
      valid_to: "2024-06-01T00:00:00.000Z",
      superseded_by: middle.fact.id,
    });
    expect(getFact(db, middle.fact.id)).toMatchObject({
      valid_to: "2025-01-01T00:00:00.000Z",
      superseded_by: current.fact.id,
    });
    expect(liveFacts(db, me, "lives_in").map((fact) => fact.object)).toEqual(["Lisbon"]);
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

  it("removes immutable MCP snapshots when a fact is explicitly forgotten", () => {
    const me = selfEntity(db).id;
    const { fact } = recordFact(db, {
      subjectId: me,
      predicate: "note",
      object: "private launch phrase",
      sourceMessageId: messageId(),
    });
    recordMcpRecallAudit(db, "zeus_recall", "launch", [
      { kind: "fact", id: fact.id, snapshot: { object: fact.object } },
    ]);

    expect(forgetFact(db, fact.id)).toBe(true);
    const audit = db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM mcp_recall_audit",
    ).get();
    expect(audit?.count).toBe(0);
  });

  it("removes a bounded plan whose artifact was derived from a forgotten fact", async () => {
    const me = selfEntity(db).id;
    const sourceId = messageId();
    const { fact } = recordFact(db, {
      subjectId: me,
      predicate: "note",
      object: "private artifact basis",
      sourceMessageId: sourceId,
    });
    const request = messageId();
    const detail = createWorkPlan(db, {
      proposal: {
        objective: "Prepare a local note",
        steps: [{
          title: "Recall note",
          instruction: "Recall accepted memory",
          effect_kind: "memory_read",
          depends_on: [],
        }],
        allowed_effects: ["memory_read"],
        completion_criteria: ["A local note exists"],
        limits: { max_model_tool_calls: 2, max_retries_per_step: 0, max_duration_seconds: 60 },
      },
      sourceMessageId: request,
      origin: "explicit_request",
    });
    authorizeWorkPlan(db, detail.plan.id, {
      planHash: detail.plan.plan_hash,
      authorizationKind: "explicit_request",
      allowedEffects: ["memory_read"],
      maxModelToolCalls: 2,
      maxRetriesPerStep: 0,
      maxDurationSeconds: 60,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceMessageId: request,
    });
    const run = await runWorkPlan(db, detail.plan.id, {
      executor: async (input) => {
        createWorkArtifact(db, {
          planId: detail.plan.id,
          runId: input.run.id,
          stepId: input.step.id,
          artifact: {
            kind: "research_notes",
            title: "Private note",
            content: fact.object,
            sourceMessageIds: [sourceId],
            sourceMemoryItems: [{ sourceKind: "fact", sourceId: fact.id, snapshot: fact }],
          },
        });
        return { artifacts: [{ kind: "research_notes", title: "Checkpoint", content: "done" }] };
      },
    });
    expect(run.status).toBe("completed");

    expect(forgetFact(db, fact.id)).toBe(true);
    expect(getWorkPlan(db, detail.plan.id)).toBeNull();
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

  it("retracts one sourced multi-valued fact without losing its history", () => {
    const me = selfEntity(db).id;
    const coffeeSource = messageId();
    const climbingSource = messageId();
    const coffee = recordFact(db, {
      subjectId: me,
      predicate: "likes",
      object: "coffee",
      sourceMessageId: coffeeSource,
      validFrom: "2024-01-01",
    }).fact;
    const climbing = recordFact(db, {
      subjectId: me,
      predicate: "likes",
      object: "rock climbing",
      sourceMessageId: climbingSource,
    }).fact;
    const retractionSource = messageId();

    const closed = retractFact(db, coffee.id, {
      sourceMessageId: retractionSource,
      validTo: "2025-05-20",
    });

    expect(closed?.valid_to).toBe("2025-05-20T00:00:00.000Z");
    expect(closed?.superseded_by).toBeNull();
    expect(liveFacts(db, me, "likes").map((fact) => fact.id)).toEqual([climbing.id]);
    expect(factsForEntity(db, me, { includeSuperseded: true }).map((fact) => fact.id)).toContain(
      coffee.id,
    );
    expect(evidenceForFact(db, coffee.id).map((entry) => [entry.source_message_id, entry.kind]))
      .toEqual([
        [coffeeSource, "assertion"],
        [retractionSource, "correction"],
      ]);
  });

  it("refuses to retract a single-valued fact without a replacement", () => {
    const me = selfEntity(db).id;
    const fact = recordFact(db, {
      subjectId: me,
      predicate: "works_at",
      object: "Acme",
      sourceMessageId: messageId(),
    }).fact;
    const retractionSource = messageId();

    expect(() => retractFact(db, fact.id, { sourceMessageId: retractionSource })).toThrow(
      /single-valued/u,
    );
    expect(getFact(db, fact.id)?.valid_to).toBeNull();
    expect(evidenceForFact(db, fact.id)).toHaveLength(1);
  });

  it("refuses assistant-authored retraction evidence", () => {
    const me = selfEntity(db).id;
    const fact = recordFact(db, {
      subjectId: me,
      predicate: "likes",
      object: "coffee",
      sourceMessageId: messageId(),
    }).fact;
    const conversation = createConversation(db);
    const assistant = appendMessage(db, conversation.id, "assistant", "You no longer like coffee.");

    expect(() => retractFact(db, fact.id, { sourceMessageId: assistant.id })).toThrow(
      /user-authored/u,
    );
    expect(getFact(db, fact.id)?.valid_to).toBeNull();
    expect(evidenceForFact(db, fact.id)).toHaveLength(1);
  });
});

describe("evidence aggregates", () => {
  it("recomputes fact strength and recency from the evidence that survives", () => {
    const me = selfEntity(db).id;
    const firstSource = messageId();
    const secondSource = messageId();
    const thirdSource = messageId();
    const first = recordFact(db, {
      subjectId: me,
      predicate: "likes",
      object: "coffee",
      sourceMessageId: firstSource,
      confidence: 0.6,
    }).fact;
    recordFact(db, {
      subjectId: me,
      predicate: "likes",
      object: "coffee",
      sourceMessageId: secondSource,
      confidence: 0.8,
    });
    recordFact(db, {
      subjectId: me,
      predicate: "likes",
      object: "coffee",
      sourceMessageId: thirdSource,
      confidence: 0.7,
    });
    db.prepare<[string, number]>(
      "UPDATE fact_evidence SET created_at = ? WHERE source_message_id = ?",
    ).run("2024-01-01T00:00:00.000Z", firstSource);
    db.prepare<[string, number]>(
      "UPDATE fact_evidence SET created_at = ? WHERE source_message_id = ?",
    ).run("2024-02-01T00:00:00.000Z", secondSource);
    db.prepare<[string, number]>(
      "UPDATE fact_evidence SET created_at = ? WHERE source_message_id = ?",
    ).run("2024-03-01T00:00:00.000Z", thirdSource);

    db.prepare<[number, number]>(
      "DELETE FROM fact_evidence WHERE fact_id = ? AND source_message_id = ?",
    ).run(first.id, secondSource);
    const repaired = recomputeFactEvidenceAggregates(db, first.id);

    expect(repaired?.assertion_count).toBe(2);
    expect(repaired?.confidence).toBeCloseTo(0.72);
    expect(repaired?.last_seen_at).toBe("2024-03-01T00:00:00.000Z");
    expect(recomputeFactEvidenceAggregates(db, 999_999)).toBeNull();
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

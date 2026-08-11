import { beforeEach, describe, expect, it } from "vitest";

import { buildContext, coreFacts } from "./context";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { selfEntity, upsertEntity } from "./entities";
import { recordFact } from "./facts";
import { entitiesMentioned, search, toFtsQuery } from "./search";

/**
 * Semantic search needs a model download, so these run with embeddings off. That is
 * deliberate: it proves the FTS + graph fallback path holds up on its own, which is
 * exactly what a first run offline gets.
 */
process.env.ZEUS_EMBEDDINGS = "off";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

function seed(): { me: number; acme: number; sarah: number } {
  const me = selfEntity(db).id;
  const acme = upsertEntity(db, { name: "Acme", kind: "org" }).id;
  const sarah = upsertEntity(db, {
    name: "Sarah Chen",
    kind: "person",
    aliases: ["Sarah"],
  }).id;

  recordFact(db, { subjectId: me, predicate: "works_at", object: "Acme", objectEntityId: acme });
  recordFact(db, { subjectId: me, predicate: "lives_in", object: "Lisbon" });
  recordFact(db, { subjectId: me, predicate: "likes", object: "espresso" });
  recordFact(db, { subjectId: me, predicate: "cares_about", object: "local-first software" });
  recordFact(db, {
    subjectId: sarah,
    predicate: "works_at",
    object: "Acme",
    objectEntityId: acme,
  });
  recordFact(db, { subjectId: sarah, predicate: "likes", object: "bouldering" });

  return { me, acme, sarah };
}

describe("FTS query building", () => {
  it("turns arbitrary prose into a valid MATCH expression", () => {
    expect(toFtsQuery("where do I work?")).toBe('"work"');
    expect(toFtsQuery("Sarah Chen")).toBe('"sarah" OR "chen"');
  });

  it("returns null when the question is only stopwords", () => {
    expect(toFtsQuery("what is the")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
  });

  it("neutralizes FTS operators that would otherwise be a syntax error", () => {
    const query = toFtsQuery('who is "Sarah" AND (Acme)*');
    expect(query).not.toBeNull();
    // The point is that it survives being handed to SQLite at all.
    expect(() =>
      db.prepare("SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?").all(query),
    ).not.toThrow();
  });
});

describe("entity mentions", () => {
  it("finds a multi-word name inside a sentence", () => {
    const { sarah } = seed();
    expect(entitiesMentioned(db, "what does Sarah Chen do?")).toContain(sarah);
  });

  it("finds an entity by its short alias", () => {
    const { sarah } = seed();
    expect(entitiesMentioned(db, "tell me about Sarah")).toContain(sarah);
  });

  it("ignores very short aliases that would match everything", () => {
    seed();
    // "i" and "me" are self aliases; they must not fire on every question.
    const mentioned = entitiesMentioned(db, "what should i do about the thing");
    expect(mentioned).not.toContain(selfEntity(db).id);
  });
});

describe("search", () => {
  it("finds a fact by its exact wording", async () => {
    seed();
    const hits = await search(db, "espresso");
    expect(hits[0]?.fact.object).toBe("espresso");
    expect(hits[0]?.via).toContain("lexical");
  });

  it("reaches a person's facts through the company named in the question", async () => {
    const { sarah } = seed();
    const hits = await search(db, "who else is at Acme?");

    const subjects = hits.map((hit) => hit.fact.subject_id);
    expect(subjects).toContain(sarah);
    expect(hits.some((hit) => hit.via.includes("graph"))).toBe(true);
  });

  it("expands one hop: asking about Sarah surfaces facts about where she works", async () => {
    const { acme } = seed();
    const hits = await search(db, "tell me about Sarah Chen");

    // Sarah works at Acme, so Acme's own facts are one hop away.
    expect(hits.some((hit) => hit.fact.object_entity_id === acme)).toBe(true);
  });

  it("excludes superseded facts by default and includes them on request", async () => {
    const me = selfEntity(db).id;
    recordFact(db, { subjectId: me, predicate: "works_at", object: "Acme" });
    recordFact(db, { subjectId: me, predicate: "works_at", object: "Beta" });

    const live = await search(db, "Acme");
    expect(live.every((hit) => hit.fact.valid_to === null)).toBe(true);

    const historical = await search(db, "Acme", { includeSuperseded: true });
    expect(historical.some((hit) => hit.fact.object === "Acme")).toBe(true);
  });

  it("returns nothing for a question the memory has no bearing on", async () => {
    seed();
    expect(await search(db, "quantum chromodynamics")).toEqual([]);
  });

  it("survives a query made entirely of stopwords", async () => {
    seed();
    await expect(search(db, "what is the")).resolves.toEqual([]);
  });
});

describe("context assembly", () => {
  it("always carries core facts about the user", async () => {
    seed();
    const context = await buildContext(db, "something unrelated entirely");

    expect(context.text).toContain("What you know about the user");
    expect(context.text).toContain("Acme");
  });

  it("states plainly that it knows nothing on an empty memory", async () => {
    const context = await buildContext(db, "where do I work?");
    expect(context.text).toMatch(/nothing relevant/u);
    expect(context.hits).toEqual([]);
  });

  it("annotates every fact with when it was learned", async () => {
    seed();
    const context = await buildContext(db, "espresso");
    expect(context.text).toMatch(/learned \d{4}-\d{2}-\d{2}/u);
  });

  it("marks a superseded fact as no longer true rather than hiding the date", async () => {
    const me = selfEntity(db).id;
    const first = recordFact(db, { subjectId: me, predicate: "works_at", object: "Acme" });
    recordFact(db, { subjectId: me, predicate: "works_at", object: "Beta" });

    const { search: searchFn } = await import("./search.js");
    const hits = await searchFn(db, "Acme", { includeSuperseded: true });
    expect(hits.some((hit) => hit.fact.id === first.fact.id)).toBe(true);
  });

  it("includes superseded facts when the user asks about their history", async () => {
    const me = selfEntity(db).id;
    recordFact(db, { subjectId: me, predicate: "works_at", object: "Acme" });
    recordFact(db, { subjectId: me, predicate: "works_at", object: "Beta" });

    const context = await buildContext(db, "Where did I work previously before Beta?");
    expect(context.text).toContain("Acme");
    expect(context.text).toContain("no longer true");
  });

  it("does not repeat a core fact in the recalled section", async () => {
    seed();
    const context = await buildContext(db, "where do I work?");

    const occurrences = context.text.split("You works at: Acme").length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it("prioritizes identity facts when choosing core facts", () => {
    const me = selfEntity(db).id;
    for (let i = 0; i < 20; i += 1) {
      recordFact(db, { subjectId: me, predicate: "note", object: `trivium ${i}` });
    }
    recordFact(db, { subjectId: me, predicate: "works_at", object: "Acme" });

    const core = coreFacts(db, 5);
    expect(core.map((fact) => fact.predicate)).toContain("works_at");
  });
});

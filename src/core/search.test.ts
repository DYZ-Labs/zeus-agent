import { beforeEach, describe, expect, it } from "vitest";

import { recordCoarseLocation, updateAmbientSetting } from "./ambient";
import {
  buildContext,
  coreFacts,
  inferContextIntent,
  recordResponseContext,
} from "./context";
import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { selfEntity, upsertEntity } from "./entities";
import { recordFacet } from "./facets";
import { recordFact } from "./facts";
import { ensureEvidencePassage } from "./passages";
import { responseSelectionsForResponse } from "./response-context";
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
  it("does not inject an unrelated identity profile", async () => {
    seed();
    const context = await buildContext(db, "something unrelated entirely");

    expect(context.text).toMatch(/nothing relevant/u);
    expect(context.text).not.toContain("Acme");
    expect(context.items).toEqual([]);
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

  it("classifies request intent deterministically", () => {
    expect(inferContextIntent("Where did I work before Acme?")).toBe("historical");
    expect(inferContextIntent("Should I choose Acme or Beta?")).toBe("decision");
    expect(inferContextIntent("How should I prepare for the interview?")).toBe("advisory");
    expect(inferContextIntent("What commitments are due?")).toBe("follow_through");
    expect(inferContextIntent("How is my relationship with Sarah?")).toBe("relational");
    expect(inferContextIntent("Where do I work?")).toBe("factual");
  });

  it("uses accepted facets for decisions but not unrelated factual requests", async () => {
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "Autonomy is a deciding factor for me.",
    );
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const facet = recordFacet(db, {
      kind: "decision_criterion",
      statement: "Autonomy is a deciding factor",
      scope: { kind: "global" },
      importance: "high",
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });

    const factual = await buildContext(db, "What is the weather?", { queryVector: null });
    expect(factual.facets).toEqual([]);
    expect(factual.text).not.toContain("Autonomy");

    const decision = await buildContext(db, "Should I choose the new role?", {
      queryVector: null,
    });
    expect(decision.plan.intent).toBe("decision");
    expect(decision.facets.map((item) => item.id)).toContain(facet.id);
    expect(decision.text).toContain("Autonomy is a deciding factor");
  });

  it("caps total context and interaction contracts at their typed budgets", async () => {
    const conversation = createConversation(db);
    for (let index = 0; index < 12; index += 1) {
      const text = `Communication preference ${index}: keep explanation ${"concise ".repeat(18)}.`;
      const source = appendMessage(db, conversation.id, "user", text);
      const passage = ensureEvidencePassage(db, {
        messageId: source.id,
        quote: text,
        sensitivity: "normal",
        recallStatus: "allowed",
      });
      recordFacet(db, {
        kind: "communication_style",
        statement: text,
        scope: { kind: "global" },
        sourceMessageId: source.id,
        passageIds: [passage.id],
      });
    }

    const context = await buildContext(db, "Explain quantum chromodynamics", {
      queryVector: null,
      memoryBudgetTokens: 500,
      interactionBudgetTokens: 120,
    });
    const interactionTokens = context.plan.selections
      .filter((selection) => selection.reason === "interaction_contract")
      .reduce((total, selection) => total + selection.estimated_tokens, 0);
    expect(context.plan.budget_tokens).toBe(500);
    expect(context.plan.estimated_tokens).toBeLessThanOrEqual(500);
    expect(interactionTokens).toBeLessThanOrEqual(120);
  });

  it("applies typed location conditions consistently to descriptive personalization", async () => {
    updateAmbientSetting(db, { locationConsent: true });
    recordCoarseLocation(db, "office", new Date());
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "At the office, keep replies concise.");
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const facet = recordFacet(db, {
      kind: "communication_style",
      statement: "Prefers concise replies",
      scope: { kind: "global" },
      structuredCondition: { zones: ["office"] },
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });

    const atOffice = await buildContext(db, "Explain the result", { queryVector: null });
    expect(atOffice.facets.map((item) => item.id)).toContain(facet.id);

    recordCoarseLocation(db, "home", new Date());
    const atHome = await buildContext(db, "Explain the result", { queryVector: null });
    expect(atHome.facets.map((item) => item.id)).not.toContain(facet.id);
  });

  it("persists immutable facet selection reasons, paths, and scores", async () => {
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I value calm decisions.");
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    recordFacet(db, {
      kind: "value",
      statement: "Calm decisions matter",
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });
    const context = await buildContext(db, "Should I make this decision now?", {
      queryVector: null,
    });
    const assistant = appendMessage(db, conversation.id, "assistant", "Pause first.");
    recordResponseContext(db, assistant.id, context.plan);

    const traced = responseSelectionsForResponse(db, assistant.id);
    const facetTrace = traced.find((selection) => selection.item.kind === "facet");
    expect(facetTrace).toEqual(
      expect.objectContaining({
        reason: "query_relevant",
        score: expect.any(Number),
        via: expect.arrayContaining(["policy"]),
      }),
    );
    expect(facetTrace?.item.kind === "facet" ? facetTrace.item.facet.statement : null).toBe(
      "Calm decisions matter",
    );
  });

  it("keeps separate passages from one message as separate auditable response items", async () => {
    const sourceConversation = createConversation(db);
    const source = appendMessage(
      db,
      sourceConversation.id,
      "user",
      "Tea helps me focus. Jazz helps me think.",
    );
    const tea = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: "Tea helps me focus.",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const jazz = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: "Jazz helps me think.",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const context = await buildContext(db, "tea jazz", {
      queryVector: null,
      episodeLimit: 6,
    });
    expect(context.episodes.map((episode) => episode.passage_id).sort()).toEqual(
      [tea.id, jazz.id].sort(),
    );

    const responseConversation = createConversation(db);
    const assistant = appendMessage(db, responseConversation.id, "assistant", "Both help.");
    recordResponseContext(db, assistant.id, context.plan);
    const storedIds = db
      .prepare<[number], { item_id: number }>(
        `SELECT item_id FROM response_context
         WHERE assistant_message_id = ? AND item_kind = 'episode'
         ORDER BY item_id`,
      )
      .all(assistant.id)
      .map((row) => row.item_id);
    expect(storedIds).toEqual([tea.id, jazz.id].sort((a, b) => a - b));

    const episodes = responseSelectionsForResponse(db, assistant.id).flatMap((selection) =>
      selection.item.kind === "episode" ? [selection.item.episode] : [],
    );
    expect(
      episodes.map((episode) => ({
        passage: episode.passage_id,
        source: episode.message.id,
        start: episode.start_offset,
        end: episode.end_offset,
        text: episode.message.content,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          passage: tea.id,
          source: source.id,
          start: tea.start_offset,
          end: tea.end_offset,
          text: tea.text,
        },
        {
          passage: jazz.id,
          source: source.id,
          start: jazz.start_offset,
          end: jazz.end_offset,
          text: jazz.text,
        },
      ]),
    );
  });
});

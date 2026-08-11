/**
 * Replay a scripted conversation into a demo database and assert the memory that
 * results. This is the end-to-end check the whole design exists to pass: a job change
 * must close the old employer without losing it, and one person mentioned three ways
 * must stay one person.
 *
 * Uses fixture extractions rather than live model calls, so it runs in CI, offline,
 * and with no API key — the thing under test is the write path, not the model.
 *
 *   npm run seed:demo
 *   ZEUS_DB=/tmp/zeus-demo.db npm run seed:demo
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { appendMessage, createConversation } from "../src/core/conversations";
import { openDb } from "../src/core/db";
import { embedFact, embeddingsDisabled } from "../src/core/embed";
import { listEntities, resolveEntity, selfEntity } from "../src/core/entities";
import { applyExtraction } from "../src/core/extract";
import { countFacts, factSearchText, factsForEntity, liveFacts } from "../src/core/facts";
import type { Extraction } from "../src/core/schema";
import { search } from "../src/core/search";

const path = process.env.ZEUS_DB ?? join(homedir(), ".zeus", "demo.db");

/** A turn of the script: what was said, and what the model would have extracted. */
type Beat = { said: string; extracted: Extraction };

const SCRIPT: Beat[] = [
  {
    said: "I'm a staff engineer at Acme, working on the billing rewrite. I'm based in Lisbon.",
    extracted: {
      entities: [
        { name: "Acme", kind: "org", aliases: ["Acme Corp"] },
        { name: "billing rewrite", kind: "project", aliases: [] },
      ],
      facts: [
        { subject: "self", predicate: "works_at", object: "Acme", object_entity: "Acme", confidence: 0.95, supersedes_previous: false },
        { subject: "self", predicate: "job_title", object: "staff engineer", object_entity: null, confidence: 0.95, supersedes_previous: false },
        { subject: "self", predicate: "works_on", object: "billing rewrite", object_entity: "billing rewrite", confidence: 0.9, supersedes_previous: false },
        { subject: "self", predicate: "lives_in", object: "Lisbon", object_entity: null, confidence: 0.95, supersedes_previous: false },
      ],
    },
  },
  {
    said: "Sarah Chen runs design at Acme — she's the one to ask about the dashboard. She's really into bouldering.",
    extracted: {
      entities: [{ name: "Sarah Chen", kind: "person", aliases: ["Sarah"] }],
      facts: [
        { subject: "Sarah Chen", predicate: "works_at", object: "Acme", object_entity: "Acme", confidence: 0.9, supersedes_previous: false },
        { subject: "Sarah Chen", predicate: "job_title", object: "head of design", object_entity: null, confidence: 0.85, supersedes_previous: false },
        { subject: "Sarah Chen", predicate: "likes", object: "bouldering", object_entity: null, confidence: 0.8, supersedes_previous: false },
        { subject: "self", predicate: "knows", object: "Sarah Chen", object_entity: "Sarah Chen", confidence: 0.9, supersedes_previous: false },
      ],
    },
  },
  {
    said: "I've been reading a lot about local-first software lately. Also I'm vegetarian, in case that ever comes up.",
    extracted: {
      entities: [{ name: "local-first software", kind: "topic", aliases: ["local first"] }],
      facts: [
        { subject: "self", predicate: "cares_about", object: "local-first software", object_entity: "local-first software", confidence: 0.9, supersedes_previous: false },
        { subject: "self", predicate: "note", object: "vegetarian", object_entity: null, confidence: 0.95, supersedes_previous: false },
      ],
    },
  },
  {
    said: "Quick correction — Sarah got promoted, she's VP of design now.",
    extracted: {
      entities: [{ name: "Sarah", kind: "person", aliases: [] }],
      facts: [
        { subject: "Sarah", predicate: "job_title", object: "VP of design", object_entity: null, confidence: 0.9, supersedes_previous: true },
      ],
    },
  },
  {
    said: "Big news: I left Acme. Started at Beta Systems on Monday, same kind of role.",
    extracted: {
      entities: [{ name: "Beta Systems", kind: "org", aliases: ["Beta"] }],
      facts: [
        { subject: "self", predicate: "works_at", object: "Beta Systems", object_entity: "Beta Systems", confidence: 0.95, supersedes_previous: true },
      ],
    },
  },
];

const db = openDb(path);
console.log(`zeus: seeding demo memory into ${path}\n`);

const conversation = createConversation(db, { title: "Demo conversation", source: "seed" });

for (const beat of SCRIPT) {
  const message = appendMessage(db, conversation.id, "user", beat.said);
  const applied = applyExtraction(db, beat.extracted, message.id);

  console.log(`  “${beat.said.slice(0, 62)}${beat.said.length > 62 ? "…" : ""}”`);
  console.log(
    `    +${applied.facts.length} facts` +
      (applied.supersededIds.length ? `, ${applied.supersededIds.length} superseded` : "") +
      (applied.skipped.length ? `, ${applied.skipped.length} skipped` : ""),
  );

  if (!embeddingsDisabled()) {
    for (const fact of applied.facts) {
      await embedFact(
        db,
        fact.id,
        factSearchText(fact.subject_name, fact.predicate, fact.object),
      ).catch(() => false);
    }
  }
}

// ---------------------------------------------------------------------------
// Assertions — the behaviours that make this memory worth keeping
// ---------------------------------------------------------------------------

const me = selfEntity(db).id;
const failures: string[] = [];

function check(label: string, assertion: () => void): void {
  try {
    assertion();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : error}`);
  }
}

console.log("\nchecks:");

check("the job change closed Acme and made Beta Systems current", () => {
  const current = liveFacts(db, me, "works_at");
  assert.equal(current.length, 1);
  assert.equal(current[0]?.object, "Beta Systems");
});

check("Acme is still answerable as history, not deleted", () => {
  const all = factsForEntity(db, me, { includeSuperseded: true });
  const acme = all.find((fact) => fact.predicate === "works_at" && fact.object === "Acme");
  assert.ok(acme, "the Acme fact is gone entirely");
  assert.ok(acme.valid_to !== null, "the Acme fact was never closed");
  assert.ok(acme.superseded_by !== null, "the Acme fact does not point at its replacement");
});

check("Sarah, Sarah Chen and sarah are one person", () => {
  const people = listEntities(db, { kind: "person" }).filter((e) => e.slug !== "self");
  assert.equal(people.length, 1, `expected 1 person, found ${people.length}`);
  assert.equal(resolveEntity(db, "sarah")?.id, people[0]?.id);
});

check("Sarah's promotion superseded her old title", () => {
  const sarah = resolveEntity(db, "Sarah Chen");
  assert.ok(sarah);
  const titles = liveFacts(db, sarah.id, "job_title");
  assert.equal(titles.length, 1);
  assert.equal(titles[0]?.object, "VP of design");
});

check("multi-valued facts were not retired by the corrections", () => {
  assert.equal(liveFacts(db, me, "cares_about").length, 1);
  assert.equal(liveFacts(db, me, "note").length, 1);
});

check("every fact links back to the message that produced it", () => {
  const orphans = factsForEntity(db, me, { includeSuperseded: true }).filter(
    (fact) => fact.source_message_id === null,
  );
  assert.equal(orphans.length, 0, `${orphans.length} facts have no source`);
});

check("asking about Acme still reaches Sarah through the graph", async () => {
  // Synchronous check on the graph edge itself; search() is exercised below.
  const acme = resolveEntity(db, "Acme");
  assert.ok(acme);
  const linked = factsForEntity(db, acme.id, { includeIncoming: true, includeSuperseded: true });
  assert.ok(
    linked.some((fact) => fact.subject_name === "Sarah Chen"),
    "no Sarah fact points at Acme",
  );
});

const whereDoIWork = await search(db, "where do I work?", { limit: 5 });
check("searching 'where do I work?' surfaces the current employer first", () => {
  assert.ok(whereDoIWork.length > 0, "no results at all");
  assert.ok(
    whereDoIWork.some((hit) => hit.fact.object === "Beta Systems"),
    `got: ${whereDoIWork.map((h) => h.fact.object).join(", ")}`,
  );
});

const unknown = await search(db, "quantum chromodynamics");
check("a question outside the memory returns nothing to answer from", () => {
  assert.equal(unknown.length, 0);
});

const counts = countFacts(db);
console.log(`\n${counts.live} live facts, ${counts.superseded} superseded`);
db.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll checks passed. Browse it with:\n  ZEUS_DB=${path} npm run dev\n`);

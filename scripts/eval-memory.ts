/**
 * Deterministic trust evaluation. Model quality needs a live corpus; this fixture
 * protects the policy and write path offline on every full check.
 */
import assert from "node:assert/strict";

import { appendMessage, createConversation } from "../src/core/conversations";
import { openTestDb } from "../src/core/db";
import { searchEpisodes } from "../src/core/episodes";
import { selfEntity } from "../src/core/entities";
import { acceptCandidate, applyExtraction } from "../src/core/extract";
import { liveFacts } from "../src/core/facts";
import { listCommitments, listGoals } from "../src/core/intentions";
import {
  createEvaluationContext,
  recommendNextAction,
  recordFollowThroughDecision,
} from "../src/core/stewardship";

process.env.ZEUS_EMBEDDINGS ??= "off";

const db = openTestDb();
const conversation = createConversation(db, { title: "Trust evaluation", source: "seed" });

const first = appendMessage(db, conversation.id, "user", "I live in Lisbon.");
applyExtraction(
  db,
  {
    entities: [],
    facts: [
      {
        subject: "self",
        predicate: "lives_in",
        object: "Lisbon",
        object_entity: null,
        confidence: 0.98,
        supersedes_previous: false,
      },
    ],
  },
  first.id,
);

const conflict = appendMessage(db, conversation.id, "user", "I live in Berlin.");
const held = applyExtraction(
  db,
  {
    entities: [],
    facts: [
      {
        subject: "self",
        predicate: "lives_in",
        object: "Berlin",
        object_entity: null,
        confidence: 0.98,
        supersedes_previous: false,
      },
    ],
  },
  conflict.id,
);
assert.equal(held.candidates.length, 1, "unexplained conflict was not held");
assert.equal(liveFacts(db, selfEntity(db).id, "lives_in")[0]?.object, "Lisbon");
acceptCandidate(db, held.candidates[0]!.id);
assert.equal(liveFacts(db, selfEntity(db).id, "lives_in")[0]?.object, "Berlin");

const intent = appendMessage(
  db,
  conversation.id,
  "user",
  "I want to launch my portfolio, and I need to write the case study by Friday.",
);
const goal = applyExtraction(
  db,
  {
    entities: [],
    facts: [],
    goals: [
      {
        existing_id: null,
        title: "Launch my portfolio",
        status: "active",
        priority: "high",
        target_at: null,
        confidence: 0.96,
      },
    ],
    commitments: [
      {
        existing_id: null,
        title: "Write the portfolio case study",
        owner: "self",
        linked_goal_id: null,
        linked_goal_title: "Launch my portfolio",
        status: "open",
        due_at: "2020-01-03",
        confidence: 0.96,
      },
    ],
    source_assessments: [
      {
        source_message_id: intent.id,
        sensitivity: "normal",
        sensitive_quotes: [],
      },
    ],
  },
  intent.id,
);
assert.equal(goal.goals.length, 1);
assert.equal(goal.commitments.length, 1);
assert.equal(listGoals(db).length, 1);
assert.equal(listCommitments(db).length, 1);
const recommendation = recommendNextAction(db, "portfolio");
assert.ok(recommendation, "relevant overdue commitment did not produce a next action");
assert.equal(recommendation.goal_priority, "high");
assert.match(recommendation.why, /high-priority goal/u);
recordFollowThroughDecision(db, {
  commitmentId: recommendation.commitment_id,
  decision: "dismissed",
});
assert.equal(
  recommendNextAction(db, "portfolio", {
    context: createEvaluationContext({ trigger: "today", timezone: "UTC" }),
  }),
  null,
  "dismissed recommendation surfaced again without a commitment change",
);

const assistant = appendMessage(
  db,
  conversation.id,
  "assistant",
  "You secretly want to sell the portfolio company.",
);
const hallucination = applyExtraction(
  db,
  {
    entities: [],
    facts: [
      {
        subject: "self",
        predicate: "goal",
        object: "sell the portfolio company",
        object_entity: null,
        confidence: 0.9,
        supersedes_previous: false,
        grounding: "assistant_only",
      },
    ],
    source_assessments: [
      {
        source_message_id: intent.id,
        sensitivity: "normal",
        sensitive_quotes: [],
      },
    ],
  },
  intent.id,
);
assert.equal(hallucination.facts.length, 0, "assistant-only text became a fact");

const episodes = await searchEpisodes(db, "portfolio case study");
assert.ok(episodes.some((entry) => entry.message.id === intent.id));
assert.ok(!episodes.some((entry) => entry.message.id === assistant.id));

db.close();
console.log(
  "zeus: trust evaluation passed (conflicts, grounding, intentions, follow-through, control, episodes)",
);

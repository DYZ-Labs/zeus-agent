/**
 * Dump the entire memory to plain Markdown.
 *
 * The escape hatch. Everything Zeus knows about you should be readable without Zeus,
 * without SQLite, and without me — otherwise "local-first" just means the lock-in is
 * on your own disk. Writes one file per entity plus an index.
 *
 *   npm run export                    # -> ./zeus-export
 *   npm run export -- /path/to/dir
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { messagesIn } from "../src/core/conversations";
import { listCandidates } from "../src/core/candidates";
import { defaultDbPath, openDb } from "../src/core/db";
import { aliasesOf, listEntities } from "../src/core/entities";
import { countFacts, evidenceForFact, factsForEntity } from "../src/core/facts";
import {
  commitmentEvents,
  goalEvents,
  listCommitments,
  listGoals,
} from "../src/core/intentions";
import type { FactView } from "../src/core/schema";
import {
  followThroughMetrics,
  getStewardshipSetting,
  listFollowThroughEvents,
} from "../src/core/stewardship";

const outDir = process.argv[2] ?? "zeus-export";
const db = openDb();

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, "entities"), { recursive: true });

function renderFact(fact: FactView, withSubject: boolean): string {
  const subject = fact.subject_slug === "self" ? "You" : fact.subject_name;
  const head = withSubject ? `**${subject}** ${fact.predicate}` : `${fact.predicate}`;
  const evidence = evidenceForFact(db, fact.id);
  const sources = evidence.map((entry) => entry.source_message_id);
  const source = sources.length
    ? ` · evidence: messages ${sources.join(", ")}`
    : fact.source_message_id
      ? ` · source: message ${fact.source_message_id}`
      : " · source: unattributed legacy fact";
  const closed = fact.valid_to ? ` · ended ${fact.valid_to.slice(0, 10)}` : "";
  const repeats = fact.assertion_count > 1 ? ` · asserted ${fact.assertion_count}×` : "";

  const effective =
    fact.valid_from.slice(0, 10) === fact.created_at.slice(0, 10)
      ? ""
      : ` · effective ${fact.valid_from.slice(0, 10)}`;
  return `- ${head}: ${fact.object}  \n  _learned ${fact.created_at.slice(0, 10)}${effective} · confidence ${fact.confidence.toFixed(2)}${closed}${repeats}${source}_`;
}

const entities = listEntities(db, { limit: 100_000 });
const counts = countFacts(db);
const indexRows: string[] = [];

for (const entity of entities) {
  const facts = factsForEntity(db, entity.id, {
    includeSuperseded: true,
    includeIncoming: true,
    limit: 100_000,
  });

  const own = facts.filter((fact) => fact.subject_id === entity.id);
  const mentions = facts.filter((fact) => fact.subject_id !== entity.id);
  const live = own.filter((fact) => fact.valid_to === null);
  const past = own.filter((fact) => fact.valid_to !== null);
  const aliases = aliasesOf(db, entity.id);

  // null marks an absent section; empty strings are intentional blank lines and must
  // survive, or the headings end up glued to the paragraph above them.
  const body = [
    `# ${entity.slug === "self" ? "You" : entity.name}`,
    ``,
    `_${entity.kind}_${aliases.length ? ` · also known as ${aliases.join(", ")}` : ""}`,
    entity.summary ? `\n${entity.summary}` : null,
    ``,
    `## Currently true`,
    ``,
    live.length ? live.map((fact) => renderFact(fact, false)).join("\n") : "_Nothing currently known._",
    past.length
      ? `\n## No longer true\n\n${past.map((fact) => renderFact(fact, false)).join("\n")}`
      : null,
    mentions.length
      ? `\n## Mentioned by others\n\n${mentions.map((fact) => renderFact(fact, true)).join("\n")}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");

  writeFileSync(join(outDir, "entities", `${entity.slug}.md`), `${body}\n`, "utf8");
  indexRows.push(
    `- [${entity.slug === "self" ? "You" : entity.name}](entities/${entity.slug}.md) — ${entity.kind}, ${live.length} live${past.length ? `, ${past.length} past` : ""}`,
  );
}

// Conversations, so the provenance references resolve to something readable.
const conversations = db
  .prepare<[], { id: number; title: string | null; started_at: string }>(
    "SELECT id, title, started_at FROM conversation ORDER BY id",
  )
  .all();

const transcripts = conversations
  .map((conversation) => {
    const messages = messagesIn(db, conversation.id, 100_000);
    const header = `## ${conversation.title ?? `Conversation ${conversation.id}`} — ${conversation.started_at.slice(0, 10)}`;
    const body = messages
      .map(
        (message) =>
          `**${message.role === "assistant" ? "Zeus" : "You"}** (message ${message.id}):  \n${message.content}`,
      )
      .join("\n\n");
    return `${header}\n\n${body}`;
  })
  .join("\n\n---\n\n");

writeFileSync(
  join(outDir, "conversations.md"),
  `# Conversations\n\nEvery fact cites the message id it came from; those ids are here.\n\n${transcripts}\n`,
  "utf8",
);

const goals = listGoals(db, { includeClosed: true, limit: 100_000 });
const commitments = listCommitments(db, { includeClosed: true, limit: 100_000 });
const goalBody = goals.length
  ? goals
      .map((goal) => {
        const events = goalEvents(db, goal.id)
          .map((event) => `  - ${event.created_at}: ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.detail_json ? ` — ${event.detail_json}` : ""}`)
          .join("\n");
        return `- **[${goal.status}] ${goal.title}** — ${goal.priority} priority${goal.target_at ? `, target ${goal.target_at}` : ""}  \n  _source: message ${goal.source_message_id}_\n${events}`;
      })
      .join("\n")
  : "_No goals._";
const commitmentBody = commitments.length
  ? commitments
      .map((item) => {
        const events = commitmentEvents(db, item.id)
          .map((event) => `  - ${event.created_at}: ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.detail_json ? ` — ${event.detail_json}` : ""}`)
          .join("\n");
        return `- **[${item.status}] ${item.title}** — owner ${item.owner_name}${item.due_at ? `, due ${item.due_at}` : ""}  \n  _source: message ${item.source_message_id}_\n${events}`;
      })
      .join("\n")
  : "_No commitments._";
writeFileSync(
  join(outDir, "open-loops.md"),
  `# Open loops\n\n## Goals\n\n${goalBody}\n\n## Commitments\n\n${commitmentBody}\n`,
  "utf8",
);

const stewardship = getStewardshipSetting(db);
const followThrough = listFollowThroughEvents(db, 100_000);
const metrics = followThroughMetrics(db);
const followThroughBody = followThrough.length
  ? followThrough
      .map(
        (event) =>
          `- ${event.created_at} — **${event.event_type}** ${event.commitment_title}  \n  _reason: ${event.reason}; action: ${event.action_kind}; source: ${event.source_kind}${event.response_message_id ? `; response: message ${event.response_message_id}` : ""}${event.source_message_id ? `; user source: message ${event.source_message_id}` : ""}_`,
      )
      .join("\n")
  : "_No follow-through decisions recorded._";
writeFileSync(
  join(outDir, "follow-through.md"),
  [
    "# Follow-through",
    "",
    "Recommendations are system proposals, not canonical facts about the user.",
    "",
    `- intervention mode: ${stewardship.mode}`,
    `- recommendations surfaced: ${metrics.surfaced}`,
    `- offers accepted: ${metrics.accepted}`,
    `- progress without a later regret signal: ${metrics.progressWithoutRegret}`,
    `- controls exercised: ${metrics.controlsExercised}`,
    `- regret signals: ${metrics.regrets}`,
    "",
    "## Event history",
    "",
    followThroughBody,
    "",
  ].join("\n"),
  "utf8",
);

const candidates = (["pending", "accepted", "rejected"] as const).flatMap((status) =>
  listCandidates(db, { status, limit: 100_000 }),
);
writeFileSync(
  join(outDir, "memory-candidates.md"),
  `# Memory candidates\n\nPending proposals are not canonical and are never used as facts until accepted.\n\n${
    candidates.length
      ? candidates
          .map(
            (candidate) =>
              `## Candidate ${candidate.id} — ${candidate.kind}\n\n- status: ${candidate.status}\n- reason: ${candidate.reason}\n- confidence: ${candidate.confidence}\n- source: message ${candidate.source_message_id}\n\n\`\`\`json\n${JSON.stringify(candidate.payload, null, 2)}\n\`\`\``,
          )
          .join("\n\n")
      : "_Nothing pending._"
  }\n`,
  "utf8",
);

writeFileSync(
  join(outDir, "README.md"),
  [
    `# Zeus memory export`,
    ``,
    `Exported ${new Date().toISOString().slice(0, 10)} from \`${defaultDbPath()}\`.`,
    ``,
    `${counts.live} facts currently true, ${counts.superseded} superseded but kept as history.`,
    `Superseded facts are not mistakes — they are what was true before, and they are the`,
    `right answer to a question about the past.`,
    ``,
    `## Entities`,
    ``,
    ...indexRows,
    ``,
    `## Provenance`,
    ``,
    `Every fact records the message that produced it. Those transcripts are in`,
    `[conversations.md](conversations.md).`,
    `Goals and commitments, including their event histories, are in [open-loops.md](open-loops.md).`,
    `Follow-through proposals and user control decisions are in [follow-through.md](follow-through.md).`,
    `Memory proposals and their review status are in [memory-candidates.md](memory-candidates.md).`,
    ``,
  ].join("\n"),
  "utf8",
);

db.close();
console.log(
  `zeus: exported ${entities.length} entities and ${counts.live + counts.superseded} facts to ${outDir}/`,
);

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
import { evidenceForFacet, listFacets } from "../src/core/facets";
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
  const sources = evidence.map(
    (entry) =>
      `message ${entry.source_message_id}${entry.passage_id ? ` / passage ${entry.passage_id}` : ""}`,
  );
  const source = sources.length
    ? ` · evidence: ${sources.join(", ")}`
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
  .prepare<
    [],
    { id: number; title: string | null; started_at: string; hidden_at: string | null }
  >(
    `SELECT c.id, c.title, c.started_at, h.hidden_at
     FROM conversation c
     LEFT JOIN conversation_history_state h ON h.conversation_id = c.id
     ORDER BY c.id`,
  )
  .all();

const transcripts = conversations
  .map((conversation) => {
    const messages = messagesIn(db, conversation.id, 100_000);
    const hidden = conversation.hidden_at ? " · removed from chat history" : "";
    const header = `## ${conversation.title ?? `Conversation ${conversation.id}`} — ${conversation.started_at.slice(0, 10)}${hidden}`;
    const body = messages
      .map(
        (message) =>
          `**${message.role === "assistant" ? "Zeus" : "You"}** (message ${message.id}; origin ${message.origin}; recall ${message.recall_state}):  \n${message.content}`,
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
          .map((event) => `  - ${event.created_at}: ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.passage_id ? ` (passage ${event.passage_id})` : ""}${event.detail_json ? ` — ${event.detail_json}` : ""}`)
          .join("\n");
        return `- **[${goal.status}] ${goal.title}** — ${goal.priority} priority${goal.target_at ? `, target ${goal.target_at}` : ""}  \n  _source: message ${goal.source_message_id}_\n${events}`;
      })
      .join("\n")
  : "_No goals._";
const commitmentBody = commitments.length
  ? commitments
      .map((item) => {
        const events = commitmentEvents(db, item.id)
          .map((event) => `  - ${event.created_at}: ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.passage_id ? ` (passage ${event.passage_id})` : ""}${event.detail_json ? ` — ${event.detail_json}` : ""}`)
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
          .map((candidate) => {
            const resolutions = db
              .prepare<
                [number],
                {
                  decision: string;
                  edited_payload_json: string | null;
                  source_message_id: number | null;
                  source_kind: string;
                  created_at: string;
                }
              >(
                `SELECT decision, edited_payload_json, source_message_id,
                        source_kind, created_at
                 FROM candidate_resolution_event
                 WHERE candidate_id = ? ORDER BY id`,
              )
              .all(candidate.id)
              .map(
                (event) =>
                  `  - ${event.created_at}: ${event.decision} (${event.source_kind}${event.source_message_id === null ? "" : `, message ${event.source_message_id}`})${event.edited_payload_json === null ? "" : ` — edited payload: ${event.edited_payload_json}`}`,
              )
              .join("\n");
            return `## Candidate ${candidate.id} — ${candidate.kind}\n\n- status: ${candidate.status}${candidate.resolved_at ? ` (resolved ${candidate.resolved_at})` : ""}\n- reasons: ${candidate.reasons.join(", ")}\n- confidence: ${candidate.confidence}\n- source: message ${candidate.source_message_id}\n- origin: ${candidate.origin}${candidate.backfill_job_id ? ` (backfill job ${candidate.backfill_job_id})` : ""}\n- evidence: ${candidate.evidence.length ? candidate.evidence.map((passage) => `passage ${passage.id} / message ${passage.message_id}`).join(", ") : "none"}\n\nPayload:\n\n\`\`\`json\n${JSON.stringify(candidate.payload, null, 2)}\n\`\`\`\n\nResolution history:\n${resolutions || "  - _No resolution events._"}`;
          })
          .join("\n\n")
      : "_Nothing pending._"
  }\n`,
  "utf8",
);

const passages = db
  .prepare<
    [],
    {
      id: number;
      message_id: number;
      start_offset: number;
      end_offset: number;
      text: string;
      sensitivity: string;
      recall_status: string;
      extraction_run_id: number | null;
      created_at: string;
    }
  >(
    `SELECT id, message_id, start_offset, end_offset, text, sensitivity,
            recall_status, extraction_run_id, created_at
     FROM evidence_passage ORDER BY message_id, start_offset, id`,
  )
  .all();
writeFileSync(
  join(outDir, "evidence-passages.md"),
  [
    "# Evidence passages",
    "",
    "Passages are the exact claim-sized source spans Zeus may use as dated episodic evidence.",
    "A blocked or pending passage is stored but not recallable.",
    "",
    passages.length
      ? passages
          .map(
            (passage) =>
              `## Passage ${passage.id}\n\n- source: message ${passage.message_id}, offsets ${passage.start_offset}–${passage.end_offset}\n- sensitivity: ${passage.sensitivity}\n- recall: ${passage.recall_status}\n- extraction run: ${passage.extraction_run_id ?? "none"}\n- created: ${passage.created_at}\n\n> ${passage.text.replace(/\n/gu, "\n> ")}`,
          )
          .join("\n\n")
      : "_No evidence passages._",
    "",
  ].join("\n"),
  "utf8",
);

const facets = listFacets(db, { includeClosed: true, limit: 100_000 });
function facetScope(facet: (typeof facets)[number]): string {
  if (facet.scope_kind === "domain") return `domain:${facet.scope_label ?? "unknown"}`;
  if (facet.scope_kind === "entity") {
    return `entity:${facet.scope_entity_name ?? facet.scope_entity_id ?? "unknown"}`;
  }
  if (facet.scope_kind === "goal") {
    return `goal:${facet.scope_goal_title ?? facet.scope_goal_id ?? "unknown"}`;
  }
  if (facet.scope_kind === "commitment") {
    return `commitment:${facet.scope_commitment_title ?? facet.scope_commitment_id ?? "unknown"}`;
  }
  return "global";
}
const facetBody = facets.length
  ? facets
      .map((facet) => {
        const evidence = evidenceForFacet(db, facet.id);
        const events = db
          .prepare<
            [number],
            {
              event_type: string;
              detail_json: string | null;
              source_message_id: number | null;
              source_kind: string;
              created_at: string;
            }
          >(
            `SELECT event_type, detail_json, source_message_id, source_kind, created_at
             FROM facet_event WHERE facet_id = ? ORDER BY id`,
          )
          .all(facet.id)
          .map(
            (event) =>
              `  - ${event.created_at}: ${event.event_type} (${event.source_kind}${event.source_message_id ? `, message ${event.source_message_id}` : ""})${event.detail_json ? ` — ${event.detail_json}` : ""}`,
          )
          .join("\n");
        const quotes = evidence.length
          ? evidence
              .map(
                (entry) =>
                  `  - passage ${entry.passage_id} / message ${entry.source_message_id} [${entry.start_offset}, ${entry.end_offset}): “${entry.quote}”`,
              )
              .join("\n")
          : "  - _No surviving evidence._";
        return `## Facet ${facet.id} — ${facet.kind}\n\n- status: ${facet.valid_to ? `closed ${facet.valid_to}` : "current"}\n- statement: ${facet.statement}\n- scope: ${facetScope(facet)}\n- condition: ${facet.condition_text ?? "none"}\n- importance: ${facet.importance}\n- sensitivity: ${facet.sensitivity}\n- confidence: ${facet.confidence}\n- machine effect: ${facet.machine_effect ?? "none"}\n- valid: ${facet.valid_from} → ${facet.valid_to ?? "current"}\n- source: message ${facet.source_message_id}\n- superseded by: ${facet.superseded_by ?? "none"}\n\nEvidence:\n${quotes}\n\nHistory:\n${events || "  - _No events._"}`;
      })
      .join("\n\n")
  : "_No understanding facets._";
writeFileSync(
  join(outDir, "understanding.md"),
  `# Understanding\n\nThese are accepted, evidence-backed facets. Closed versions remain history.\n\n${facetBody}\n`,
  "utf8",
);

const backfillJobs = db
  .prepare<[], Record<string, unknown>>(
    `SELECT id, status, conversation_count, message_count, processed_count,
            last_message_id, error_message, created_at, updated_at, completed_at
     FROM understanding_backfill_job ORDER BY id`,
  )
  .all();
const backfillItems = db
  .prepare<[], Record<string, unknown>>(
    `SELECT job_id, message_id, extractor_version, status, candidate_count,
            error_message, updated_at
     FROM understanding_backfill_item ORDER BY job_id, message_id`,
  )
  .all();
writeFileSync(
  join(outDir, "historical-backfill.md"),
  `# Historical backfill\n\nBackfill is opt-in and preview-only until candidates are accepted.\n\n## Jobs\n\n${backfillJobs.length ? `\`\`\`json\n${JSON.stringify(backfillJobs, null, 2)}\n\`\`\`` : "_No jobs._"}\n\n## Items\n\n${backfillItems.length ? `\`\`\`json\n${JSON.stringify(backfillItems, null, 2)}\n\`\`\`` : "_No items._"}\n`,
  "utf8",
);

const recallAudit = db
  .prepare<[], Record<string, unknown>>(
    `SELECT id, tool_name, query_text, item_kind, item_id, rank,
            snapshot_json, created_at
     FROM mcp_recall_audit ORDER BY id`,
  )
  .all();
writeFileSync(
  join(outDir, "mcp-recall-audit.md"),
  `# MCP recall audit\n\nEach row is an immutable snapshot of memory returned by an MCP recall tool.\n\n${recallAudit.length ? `\`\`\`json\n${JSON.stringify(recallAudit, null, 2)}\n\`\`\`` : "_No MCP recall traces._"}\n`,
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
    `Claim-sized evidence and recall status are in [evidence-passages.md](evidence-passages.md).`,
    `Accepted understanding facets and their history are in [understanding.md](understanding.md).`,
    `Historical-backfill controls are in [historical-backfill.md](historical-backfill.md).`,
    `MCP recall snapshots are in [mcp-recall-audit.md](mcp-recall-audit.md).`,
    ``,
  ].join("\n"),
  "utf8",
);

db.close();
console.log(
  `zeus: exported ${entities.length} entities and ${counts.live + counts.superseded} facts to ${outDir}/`,
);

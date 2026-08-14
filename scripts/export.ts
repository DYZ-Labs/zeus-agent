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
import { listConnectors } from "../src/core/connectors";
import { defaultDbPath, openDb } from "../src/core/db";
import { effectEvents } from "../src/core/effects";
import { prepareExportWorkspace } from "../src/core/export-files";
import { aliasesOf, listEntities } from "../src/core/entities";
import { evidenceForFacet, listFacets } from "../src/core/facets";
import { countFacts, evidenceForFact, factsForEntity } from "../src/core/facts";
import {
  commitmentEvents,
  goalEvents,
  listCommitments,
  listGoals,
} from "../src/core/intentions";
import { listProjects, projectEvents } from "../src/core/projects";
import { listBehavioralPolicySuggestions } from "../src/core/personalization";
import type {
  FactView,
  ProposedEffect,
  RecommendationCycle,
  WorkAuthorization,
} from "../src/core/schema";
import { getAmbientSetting, getCoarseLocation } from "../src/core/ambient";
import {
  followThroughMetrics,
  getStewardshipSetting,
  listFollowThroughEvents,
  listOpportunityDeliveries,
} from "../src/core/stewardship";
import {
  listToolReceipts,
  listWorkArtifacts,
  getWorkPlanGenerationProvenance,
  listWorkPlans,
  listWorkRuns,
  workSteps,
} from "../src/core/work-plans";

process.umask(0o077);
const requestedOutDir = process.argv[2] ?? "zeus-export";
const dbPath = defaultDbPath();
const workspace = prepareExportWorkspace(requestedOutDir, { sourceDbPath: dbPath });
process.once("exit", () => workspace.cleanup());
const outDir = workspace.path;
const db = openDb(dbPath);

mkdirSync(join(outDir, "entities"), { recursive: true, mode: 0o700 });

const EXPORT_SENSITIVE_KEY =
  /(^|_)(api_?key|authorization|cookie|credential|password|secret|token)($|_)/iu;

function parseStoredJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Latest migrations enforce valid JSON. Preserve an explicit marker if a legacy or
    // externally modified store violates that boundary instead of crashing export.
    return "[INVALID STORED JSON]";
  }
}

function sanitizeReceiptValue(value: unknown, depth = 0, key = ""): unknown {
  if (EXPORT_SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value
      .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, "[REDACTED]")
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/giu, "$1[REDACTED]");
  }
  if (depth >= 7) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeReceiptValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([entryKey, entryValue]) => [
          entryKey,
          sanitizeReceiptValue(entryValue, depth + 1, entryKey),
        ]),
    );
  }
  return null;
}

function codeBlock(content: string, language = ""): string {
  const longestFence = Math.max(
    0,
    ...(content.match(/`+/gu) ?? []).map((match) => match.length),
  );
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

function jsonBlock(value: unknown): string {
  return codeBlock(JSON.stringify(value, null, 2), "json");
}

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
const projects = listProjects(db, { includeClosed: true, limit: 100_000 });
const projectNames = new Map(projects.map((project) => [project.id, project.entity_name]));
const goalBody = goals.length
  ? goals
      .map((goal) => {
        const events = goalEvents(db, goal.id)
          .map((event) => `  - ${event.created_at}: ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.passage_id ? ` (passage ${event.passage_id})` : ""}${event.detail_json ? ` — ${event.detail_json}` : ""}`)
          .join("\n");
        const project = goal.project_id
          ? ` · project: ${projectNames.get(goal.project_id) ?? `project ${goal.project_id}`}`
          : "";
        return `- **[${goal.status}] ${goal.title}** — ${goal.priority} priority${goal.target_at ? `, target ${goal.target_at}` : ""}${project}  \n  _source: message ${goal.source_message_id}_\n${events}`;
      })
      .join("\n")
  : "_No goals._";
const commitmentBody = commitments.length
  ? commitments
      .map((item) => {
        const events = commitmentEvents(db, item.id)
          .map((event) => `  - ${event.created_at}: ${event.event_type}${event.to_status ? ` → ${event.to_status}` : ""}${event.passage_id ? ` (passage ${event.passage_id})` : ""}${event.detail_json ? ` — ${event.detail_json}` : ""}`)
          .join("\n");
        const project = item.project_id
          ? ` · project: ${projectNames.get(item.project_id) ?? `project ${item.project_id}`}`
          : "";
        return `- **[${item.status}] ${item.title}** — owner ${item.owner_name}${item.due_at ? `, due ${item.due_at}` : ""}${project}  \n  _source: message ${item.source_message_id}_\n${events}`;
      })
      .join("\n")
  : "_No commitments._";
writeFileSync(
  join(outDir, "open-loops.md"),
  `# Open loops\n\n## Goals\n\n${goalBody}\n\n## Commitments\n\n${commitmentBody}\n`,
  "utf8",
);

const projectBody = projects.length
  ? projects
      .map((project) => {
        const events = projectEvents(db, project.id)
          .map(
            (event) =>
              `  - ${event.created_at}: ${event.event_type}${event.from_status || event.to_status ? ` (${event.from_status ?? "none"} → ${event.to_status ?? "none"})` : ""}${event.passage_id ? ` · passage ${event.passage_id}` : ""}${event.source_message_id ? ` · message ${event.source_message_id}` : ` · ${event.source_kind}`}${event.detail_json ? ` — ${event.detail_json}` : ""}`,
          )
          .join("\n");
        const progress = [
          project.progress_percent === null
            ? null
            : `${Math.round(project.progress_percent * 100)}%`,
          project.progress_summary,
        ]
          .filter((value): value is string => value !== null)
          .join(" · ");
        const linkedGoals = goals
          .filter((goal) => goal.project_id === project.id)
          .map((goal) => `goal ${goal.id} (${goal.title})`);
        const linkedCommitments = commitments
          .filter((commitment) => commitment.project_id === project.id)
          .map((commitment) => `commitment ${commitment.id} (${commitment.title})`);
        const links = [...linkedGoals, ...linkedCommitments];
        return [
          `## [${project.status}] ${project.entity_name}`,
          "",
          `- project id: ${project.id} · entity: ${project.entity_slug}`,
          `- progress: ${progress || "not recorded"}`,
          `- blocked: ${project.blocked_at ?? "no"}`,
          `- confidence: ${project.confidence}`,
          `- source: message ${project.source_message_id}`,
          `- valid lifecycle: ${project.created_at} → ${project.closed_at ?? "current"}`,
          `- linked open loops: ${links.length ? links.join(", ") : "none"}`,
          "",
          "History:",
          events || "  - _No events._",
        ].join("\n");
      })
      .join("\n\n")
  : "_No projects._";
writeFileSync(
  join(outDir, "projects.md"),
  `# Projects\n\nProjects are source-backed lifecycle records keyed to durable project entities.\n\n${projectBody}\n`,
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

const recommendationCycles = db.prepare<[], RecommendationCycle>(
  `SELECT id, policy_version, trigger, context_json, query_text,
          candidate_scores_json, applied_facet_ids_json, exclusions_json,
          selected_commitment_id, recommendation_json, source_message_id, created_at
   FROM recommendation_cycle ORDER BY id`,
).all();
const ambientSetting = getAmbientSetting(db);
const coarseLocation = getCoarseLocation(db);
writeFileSync(
  join(outDir, "stewardship-cycles.md"),
  [
    "# Stewardship recommendation cycles",
    "",
    "Each cycle preserves the deterministic policy version, trigger, evaluation context, candidate scores, applied facets, exclusions, selected proposal, and successful channel deliveries.",
    "",
    recommendationCycles.length
      ? recommendationCycles.map((cycle) => [
          `## Opportunity ${cycle.id}`,
          "",
          "```json",
          JSON.stringify({ ...cycle, deliveries: listOpportunityDeliveries(db, cycle.id) }, null, 2),
          "```",
        ].join("\n")).join("\n\n")
      : "_No recommendation cycles._",
    "",
    "## Ambient setting and current coarse signal",
    "",
    "No raw coordinates are accepted or stored by Zeus.",
    "",
    "```json",
    JSON.stringify({ setting: ambientSetting, coarse_location: coarseLocation }, null, 2),
    "```",
    "",
  ].join("\n"),
  "utf8",
);

const behavioralPolicySuggestions = listBehavioralPolicySuggestions(db, { limit: 100_000 });
const behavioralPolicyBody = behavioralPolicySuggestions.length
  ? behavioralPolicySuggestions
      .map((suggestion) => {
        const history = suggestion.events
          .map(
            (event) =>
              `  - ${event.created_at}: ${event.event_type} (${event.source_kind}${event.source_message_id === null ? "" : `, message ${event.source_message_id}`})${event.detail_json === null ? "" : ` — ${event.detail_json}`}`,
          )
          .join("\n");
        return [
          `## Suggestion ${suggestion.id} — ${suggestion.kind}`,
          "",
          `- status: ${suggestion.status}`,
          `- pattern: ${suggestion.pattern_key}`,
          `- feedback type: ${suggestion.event_type} · action: ${suggestion.action_kind}`,
          `- summary: ${suggestion.summary}`,
          `- allowed interruption change: ${suggestion.allowed_interruption_change}`,
          `- explicit feedback evidence: ${suggestion.evidence_event_ids.map((id) => `follow-through event ${id}`).join(", ")}`,
          `- minimum evidence count: ${suggestion.minimum_evidence_count}`,
          `- created: ${suggestion.created_at}`,
          "",
          "Review history:",
          history || "  - _No review events._",
        ].join("\n");
      })
      .join("\n\n")
  : "_No behavioral-policy suggestions._";
writeFileSync(
  join(outDir, "behavioral-policy-suggestions.md"),
  [
    "# Behavioral-policy suggestions",
    "",
    "These are non-canonical review proposals derived only from explicit feedback events.",
    "Accepting one for review does not create a fact, facet, routine, machine effect, or new interruption.",
    "",
    behavioralPolicyBody,
    "",
  ].join("\n"),
  "utf8",
);

const workPlans = listWorkPlans(db, { includeClosed: true, limit: 100_000 });
const workPlanBody = workPlans.length
  ? workPlans
      .map((plan) => {
        const steps = workSteps(db, plan.id);
        const stepById = new Map(steps.map((step) => [step.id, step]));
        const authorizations = db
          .prepare<[number], WorkAuthorization>(
            `SELECT id, work_plan_id, plan_hash, authorization_kind,
                    allowed_effects_json, max_model_tool_calls,
                    max_retries_per_step, max_duration_seconds, expires_at,
                    source_message_id, created_at, revoked_at
             FROM work_authorization
             WHERE work_plan_id = ? ORDER BY id`,
          )
          .all(plan.id);
        const runs = listWorkRuns(db, plan.id).reverse();
        const allArtifacts = listWorkArtifacts(db, { planId: plan.id });
        const generation = getWorkPlanGenerationProvenance(db, plan.id);

        const stepBody = steps.length
          ? steps
              .map((step) =>
                [
                  `### Step ${step.position} — ${step.title}`,
                  "",
                  `- step id: ${step.id}`,
                  `- status: ${step.status} · effect: ${step.effect_kind}`,
                  `- depends on positions: ${step.depends_on.length ? step.depends_on.join(", ") : "none"}`,
                  `- attempts: ${step.attempt_count}`,
                  `- timing: ${step.started_at ?? "not started"} → ${step.completed_at ?? "not completed"}`,
                  `- error: ${step.error_code ?? "none"}${step.error_message ? ` — ${step.error_message}` : ""}`,
                  "",
                  "Instruction:",
                  "",
                  codeBlock(step.instruction, "text"),
                ].join("\n"),
              )
              .join("\n\n")
          : "_No steps._";

        const authorizationBody = authorizations.length
          ? authorizations
              .map((authorization) =>
                [
                  `### Authorization ${authorization.id} — ${authorization.authorization_kind}`,
                  "",
                  `- exact plan hash: ${authorization.plan_hash}`,
                  "- allowed effects:",
                  jsonBlock(parseStoredJson(authorization.allowed_effects_json)),
                  `- limits: ${authorization.max_model_tool_calls} model/tool calls · ${authorization.max_retries_per_step} retries/step · ${authorization.max_duration_seconds}s`,
                  `- source: message ${authorization.source_message_id}`,
                  `- valid: ${authorization.created_at} → ${authorization.expires_at}`,
                  `- revoked: ${authorization.revoked_at ?? "no"}`,
                ].join("\n"),
              )
              .join("\n\n")
          : "_No authorizations._";

        const runBody = runs.length
          ? runs
              .map((run) => {
                const checkpoint = run.checkpoint_step_id === null
                  ? "none"
                  : stepById.has(run.checkpoint_step_id)
                    ? `step ${stepById.get(run.checkpoint_step_id)!.position} (id ${run.checkpoint_step_id})`
                    : `deleted step id ${run.checkpoint_step_id}`;
                const artifacts = allArtifacts.filter((artifact) => artifact.work_run_id === run.id);
                const artifactBody = artifacts.length
                  ? artifacts
                      .map((artifact) =>
                        [
                          `##### Artifact ${artifact.id} — ${artifact.title}`,
                          "",
                          `- kind: ${artifact.kind}`,
                          `- step id: ${artifact.work_step_id ?? "none"}`,
                          `- created: ${artifact.created_at} · updated: ${artifact.updated_at}`,
                          "- citations:",
                          jsonBlock(parseStoredJson(artifact.citations_json)),
                          "",
                          "Content:",
                          "",
                          codeBlock(artifact.content, "text"),
                        ].join("\n"),
                      )
                      .join("\n\n")
                  : "_No artifacts._";
                const receipts = listToolReceipts(db, run.id);
                const receiptBody = receipts.length
                  ? receipts
                      .map((receipt) => {
                        const sanitizedError = receipt.error_message === null
                          ? null
                          : String(sanitizeReceiptValue(receipt.error_message));
                        return [
                          `##### Tool receipt ${receipt.id} — call ${receipt.call_index}`,
                          "",
                          `- tool: ${receipt.tool_name} · effect: ${receipt.effect_kind}`,
                          `- step id: ${receipt.work_step_id ?? "none"}`,
                          `- status: ${receipt.status}`,
                          `- idempotency key: ${receipt.idempotency_key}`,
                          `- timing: ${receipt.started_at} → ${receipt.completed_at ?? "not completed"}`,
                          `- error: ${receipt.error_code ?? "none"}${sanitizedError ? ` — ${sanitizedError}` : ""}`,
                          "- sanitized input:",
                          jsonBlock(sanitizeReceiptValue(parseStoredJson(receipt.input_json))),
                          "- sanitized output:",
                          jsonBlock(sanitizeReceiptValue(parseStoredJson(receipt.output_json))),
                          "- sanitized citations:",
                          jsonBlock(sanitizeReceiptValue(parseStoredJson(receipt.citations_json))),
                        ].join("\n");
                      })
                      .join("\n\n")
                  : "_No tool receipts._";
                return [
                  `### Run ${run.id} — ${run.status}`,
                  "",
                  `- authorization: ${run.authorization_id}`,
                  `- exact plan hash: ${run.plan_hash}`,
                  `- calls: ${run.model_call_count} model · ${run.tool_call_count} tool`,
                  `- checkpoint: ${checkpoint}`,
                  `- timing: ${run.started_at} → ${run.completed_at ?? "not completed"} (deadline ${run.deadline_at})`,
                  `- updated: ${run.updated_at}`,
                  `- error/pause: ${run.error_code ?? "none"}${run.error_message ? ` — ${String(sanitizeReceiptValue(run.error_message))}` : ""}`,
                  "",
                  "#### Artifacts",
                  "",
                  artifactBody,
                  "",
                  "#### Sanitized tool receipts",
                  "",
                  receiptBody,
                ].join("\n");
              })
              .join("\n\n")
          : "_No runs._";

        return [
          `## Work plan ${plan.id} — ${plan.objective}`,
          "",
          `- status: ${plan.status} · origin: ${plan.origin}`,
          `- exact plan hash: ${plan.plan_hash}`,
          `- hash version: ${plan.hash_version}`,
          `- source: message ${plan.source_message_id}`,
          `- source links: goal ${plan.source_goal_id ?? "none"} · commitment ${plan.source_commitment_id ?? "none"} · project ${plan.source_project_id ?? "none"}`,
          `- limits: ${plan.max_steps} steps · ${plan.max_model_tool_calls} model/tool calls · ${plan.max_retries_per_step} retries/step · ${plan.max_duration_seconds}s`,
          "- allowed effects:",
          jsonBlock(parseStoredJson(plan.allowed_effects_json)),
          "- completion criteria:",
          jsonBlock(parseStoredJson(plan.completion_criteria_json)),
          "- generation-time evaluation context:",
          jsonBlock(generation?.evaluationContext ?? null),
          "- accepted personalization conflicts supplied to planning:",
          jsonBlock(generation?.conflicts ?? []),
          "- personalization item dependencies and immutable snapshots:",
          jsonBlock(generation?.memorySources.map((source) => ({
            source_kind: source.sourceKind,
            source_id: source.sourceId,
            included_in_prompt: source.includedInPrompt,
            exclusion_reason: source.exclusionReason,
            source_message_ids: source.sourceMessageIds,
            snapshot: source.snapshot,
          })) ?? []),
          `- lifecycle: ${plan.created_at} → ${plan.completed_at ?? "open"} · updated ${plan.updated_at}`,
          "",
          "### Steps and dependencies",
          "",
          stepBody,
          "",
          "### Append-only authorization history",
          "",
          authorizationBody,
          "",
          "### Runs and checkpoints",
          "",
          runBody,
        ].join("\n");
      })
      .join("\n\n---\n\n")
  : "_No work plans._";
writeFileSync(
  join(outDir, "work-plans.md"),
  [
    "# Bounded work plans",
    "",
    "This is the complete local audit for bounded planning, research, drafting, and any",
    "external request a run prepared. Tool inputs, outputs, citations, and errors are",
    "sanitized again during export. A receipt named `connector_call` is the only kind that",
    "means something left this machine; `effect_proposal` means a request was prepared and",
    "stopped.",
    "",
    workPlanBody,
    "",
  ].join("\n"),
  "utf8",
);

/**
 * Connections and external requests.
 *
 * Exported deliberately: if Zeus can act, the record of what it was allowed to do and what
 * it actually did has to leave with everything else. Connectors hold no credential, so
 * there is nothing here to redact beyond the standard pass.
 */
const connectors = listConnectors(db);
const connectionsBody = connectors.length
  ? connectors
      .map((connector) => [
        `## ${connector.label} (connector ${connector.id})`,
        "",
        `- transport: ${connector.transport}`,
        `- reached by: ${connector.transport === "stdio" ? [connector.command, ...connector.args].join(" ") : connector.url}`,
        `- environment variable names read at call time: ${connector.envVarNames.join(", ") || "none"}`,
        "- values for those variables are never stored by Zeus and are not in this export",
        `- status: ${connector.status}${connector.enabled === 1 ? " · enabled" : " · not enabled"}`,
        `- last verified: ${connector.last_verified_at ?? "never"}`,
        `- allowed by: message ${connector.source_message_id}`,
        "",
        "### Capabilities granted",
        "",
        connector.capabilities.length
          ? connector.capabilities
              .map((capability) =>
                [
                  `- **${capability.slot}** → \`${capability.remote_tool_name}\``,
                  `  - effect: ${capability.effect_kind}`,
                  `  - state: ${capability.enabled === 1 ? "allowed" : "paused"}`,
                  `  - reviewed input schema: ${capability.schema_hash}`,
                  `  - granted by: message ${capability.source_message_id}`,
                ].join("\n"),
              )
              .join("\n")
          : "_None granted._",
      ].join("\n"))
      .join("\n\n---\n\n")
  : "_No connected services._";

const exportedEffects = db
  .prepare<[], ProposedEffect>(
    `SELECT id, work_run_id, work_step_id, connector_capability_id, effect_kind,
            payload_json, payload_hash, preview_text, reversal_json, status,
            idempotency_key, provider_request_key, expires_at, created_at, updated_at
     FROM proposed_effect ORDER BY id`,
  )
  .all();
const effectsBody = exportedEffects.length
  ? exportedEffects
      .map((effect) => {
        const events = effectEvents(db, effect.id);
        return [
          `## Request ${effect.id} — ${effect.preview_text}`,
          "",
          `- status: ${effect.status}`,
          `- effect: ${effect.effect_kind} · capability ${effect.connector_capability_id}`,
          `- from work run ${effect.work_run_id}, step ${effect.work_step_id}`,
          `- confirmation hash: ${effect.payload_hash}`,
          `- expires: ${effect.expires_at}`,
          "- exact request:",
          jsonBlock(parseStoredJson(effect.payload_json)),
          "",
          "### Append-only decision history",
          "",
          events.length
            ? events
                .map(
                  (event) =>
                    `- ${event.created_at} · **${event.event_type}**` +
                    `${event.source_message_id === null ? "" : ` · your message ${event.source_message_id}`}` +
                    `${event.detail_json === null ? "" : ` · ${event.detail_json}`}`,
                )
                .join("\n")
            : "_No events._",
        ].join("\n");
      })
      .join("\n\n---\n\n")
  : "_No external requests were ever prepared._";

writeFileSync(
  join(outDir, "connections.md"),
  [
    "# Connections and external requests",
    "",
    "Zeus reaches other services only through servers you configured, and only through",
    "capability slots you granted. It stores the names of the environment variables a",
    "server needs, never their values, so no credential appears in this export.",
    "",
    "Every external request is listed with the exact payload and the message in which you",
    "confirmed it. A request with no `executed` event never happened.",
    "",
    connectionsBody,
    "",
    "---",
    "",
    "# External requests",
    "",
    effectsBody,
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
        return `## Facet ${facet.id} — ${facet.kind}\n\n- status: ${facet.valid_to ? `closed ${facet.valid_to}` : "current"}\n- statement: ${facet.statement}\n- scope: ${facetScope(facet)}\n- human condition: ${facet.condition_text ?? "none"}\n- structured condition: ${facet.condition_json ?? "none"}\n- importance: ${facet.importance}\n- sensitivity: ${facet.sensitivity}\n- confidence: ${facet.confidence}\n- machine effect: ${facet.machine_effect ?? "none"}\n- valid: ${facet.valid_from} → ${facet.valid_to ?? "current"}\n- source: message ${facet.source_message_id}\n- superseded by: ${facet.superseded_by ?? "none"}\n\nEvidence:\n${quotes}\n\nHistory:\n${events || "  - _No events._"}`;
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

const mutationAudit = db
  .prepare<[], Record<string, unknown>>(
    `SELECT id, operation_id, tool_name, request_hash, target_kind, target_id,
            event_type, source_message_id, approval_expires_at, created_at
     FROM mcp_mutation_event ORDER BY id`,
  )
  .all();
writeFileSync(
  join(outDir, "mcp-mutation-audit.md"),
  [
    "# MCP mutation audit",
    "",
    "This payload-free lifecycle binds each proposed mutation to a canonical request digest.",
    "Approved and applied events cite the stored user approval message; deleting that source erases those linked events.",
    "",
    mutationAudit.length
      ? codeBlock(JSON.stringify(mutationAudit, null, 2), "json")
      : "_No MCP mutation events._",
    "",
  ].join("\n"),
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
    `Project lifecycles, progress, links, and event histories are in [projects.md](projects.md).`,
    `Follow-through proposals and user control decisions are in [follow-through.md](follow-through.md).`,
    `Recommendation-cycle policy traces, delivery receipts, ambient settings, and the current short-lived coarse-zone signal are in [stewardship-cycles.md](stewardship-cycles.md).`,
    `Non-canonical behavioral-policy review proposals are in [behavioral-policy-suggestions.md](behavioral-policy-suggestions.md).`,
    `Bounded plans, dependencies, authorization history, runs, artifacts, citations, and sanitized tool receipts are in [work-plans.md](work-plans.md).`,
    `Connected services, the capabilities you granted them, and every external request with the message that confirmed it are in [connections.md](connections.md).`,
    `Memory proposals and their review status are in [memory-candidates.md](memory-candidates.md).`,
    `Claim-sized evidence and recall status are in [evidence-passages.md](evidence-passages.md).`,
    `Accepted understanding facets and their history are in [understanding.md](understanding.md).`,
    `Historical-backfill controls are in [historical-backfill.md](historical-backfill.md).`,
    `MCP recall snapshots are in [mcp-recall-audit.md](mcp-recall-audit.md).`,
    `Payload-free MCP mutation approval lifecycles are in [mcp-mutation-audit.md](mcp-mutation-audit.md).`,
    ``,
  ].join("\n"),
  "utf8",
);

db.close();
workspace.finish();
console.log(
  `zeus: exported ${entities.length} entities and ${counts.live + counts.superseded} facts to ${workspace.destination}/`,
);

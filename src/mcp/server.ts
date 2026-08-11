#!/usr/bin/env -S npx tsx
/**
 * Zeus over MCP.
 *
 * This is the higher-leverage of Zeus's two front doors: it lets any Claude Code or
 * Claude Desktop session read and write the same memory the web app uses, so knowledge
 * deposited while working shows up in chat and vice versa.
 *
 * stdio transport, so it is launched per-session by the client. Every response is plain
 * text carrying provenance — the calling model gets dates and confidence, not bare
 * assertions it might restate as certainties.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getCandidate, listCandidates, recordCandidateResolution, resolveCandidate } from "../core/candidates";
import { remember } from "../core/chat";
import { appendMessage, createConversation, listConversations } from "../core/conversations";
import type { Db } from "../core/db";
import { defaultDbPath, openDb } from "../core/db";
import { embed, embedFacet, embedFact, embedPassage } from "../core/embed";
import { listEntities, resolveEntity, selfEntity } from "../core/entities";
import { searchEpisodes } from "../core/episodes";
import { acceptCandidate } from "../core/extract";
import {
  FACET_KINDS,
  evidenceForFacet,
  facetSearchText,
  listFacets,
  searchFacets,
} from "../core/facets";
import {
  countFacts,
  evidenceForFact,
  factSearchText,
  factsForEntity,
  timeline,
} from "../core/facts";
import {
  listCommitments,
  listGoals,
  updateCommitment,
  updateGoal,
} from "../core/intentions";
import type { CommitmentStatus, FactView, GoalStatus } from "../core/schema";
import { recordMcpRecallAudit } from "../core/mcp-audit";
import { search } from "../core/search";
import {
  markRecommendationSurfaced,
  recordFollowThroughDecision,
  recommendNextAction,
} from "../core/stewardship";

const db: Db = openDb();

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** One fact as a line the calling model can weigh: value, date, confidence, source. */
function line(fact: FactView, withSubject = true): string {
  const subject = fact.subject_slug === "self" ? "You" : fact.subject_name;
  const head = withSubject ? `${subject} ${fact.predicate}` : fact.predicate;
  const closed = fact.valid_to ? ` [NO LONGER TRUE as of ${fact.valid_to.slice(0, 10)}]` : "";
  const confidence = fact.confidence >= 0.9 ? "" : ` conf=${fact.confidence.toFixed(2)}`;
  const effective =
    fact.valid_from.slice(0, 10) === fact.created_at.slice(0, 10)
      ? ""
      : `; effective ${fact.valid_from.slice(0, 10)}`;
  const source = fact.source_message_id ? `; source=message:${fact.source_message_id}` : "; source=legacy-unattributed";
  return `- fact:${fact.id} ${head}: ${fact.object} (learned ${fact.created_at.slice(0, 10)}${effective}${confidence}${source})${closed}`;
}

function scopeLine(facet: ReturnType<typeof listFacets>[number]): string {
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

function facetLine(facet: ReturnType<typeof listFacets>[number]): string {
  const evidence = evidenceForFacet(db, facet.id);
  const sourceIds = evidence.map(
    (entry) => `passage:${entry.passage_id}/message:${entry.source_message_id}`,
  );
  return [
    `- facet:${facet.id} [${facet.kind}; scope=${scopeLine(facet)}; confidence=${facet.confidence.toFixed(2)}] ${facet.statement}`,
    facet.condition_text ? `  condition: ${facet.condition_text}` : null,
    facet.machine_effect ? `  user-confirmed machine effect: ${facet.machine_effect}` : null,
    `  source: message:${facet.source_message_id}; evidence: ${sourceIds.join(", ")}`,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

function facetSnapshot(facet: ReturnType<typeof listFacets>[number]) {
  return { facet, evidence: evidenceForFacet(db, facet.id) };
}

const server = new McpServer({ name: "zeus", version: "0.1.0" });

function mcpConversation() {
  return (
    listConversations(db, 100).find((entry) => entry.source === "mcp") ??
    createConversation(db, { title: "From MCP", source: "mcp" })
  );
}

server.registerTool(
  "zeus_recall",
  {
    title: "Recall from Zeus's memory",
    description:
      "Search the user's personal memory for facts about them, the people they know, their projects, and the topics they follow. Call this whenever answering would be improved by knowing something durable about the user — their role, location, preferences, colleagues, ongoing work — rather than guessing or asking. Returns facts with the date each was learned and a confidence score; an empty result means Zeus genuinely does not know, so say so instead of inferring.",
    inputSchema: {
      query: z.string().describe("What you want to know, in natural language."),
      limit: z.number().int().min(1).max(50).optional().describe("Max facts to return (default 15)."),
      include_superseded: z
        .boolean()
        .optional()
        .describe("Include facts that were true once but are not now. Use for questions about the past."),
    },
  },
  async ({ query, limit, include_superseded }) => {
    const resultLimit = limit ?? 15;
    let queryVector: Float32Array | null = null;
    try {
      queryVector = await embed(query);
    } catch {
      // FTS and graph retrieval remain available when local embeddings fail.
    }
    const [facts, episodes, facets] = await Promise.all([
      search(db, query, {
        limit: resultLimit,
        includeSuperseded: include_superseded ?? false,
        queryVector,
      }),
      searchEpisodes(db, query, { limit: resultLimit, queryVector }),
      searchFacets(db, query, { limit: resultLimit, queryVector }),
    ]);
    const recalled = [
      ...facts.map((hit) => ({
        kind: "fact" as const,
        id: hit.fact.id,
        score: hit.score,
        body: line(hit.fact),
        snapshot: { fact: hit.fact, evidence: evidenceForFact(db, hit.fact.id), via: hit.via },
      })),
      ...facets.map((hit) => ({
        kind: "facet" as const,
        id: hit.facet.id,
        score: hit.score,
        body: facetLine(hit.facet),
        snapshot: { ...facetSnapshot(hit.facet), via: hit.via },
      })),
      ...episodes.map((hit) => ({
        kind: "episode" as const,
        id: hit.passage_id ?? hit.message.id,
        score: hit.score,
        body: `- episode:passage:${hit.passage_id} / message:${hit.message.id} (${hit.message.created_at.slice(0, 10)}): ${hit.excerpt}`,
        // Never persist or return the surrounding message: only the allowed span.
        snapshot: {
          passage_id: hit.passage_id,
          source_message_id: hit.message.id,
          excerpt: hit.excerpt,
          created_at: hit.message.created_at,
          via: hit.via,
        },
      })),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, resultLimit);

    if (recalled.length === 0) {
      return text(
        `Zeus has nothing relevant to "${query}". Treat this as "the user has not told me", not as evidence either way.`,
      );
    }
    recordMcpRecallAudit(
      db,
      "zeus_recall",
      query,
      recalled.map((item) => ({ kind: item.kind, id: item.id, snapshot: item.snapshot })),
    );
    return text(
      `${recalled.length} relevant item(s) recalled for "${query}":\n${recalled.map((item) => item.body).join("\n")}\n\nFacts and accepted facets are canonical. Episodes are exact dated user passages and may no longer be current. No recommendations or unrelated profile facts were added.`,
    );
  },
);

server.registerTool(
  "zeus_understanding",
  {
    title: "Read accepted user-understanding facets",
    description:
      "Read only current accepted values, criteria, constraints, preferences, motivations, routines, boundaries, styles, capacities, skills, or relationship dynamics. Scope the request whenever possible. Pending, rejected, and superseded facets are always excluded.",
    inputSchema: {
      query: z.string().optional().describe("What aspect of the user's understanding you need."),
      kinds: z.array(z.enum(FACET_KINDS)).optional(),
      scope_kind: z
        .enum(["global", "domain", "entity", "goal", "commitment"])
        .optional(),
      scope_ref: z
        .string()
        .optional()
        .describe("Domain label, entity name/id, goal id, or commitment id for the selected scope."),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, kinds, scope_kind, scope_ref, limit }) => {
    const resultLimit = limit ?? 20;
    let facets = query?.trim()
      ? (await searchFacets(db, query, { kinds, limit: resultLimit * 3 })).map(
          (hit) => hit.facet,
        )
      : listFacets(db, {
          includeClosed: false,
          kinds,
          limit: resultLimit * 3,
        });

    if (scope_kind) {
      if (scope_kind === "global") {
        facets = facets.filter((facet) => facet.scope_kind === "global");
      } else if (scope_kind === "domain") {
        if (!scope_ref?.trim()) return text("A domain scope requires scope_ref; nothing recalled.");
        const wanted = scope_ref.trim().toLowerCase();
        facets = facets.filter(
          (facet) =>
            facet.scope_kind === "domain" && facet.scope_label?.toLowerCase() === wanted,
        );
      } else if (scope_kind === "entity") {
        if (!scope_ref?.trim()) return text("An entity scope requires scope_ref; nothing recalled.");
        const numericId = Number(scope_ref);
        const entity = Number.isInteger(numericId)
          ? listEntities(db, { limit: 10_000 }).find((entry) => entry.id === numericId) ?? null
          : resolveEntity(db, scope_ref);
        if (!entity) return text(`No unambiguous entity matches "${scope_ref}"; nothing recalled.`);
        facets = facets.filter(
          (facet) => facet.scope_kind === "entity" && facet.scope_entity_id === entity.id,
        );
      } else {
        const numericId = Number(scope_ref);
        if (!Number.isInteger(numericId) || numericId <= 0) {
          return text(`${scope_kind} scope_ref must be a positive id; nothing recalled.`);
        }
        facets = facets.filter((facet) =>
          scope_kind === "goal"
            ? facet.scope_kind === "goal" && facet.scope_goal_id === numericId
            : facet.scope_kind === "commitment" &&
              facet.scope_commitment_id === numericId,
        );
      }
    }
    facets = facets
      .filter((facet) => facet.valid_to === null)
      .slice(0, resultLimit);
    if (facets.length === 0) {
      return text("Zeus has no accepted understanding facets matching that scope and query.");
    }

    const auditQuery = JSON.stringify({ query: query ?? null, kinds, scope_kind, scope_ref });
    recordMcpRecallAudit(
      db,
      "zeus_understanding",
      auditQuery,
      facets.map((facet) => ({ kind: "facet", id: facet.id, snapshot: facetSnapshot(facet) })),
    );
    return text(
      `Accepted understanding (${facets.length}):\n${facets.map(facetLine).join("\n")}\n\nThese are accepted, evidence-backed facets only.`,
    );
  },
);

server.registerTool(
  "zeus_memory_candidates",
  {
    title: "List memory proposals awaiting explicit review",
    description:
      "Inspect pending memory and understanding proposals. This is an explicit review surface: candidates are not canonical and must not be used as facts before acceptance.",
    inputSchema: {
      kind: z.enum(["fact", "goal", "commitment", "interest", "facet"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ kind, limit }) => {
    const candidates = listCandidates(db, { kind, limit: limit ?? 30 });
    if (candidates.length === 0) return text("No pending candidates match that filter.");
    const snapshots = candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      payload: candidate.payload,
      reasons: candidate.reasons,
      confidence: candidate.confidence,
      source_message_id: candidate.source_message_id,
      origin: candidate.origin,
      backfill_job_id: candidate.backfill_job_id,
      evidence: candidate.evidence,
    }));
    recordMcpRecallAudit(
      db,
      "zeus_memory_candidates",
      kind ?? "all pending",
      snapshots.map((snapshot) => ({
        kind: "candidate",
        id: snapshot.id,
        snapshot,
      })),
    );
    return text(
      `Pending proposals (not canonical):\n\n${snapshots
        .map(
          (candidate) =>
            `candidate:${candidate.id} [${candidate.kind}; reasons=${candidate.reasons.join(",")}; confidence=${candidate.confidence.toFixed(2)}]\nsource: message:${candidate.source_message_id}${candidate.evidence.length ? `; evidence=${candidate.evidence.map((entry) => `passage:${entry.id}/message:${entry.message_id}`).join(",")}` : ""}\npayload: ${JSON.stringify(candidate.payload)}`,
        )
        .join("\n\n")}`,
    );
  },
);

server.registerTool(
  "zeus_review_candidate",
  {
    title: "Accept or reject one memory proposal",
    description:
      "Resolve one pending candidate only after the user explicitly asks. Acceptance materializes the proposal with its original exact evidence; rejection preserves an audit record and never enters memory.",
    inputSchema: {
      candidate_id: z.number().int().positive(),
      decision: z.enum(["accept", "reject"]),
      facet_statement: z
        .string()
        .optional()
        .describe("Optional edited wording when accepting a facet candidate."),
      facet_machine_effect: z
        .enum(["boost", "deprioritize", "block"])
        .nullable()
        .optional()
        .describe("Optional user-confirmed deterministic effect for an accepted facet."),
      user_instruction: z.string().min(1).describe("The user's explicit review instruction."),
    },
  },
  async ({
    candidate_id,
    decision,
    facet_statement,
    facet_machine_effect,
    user_instruction,
  }) => {
    const candidate = getCandidate(db, candidate_id);
    if (!candidate || candidate.status !== "pending") {
      return text(`Candidate ${candidate_id} is missing or no longer pending; nothing changed.`);
    }
    if (
      (facet_statement !== undefined || facet_machine_effect !== undefined) &&
      (candidate.kind !== "facet" || decision !== "accept")
    ) {
      return text(
        "Editable wording and machine effects apply only when accepting a facet candidate; nothing changed.",
      );
    }
    const candidateSnapshot = {
      id: candidate.id,
      kind: candidate.kind,
      payload: candidate.payload,
      reasons: candidate.reasons,
      source_message_id: candidate.source_message_id,
      evidence: candidate.evidence,
    };
    recordMcpRecallAudit(db, "zeus_review_candidate", `candidate:${candidate_id}`, [
      { kind: "candidate", id: candidate.id, snapshot: candidateSnapshot },
    ]);
    const conversation = mcpConversation();
    const actionSource = appendMessage(db, conversation.id, "user", user_instruction, {
      origin: "user_action",
      recallState: "blocked",
    });

    if (decision === "reject") {
      if (!resolveCandidate(db, candidate.id, "rejected")) {
        return text(`Candidate ${candidate_id} changed during review; nothing changed.`);
      }
      recordCandidateResolution(db, {
        candidateId: candidate.id,
        decision: "rejected",
        sourceMessageId: actionSource.id,
        sourceKind: "user_action",
      });
      return text(
        `Rejected candidate:${candidate.id}. Proposal source remains message:${candidate.source_message_id}; review action source is message:${actionSource.id}. It will not enter canonical context.`,
      );
    }

    try {
      const candidateEnvelope = candidate.payload && typeof candidate.payload === "object"
        ? (candidate.payload as Record<string, unknown>)
        : {};
      const candidateItem = candidateEnvelope.item && typeof candidateEnvelope.item === "object"
        ? (candidateEnvelope.item as Record<string, unknown>)
        : candidateEnvelope;
      const applied = acceptCandidate(
        db,
        candidate.id,
        candidate.kind === "facet" &&
          (facet_statement !== undefined || facet_machine_effect !== undefined)
          ? {
              facetEdit: {
                statement: facet_statement ?? String(candidateItem.statement ?? ""),
                machineEffect:
                  facet_machine_effect === undefined
                    ? ((candidateItem.machine_effect as "boost" | "deprioritize" | "block" | null) ?? null)
                    : facet_machine_effect,
              },
            }
          : {},
      );
      if (!applied) return text(`Candidate ${candidate_id} changed during review; nothing changed.`);
      db.prepare<[number, number]>(
        `UPDATE candidate_resolution_event SET source_message_id = ?
         WHERE id = (
           SELECT id FROM candidate_resolution_event
           WHERE candidate_id = ?
             AND decision IN ('accepted','edited_accepted')
             AND source_message_id IS NULL
           ORDER BY id DESC LIMIT 1
         )`,
      ).run(actionSource.id, candidate.id);
      const acceptedIds = [
        ...applied.facts.map((item) => `fact:${item.id}`),
        ...applied.goals.map((item) => `goal:${item.id}`),
        ...applied.commitments.map((item) => `commitment:${item.id}`),
        ...applied.facets.map((item) => `facet:${item.id}`),
      ];
      await Promise.all([
        ...applied.facts.map((item) =>
          embedFact(
            db,
            item.id,
            factSearchText(item.subject_name, item.predicate, item.object),
          ).catch(() => false),
        ),
        ...applied.facets.map((item) =>
          embedFacet(
            db,
            item.id,
            facetSearchText(item.kind, item.statement, item.condition_text),
          ).catch(() => false),
        ),
        ...candidate.evidence.map((passage) =>
          embedPassage(db, passage.id, passage.text).catch(() => false),
        ),
      ]);
      return text(
        `Accepted candidate:${candidate.id} as ${acceptedIds.join(", ")}. Proposal source: message:${candidate.source_message_id}; evidence: ${candidate.evidence.map((entry) => `passage:${entry.id}/message:${entry.message_id}`).join(", ")}; review action source: message:${actionSource.id}.`,
      );
    } catch (error) {
      return text(
        `Candidate ${candidate_id} could not be materialized; it remains pending. ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
);

server.registerTool(
  "zeus_remember",
  {
    title: "Teach Zeus something durable",
    description:
      "Record something about the user that will still matter months from now — a role change, a preference, a person they work with, a project they started, a topic they care about. Zeus extracts the durable facts itself, so write a plain sentence rather than structured data. Do not use this for passing state or for things about the current task; a memory full of noise buries the facts that matter.",
    inputSchema: {
      text: z.string().describe("A plain sentence stating what is true, e.g. 'Dan moved to Berlin in March'."),
    },
  },
  async ({ text: statement }) => {
    const conversation = mcpConversation();

    const applied = await remember(db, statement, conversation.id);

    if (!applied) {
      return text("Extraction failed — nothing was recorded. Zeus's memory is unchanged.");
    }
    const accepted =
      applied.facts.length +
      applied.goals.length +
      applied.commitments.length +
      applied.facets.length;
    if (accepted === 0 && applied.candidates.length === 0) {
      return text(
        "Nothing durable enough to record. Zeus keeps facts that will still be true in six months, not passing state.",
      );
    }

    const superseded = applied.supersededIds.length
      ? `\n${applied.supersededIds.length} earlier fact(s) closed as no longer true.`
      : "";
    const pending = applied.candidates.length
      ? `\n${applied.candidates.length} proposed item(s) held for user review.`
      : "";
    const intentions = [
      applied.goals.length ? `${applied.goals.length} goal update(s)` : null,
      applied.commitments.length ? `${applied.commitments.length} commitment update(s)` : null,
      applied.facets.length ? `${applied.facets.length} understanding facet(s)` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");

    return text(
      `Accepted ${accepted} item(s)${intentions ? ` (${intentions})` : ""}.` +
        `${applied.facts.length ? `\n${applied.facts.map((fact) => line(fact)).join("\n")}` : ""}` +
        `${applied.facets.length ? `\n${applied.facets.map(facetLine).join("\n")}` : ""}` +
        `${applied.goals.length ? `\n${applied.goals.map((goal) => `- goal:${goal.id} ${goal.title} (source=message:${goal.source_message_id})`).join("\n")}` : ""}` +
        `${applied.commitments.length ? `\n${applied.commitments.map((item) => `- commitment:${item.id} ${item.title} (source=message:${item.source_message_id})`).join("\n")}` : ""}` +
        `${superseded}${pending}`,
    );
  },
);

server.registerTool(
  "zeus_open_loops",
  {
    title: "List the user's goals and commitments",
    description:
      "Read accepted goals and commitments, including owners, dates, and status. Use this for planning, follow-through, and questions about what remains open.",
    inputSchema: {
      include_closed: z.boolean().optional().describe("Include achieved, abandoned, done, and cancelled items."),
    },
  },
  async ({ include_closed }) => {
    const goals = listGoals(db, { includeClosed: include_closed ?? false, limit: 200 });
    const commitments = listCommitments(db, {
      includeClosed: include_closed ?? false,
      limit: 300,
    });
    if (goals.length + commitments.length === 0) return text("Zeus has no matching open loops.");
    const goalLines = goals.map(
      (goal) =>
        `- goal:${goal.id} [${goal.status}; ${goal.priority} priority] ${goal.title}${goal.target_at ? ` (target ${goal.target_at.slice(0, 10)})` : ""}; source=message:${goal.source_message_id}`,
    );
    const commitmentLines = commitments.map(
      (item) =>
        `- commitment:${item.id} [${item.status}] ${item.title} — owner ${item.owner_name}${item.due_at ? `, due ${item.due_at.slice(0, 10)}` : ""}; source=message:${item.source_message_id}`,
    );
    recordMcpRecallAudit(
      db,
      "zeus_open_loops",
      include_closed ? "include closed" : "open only",
      [
        ...goals.map((goal) => ({ kind: "goal" as const, id: goal.id, snapshot: goal })),
        ...commitments.map((commitment) => ({
          kind: "commitment" as const,
          id: commitment.id,
          snapshot: commitment,
        })),
      ],
    );
    return text(
      [
        goalLines.length ? `Goals:\n${goalLines.join("\n")}` : null,
        commitmentLines.length ? `Commitments:\n${commitmentLines.join("\n")}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join("\n\n"),
    );
  },
);

server.registerTool(
  "zeus_next_action",
  {
    title: "Recommend the user's best current next action",
    description:
      "Select at most one accepted commitment using explicit goal priority, timing, relevance, waiting/staleness, conflicts, snoozes, dismissals, and intervention mode. Use when the user asks what to focus on or when a concrete next step would help. The result is a proposal, never a fact or authorization for external action.",
    inputSchema: {
      context: z
        .string()
        .optional()
        .describe("What the user is doing or discussing now, if known."),
    },
  },
  async ({ context }) => {
    const recommendation = recommendNextAction(db, context ?? "", { force: true });
    if (!recommendation) {
      return text(
        "Zeus found no accepted, unsnoozed commitment worth recommending. Staying quiet is the correct result.",
      );
    }
    recordMcpRecallAudit(db, "zeus_next_action", context ?? "", [
      {
        kind: "commitment",
        id: recommendation.commitment_id,
        snapshot: { recommendation },
      },
    ]);
    markRecommendationSurfaced(db, recommendation, null);
    return text(
      [
        `Recommended commitment:${recommendation.commitment_id} — ${recommendation.commitment_title} (source=message:${recommendation.commitment_source_message_id})`,
        `Why now: ${recommendation.why}`,
        `Next action: ${recommendation.suggested_action}`,
        recommendation.requires_confirmation
          ? "Control boundary: prepare only; sending, scheduling, purchasing, reminding, or coordinating externally requires explicit user confirmation."
          : "Control boundary: this can be prepared locally; any later external action still requires explicit user confirmation.",
      ].join("\n"),
    );
  },
);

server.registerTool(
  "zeus_follow_through_feedback",
  {
    title: "Record the user's decision on a Zeus recommendation",
    description:
      "Record acceptance, dismissal, snooze, completion, or regret only after the user explicitly says so. The instruction is stored as a real user source. Completion changes the linked commitment to done; snooze suppresses it for seven days.",
    inputSchema: {
      commitment_id: z.number().int().positive(),
      decision: z.enum(["accepted", "dismissed", "snoozed", "completed", "regretted"]),
      user_instruction: z.string().min(1).describe("The user's explicit instruction authorizing this decision."),
      reason: z
        .string()
        .max(1000)
        .optional()
        .describe("Optional verbatim user-authored reason. Never infer one from a click or silence."),
    },
  },
  async ({ commitment_id, decision, user_instruction, reason }) => {
    const conversation = mcpConversation();
    const source = appendMessage(db, conversation.id, "user", user_instruction, {
      origin: "user_action",
      recallState: "blocked",
    });
    const event = recordFollowThroughDecision(db, {
      commitmentId: commitment_id,
      decision,
      sourceMessageId: source.id,
      userReason: reason ?? null,
    });
    return text(
      event
        ? `Recorded ${decision} for commitment ${commitment_id} (action source=message:${source.id}). No external action was performed.`
        : `Commitment ${commitment_id} does not exist or is no longer actionable; nothing changed.`,
    );
  },
);

server.registerTool(
  "zeus_update_open_loop",
  {
    title: "Update a goal or commitment after explicit user instruction",
    description:
      "Change the status of an existing goal or commitment only when the user explicitly asks. The supplied instruction is stored as provenance; never call speculatively.",
    inputSchema: {
      kind: z.enum(["goal", "commitment"]),
      id: z.number().int().positive(),
      status: z.enum(["active", "paused", "achieved", "abandoned", "open", "waiting", "done", "cancelled"]),
      user_instruction: z.string().min(1).describe("The user's explicit instruction authorizing this update."),
    },
  },
  async ({ kind, id, status, user_instruction }) => {
    if (kind === "goal" && !["active", "paused", "achieved", "abandoned"].includes(status)) {
      return text(`Invalid goal status "${status}"; nothing changed.`);
    }
    if (kind === "commitment" && !["open", "waiting", "done", "cancelled"].includes(status)) {
      return text(`Invalid commitment status "${status}"; nothing changed.`);
    }
    const conversation = mcpConversation();
    const source = appendMessage(db, conversation.id, "user", user_instruction, {
      origin: "user_action",
      recallState: "blocked",
    });
    if (kind === "goal") {
      const updated = updateGoal(db, id, {
        status: status as GoalStatus,
        sourceMessageId: source.id,
        sourceKind: "user_action",
      });
      return text(
        updated
          ? `Goal ${id} is now ${updated.status} (action source=message:${source.id}).`
          : `Goal ${id} does not exist.`,
      );
    }
    const updated = updateCommitment(db, id, {
      status: status as CommitmentStatus,
      sourceMessageId: source.id,
      sourceKind: "user_action",
    });
    return text(
      updated
        ? `Commitment ${id} is now ${updated.status} (action source=message:${source.id}).`
        : `Commitment ${id} does not exist.`,
    );
  },
);

server.registerTool(
  "zeus_entity",
  {
    title: "Everything Zeus knows about one person, project, or topic",
    description:
      "Fetch the full dossier for a named entity — a colleague, a company, a project, a topic the user follows — including facts that are no longer true and facts where the entity is mentioned by others. Use this when the question is about one specific named thing; use zeus_recall for open questions.",
    inputSchema: {
      name: z.string().describe("The entity's name or any alias, e.g. 'Sarah' or 'Acme'."),
    },
  },
  async ({ name }) => {
    const entity = name.trim().toLowerCase() === "me" ? selfEntity(db) : resolveEntity(db, name);

    if (!entity) {
      return text(`Zeus does not know anyone or anything called "${name}".`);
    }

    const facts = factsForEntity(db, entity.id, {
      includeSuperseded: true,
      includeIncoming: true,
      limit: 200,
    });

    const own = facts.filter((fact) => fact.subject_id === entity.id);
    const mentions = facts.filter((fact) => fact.subject_id !== entity.id);
    const live = own.filter((fact) => fact.valid_to === null);
    const past = own.filter((fact) => fact.valid_to !== null);

    const sections = [
      `${entity.name} (${entity.kind})`,
      live.length ? `\nCurrently true:\n${live.map((f) => line(f, false)).join("\n")}` : "\nNothing currently known.",
      past.length ? `\nNo longer true:\n${past.map((f) => line(f, false)).join("\n")}` : "",
      mentions.length ? `\nMentioned by others:\n${mentions.map((f) => line(f)).join("\n")}` : "",
    ];

    recordMcpRecallAudit(
      db,
      "zeus_entity",
      name,
      facts.map((fact) => ({
        kind: "fact",
        id: fact.id,
        snapshot: { fact, evidence: evidenceForFact(db, fact.id) },
      })),
    );

    return text(sections.filter(Boolean).join("\n"));
  },
);

server.registerTool(
  "zeus_timeline",
  {
    title: "What Zeus learned, and when",
    description:
      "List facts in the order Zeus recorded them. Use this for questions about change over time — what the user has been working on lately, what has recently shifted — rather than for looking up a specific fact.",
    inputSchema: {
      since: z.string().optional().describe("ISO date lower bound, e.g. '2026-01-01'."),
      until: z.string().optional().describe("ISO date upper bound."),
      limit: z.number().int().min(1).max(200).optional().describe("Max facts (default 40)."),
    },
  },
  async ({ since, until, limit }) => {
    const entries = timeline(db, { since, until, limit: limit ?? 40 });
    if (entries.length === 0) return text("Zeus has recorded nothing in that range.");

    const byDay = new Map<string, FactView[]>();
    for (const fact of entries) {
      const day = fact.created_at.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), fact]);
    }

    const body = [...byDay.entries()]
      .map(([day, facts]) => `${day}\n${facts.map((fact) => line(fact)).join("\n")}`)
      .join("\n\n");

    recordMcpRecallAudit(
      db,
      "zeus_timeline",
      JSON.stringify({ since, until, limit: limit ?? 40 }),
      entries.map((fact) => ({
        kind: "fact",
        id: fact.id,
        snapshot: { fact, evidence: evidenceForFact(db, fact.id) },
      })),
    );

    const counts = countFacts(db);
    return text(`${counts.live} live facts, ${counts.superseded} superseded.\n\n${body}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the protocol channel — anything written there corrupts the stream.
console.error(`[zeus] MCP server ready on ${defaultDbPath()}`);

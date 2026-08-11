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

import { remember } from "../core/chat";
import { buildContext } from "../core/context";
import { appendMessage, createConversation, listConversations } from "../core/conversations";
import type { Db } from "../core/db";
import { defaultDbPath, openDb } from "../core/db";
import { embedMessage } from "../core/embed";
import { listEntities, resolveEntity, selfEntity } from "../core/entities";
import { countFacts, factsForEntity, timeline } from "../core/facts";
import {
  listCommitments,
  listGoals,
  updateCommitment,
  updateGoal,
} from "../core/intentions";
import type { CommitmentStatus, FactView, GoalStatus } from "../core/schema";
import { search } from "../core/search";

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
  return `- ${head}: ${fact.object} (learned ${fact.created_at.slice(0, 10)}${effective}${confidence})${closed}`;
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
    if (!include_superseded) {
      const context = await buildContext(db, query, { limit: limit ?? 15, episodeLimit: 4 });
      if (context.items.length === 0) {
        return text(
          `Zeus has nothing relevant to "${query}". Treat this as unknown, not as evidence either way.`,
        );
      }
      return text(
        `Accepted memory for "${query}":\n\n${context.text}\n\nEpisodes are dated user statements, not guaranteed current facts.`,
      );
    }

    const hits = await search(db, query, {
      limit: limit ?? 15,
      includeSuperseded: include_superseded ?? false,
    });

    if (hits.length === 0) {
      return text(
        `Zeus has nothing relevant to "${query}". Treat this as "the user has not told me", not as evidence either way.`,
      );
    }

    return text(
      `${hits.length} fact(s) recalled for "${query}":\n${hits.map((hit) => line(hit.fact)).join("\n")}`,
    );
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
    const accepted = applied.facts.length + applied.goals.length + applied.commitments.length;
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
    ]
      .filter((part): part is string => part !== null)
      .join(", ");

    return text(
      `Accepted ${accepted} item(s)${intentions ? ` (${intentions})` : ""}.` +
        `${applied.facts.length ? `\n${applied.facts.map((fact) => line(fact)).join("\n")}` : ""}` +
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
        `- goal:${goal.id} [${goal.status}] ${goal.title}${goal.target_at ? ` (target ${goal.target_at.slice(0, 10)})` : ""}`,
    );
    const commitmentLines = commitments.map(
      (item) =>
        `- commitment:${item.id} [${item.status}] ${item.title} — owner ${item.owner_name}${item.due_at ? `, due ${item.due_at.slice(0, 10)}` : ""}`,
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
    const source = appendMessage(db, conversation.id, "user", user_instruction);
    await embedMessage(db, source.id, source.content).catch(() => false);
    if (kind === "goal") {
      const updated = updateGoal(db, id, {
        status: status as GoalStatus,
        sourceMessageId: source.id,
        sourceKind: "message",
      });
      return text(updated ? `Goal ${id} is now ${updated.status}.` : `Goal ${id} does not exist.`);
    }
    const updated = updateCommitment(db, id, {
      status: status as CommitmentStatus,
      sourceMessageId: source.id,
      sourceKind: "message",
    });
    return text(
      updated
        ? `Commitment ${id} is now ${updated.status}.`
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
      // "You" is the self entity's display name; suggesting it as something to look up
      // is confusing — use "me" for that, which resolves above.
      const known = listEntities(db, { limit: 40 })
        .filter((candidate) => candidate.slug !== "self")
        .map((candidate) => candidate.name)
        .join(", ");
      return text(
        `Zeus does not know anyone or anything called "${name}".${known ? ` It does know: ${known}.` : ""}`,
      );
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

    const counts = countFacts(db);
    return text(`${counts.live} live facts, ${counts.superseded} superseded.\n\n${body}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// stdout is the protocol channel — anything written there corrupts the stream.
console.error(`[zeus] MCP server ready on ${defaultDbPath()}`);

export type ExportValue = null | boolean | number | string | ExportValue[] | {
  [key: string]: ExportValue;
};

export type ExportSnapshot = {
  format: "zeus-data-export";
  version: 1;
  generatedAt: string;
  tables: Record<string, Array<Record<string, ExportValue>>>;
};

export type ExportEntry = {
  path: string;
  content: string;
};

/** Pure renderer shared by local CLI and hosted download adapters. */
export function generateExportEntries(snapshot: ExportSnapshot): ExportEntry[] {
  const conversations = snapshot.tables.conversation ?? [];
  const messages = snapshot.tables.message ?? [];
  const hidden = new Set(
    (snapshot.tables.conversation_history_state ?? []).map((row) => Number(row.conversation_id)),
  );
  const entities = new Map(
    (snapshot.tables.entity ?? []).map((row) => [Number(row.id), row]),
  );
  const facts = snapshot.tables.fact ?? [];
  const facets = snapshot.tables.understanding_facet ?? [];
  const candidates = snapshot.tables.memory_candidate ?? [];
  const goals = snapshot.tables.goal ?? [];
  const commitments = snapshot.tables.commitment ?? [];
  const projects = snapshot.tables.project ?? [];

  const transcript = conversations.map((conversation) => {
    const id = Number(conversation.id);
    const title = text(conversation.title) || "Untitled chat";
    const date = text(conversation.started_at).slice(0, 10);
    const header = `## ${escapeMarkdown(title)} — ${date}${hidden.has(id) ? " · archived" : ""}`;
    const body = messages
      .filter((message) => Number(message.conversation_id) === id)
      .sort(byNumericId)
      .map((message) => {
        const speaker = message.role === "assistant" ? "Zeus" : "You";
        const recall = Number(message.cross_chat_recall_eligible) === 0
          ? " · excluded from cross-chat recall"
          : "";
        return `**${speaker}** · ${text(message.created_at)}${recall}\n\n${quote(text(message.content))}`;
      })
      .join("\n\n");
    return `${header}\n\n${body || "_No messages._"}`;
  }).join("\n\n---\n\n");

  const currentFacts = facts.filter((fact) => fact.valid_to === null);
  const historicalFacts = facts.filter((fact) => fact.valid_to !== null);
  const renderFact = (fact: Record<string, ExportValue>) => {
    const subject = entities.get(Number(fact.subject_id));
    const subjectName = text(subject?.slug) === "self" ? "You" : text(subject?.name) || "Unknown";
    return `- **${escapeMarkdown(subjectName)}** ${plainPredicate(text(fact.predicate))}: ${escapeMarkdown(text(fact.object))}  \n  _Supported by a saved chat · effective ${text(fact.valid_from).slice(0, 10)}${fact.valid_to === null ? "" : ` · ended ${text(fact.valid_to).slice(0, 10)}`}_`;
  };
  const renderFacet = (facet: Record<string, ExportValue>) =>
    `- ${escapeMarkdown(text(facet.statement))}  \n  _Supported by a saved chat · effective ${text(facet.valid_from).slice(0, 10)}${facet.valid_to === null ? "" : ` · ended ${text(facet.valid_to).slice(0, 10)}`}_`;

  const planLines = [
    ...projects.map((project) => `- **Project · ${humanStatus(text(project.status))}** — ${escapeMarkdown(text(entities.get(Number(project.entity_id))?.name) || "Untitled project")}`),
    ...goals.map((goal) => `- **Goal · ${humanStatus(text(goal.status))}** — ${escapeMarkdown(text(goal.title))}${goal.target_at ? ` · by ${text(goal.target_at).slice(0, 10)}` : ""}`),
    ...commitments.map((item) => `- **Commitment · ${humanStatus(text(item.status))}** — ${escapeMarkdown(text(item.title))}${item.due_at ? ` · by ${text(item.due_at).slice(0, 10)}` : ""}`),
  ];

  const reviewLines = candidates
    .filter((candidate) => candidate.status === "pending")
    .map((candidate) => {
      const payload = parseJson(text(candidate.payload_json));
      const item = record(payload?.item ?? payload);
      const statement = text(item.statement) || text(item.title) || [item.subject, item.predicate, item.object].map(text).filter(Boolean).join(" ");
      return `- ${escapeMarkdown(statement || "Proposed detail")}  \n  _Reason: ${plainReason(text(candidate.reason))} · supported by a saved chat_`;
    });

  const readme = [
    "# Your Zeus data",
    "",
    `Exported ${snapshot.generatedAt}. This archive is readable without Zeus and includes the complete structured snapshot in \`data.json\`.`,
    "",
    "- `conversations.md` — every stored chat, including archived chats",
    "- `about-you.md` — current and historical remembered details",
    "- `plans.md` — projects, goals, and commitments",
    "- `review.md` — proposals still waiting for a decision",
    "- `data.json` — the complete structured history behind the readable files",
    "",
    `Counts: ${conversations.length} conversations · ${messages.length} messages · ${facts.length + facets.length} remembered details · ${planLines.length} plans.`,
    "",
  ].join("\n");

  return [
    { path: "README.md", content: readme },
    { path: "conversations.md", content: `# Conversations\n\n${transcript || "_No conversations._"}\n` },
    {
      path: "about-you.md",
      content: [
        "# About you",
        "",
        "## Currently remembered",
        "",
        ...(currentFacts.length ? currentFacts.map(renderFact) : ["_No current details._"]),
        ...(facets.length ? ["", "## Helpful context", "", ...facets.map(renderFacet)] : []),
        ...(historicalFacts.length ? ["", "## History", "", ...historicalFacts.map(renderFact)] : []),
        "",
      ].join("\n"),
    },
    { path: "plans.md", content: `# Your plans\n\n${planLines.join("\n") || "_No plans._"}\n` },
    { path: "review.md", content: `# Needs review\n\n${reviewLines.join("\n") || "_Nothing is waiting for review._"}\n` },
    { path: "data.json", content: `${JSON.stringify(snapshot, null, 2)}\n` },
  ];
}

function text(value: ExportValue | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function record(value: ExportValue | undefined): Record<string, ExportValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function parseJson(value: string): Record<string, ExportValue> | null {
  try {
    return record(JSON.parse(value) as ExportValue);
  } catch {
    return null;
  }
}

function byNumericId(a: Record<string, ExportValue>, b: Record<string, ExportValue>): number {
  return Number(a.id) - Number(b.id);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/([\\`*_{}[\]()#+.!|-])/gu, "\\$1");
}

function quote(value: string): string {
  return (value || "_").split("\n").map((line) => `> ${line.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`).join("\n");
}

function plainPredicate(value: string): string {
  const phrases: Record<string, string> = {
    cares_about: "cares about",
    job_title: "works as",
    likes: "likes",
    lives_in: "lives in",
    prefers: "prefers",
    works_at: "works at",
    works_on: "works on",
  };
  return phrases[value] ?? value.replace(/_/gu, " ");
}

function plainReason(value: string): string {
  const reasons: Record<string, string> = {
    ambiguous: "The wording could mean more than one thing",
    backfill_preview: "This came from an earlier conversation",
    conflict: "This may conflict with something already saved",
    inference: "Zeus is not certain the source says this directly",
    sensitive: "This may be sensitive",
  };
  return reasons[value] ?? "Zeus needs your confirmation";
}

function humanStatus(value: string): string {
  const statuses: Record<string, string> = {
    abandoned: "Stopped",
    achieved: "Done",
    active: "Active",
    cancelled: "Stopped",
    completed: "Done",
    done: "Done",
    open: "In progress",
    paused: "Paused",
    planned: "Planned",
    waiting: "Waiting on someone",
  };
  return statuses[value] ?? value.replace(/_/gu, " ");
}

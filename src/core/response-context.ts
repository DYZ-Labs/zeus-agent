import { getConversation, getMessage } from "./conversations";
import type { FieldProvenanceSource, IntentFieldProvenance } from "./context";
import type { Db } from "./db";
import { evidenceForFacet, getFacet } from "./facets";
import { evidenceForFact, getFact } from "./facts";
import { getCommitment, getGoal } from "./intentions";
import { getPassage, passagesForMessage } from "./passages";
import { getProject } from "./projects";
import type { ContextSelection, RecallItem } from "./schema";
import { RecallItem as RecallItemSchema } from "./schema";

export type ResponseContextSelection = ContextSelection & {
  rank: number;
  fieldProvenance: IntentFieldProvenance | null;
};

type ResponseContextRow = {
  item_kind: RecallItem["kind"];
  item_id: number;
  rank: number;
  selection_reason: ContextSelection["reason"] | null;
  selection_score: number | null;
  retrieval_json: string | null;
  snapshot_json: string | null;
};

export function responseSelectionsForResponse(
  db: Db,
  assistantMessageId: number,
): ResponseContextSelection[] {
  const hasSelectionMetadata = db
    .prepare<[], { found: number }>(
      `SELECT 1 AS found FROM pragma_table_info('response_context')
       WHERE name = 'selection_reason'`,
    )
    .get();
  const metadataColumns = hasSelectionMetadata
    ? "selection_reason, selection_score, retrieval_json,"
    : "NULL AS selection_reason, NULL AS selection_score, NULL AS retrieval_json,";
  const rows = db
    .prepare<[number], ResponseContextRow>(
      `SELECT item_kind, item_id, rank, ${metadataColumns} snapshot_json
       FROM response_context
       WHERE assistant_message_id = ?
       ORDER BY rank`,
    )
    .all(assistantMessageId);

  return rows.flatMap((row): ResponseContextSelection[] => {
    const item = itemForRow(db, row);
    if (!item) return [];
    const retrieval = parseRetrieval(row.retrieval_json);
    return [
      {
        rank: row.rank,
        item,
        reason: validReason(row.selection_reason),
        score: row.selection_score ?? 0,
        via: retrieval.via,
        estimated_tokens: retrieval.estimated_tokens,
        fieldProvenance: retrieval.field_provenance,
      },
    ];
  });
}

export function recalledForResponse(db: Db, assistantMessageId: number): RecallItem[] {
  return responseSelectionsForResponse(db, assistantMessageId).map((selection) => selection.item);
}

function itemForRow(db: Db, row: ResponseContextRow): RecallItem | null {
  const snapshot = parseSnapshot(row.snapshot_json);
  if (!snapshot) return reconstructItem(db, row);
  if (snapshot.kind !== "episode") return snapshot;

  // New claim-level snapshots name the immutable passage directly. Old snapshots
  // only named a message and may contain neighbouring text that was never approved
  // for recall. Never return that old message projection: resolve it through the
  // one currently eligible source passage, or fail closed when it is ambiguous.
  if (snapshot.episode.passage_id === null) {
    return legacyEpisodeFromMessage(db, row.item_id);
  }
  return snapshot;
}

function parseSnapshot(snapshot: string | null): RecallItem | null {
  if (!snapshot) return null;
  try {
    const parsed = RecallItemSchema.safeParse(JSON.parse(snapshot) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function reconstructItem(db: Db, row: ResponseContextRow): RecallItem | null {
  if (row.item_kind === "fact") {
    const fact = getFact(db, row.item_id);
    return fact ? { kind: "fact", fact, evidence: evidenceForFact(db, fact.id) } : null;
  }
  if (row.item_kind === "episode") {
    // Migrated rows without selection metadata are known to be message-keyed.
    if (row.selection_reason !== null) {
      const passage = getPassage(db, row.item_id);
      const message = getMessage(db, row.item_id);
      // A missing/corrupt snapshot from the transition period cannot distinguish
      // independent message and passage id sequences. Do not guess on collision.
      if (passage && message) return null;
      if (passage) return recallableEpisodeFromPassage(db, passage);
      if (message) return legacyEpisodeFromMessage(db, message.id);
      return null;
    }
    return legacyEpisodeFromMessage(db, row.item_id);
  }
  if (row.item_kind === "goal") {
    const goal = getGoal(db, row.item_id);
    return goal ? { kind: "goal", goal } : null;
  }
  if (row.item_kind === "commitment") {
    const commitment = getCommitment(db, row.item_id);
    return commitment ? { kind: "commitment", commitment } : null;
  }
  if (row.item_kind === "project") {
    const project = getProject(db, row.item_id);
    return project ? { kind: "project", project } : null;
  }
  const facet = getFacet(db, row.item_id);
  return facet
    ? { kind: "facet", facet, evidence: evidenceForFacet(db, facet.id) }
    : null;
}

function legacyEpisodeFromMessage(db: Db, messageId: number): RecallItem | null {
  const message = getMessage(db, messageId);
  if (!message || message.role !== "user" || !isEpisodeOrigin(message.origin)) return null;
  const conversation = getConversation(db, message.conversation_id);
  if (!conversation || conversation.title === "Memory curation") return null;
  const passages = passagesForMessage(db, message.id).filter(
    (passage) => passage.recall_status === "allowed" && !passageBlockedByCandidate(db, passage.id),
  );
  if (passages.length !== 1) return null;
  return episodeFromPassage(db, passages[0]!);
}

function recallableEpisodeFromPassage(
  db: Db,
  passage: NonNullable<ReturnType<typeof getPassage>>,
): RecallItem | null {
  if (passage.recall_status !== "allowed" || passageBlockedByCandidate(db, passage.id)) {
    return null;
  }
  const message = getMessage(db, passage.message_id);
  if (!message || message.role !== "user" || !isEpisodeOrigin(message.origin)) return null;
  const conversation = getConversation(db, message.conversation_id);
  if (!conversation || conversation.title === "Memory curation") return null;
  return episodeFromPassage(db, passage);
}

function passageBlockedByCandidate(db: Db, passageId: number): boolean {
  return Boolean(
    db
      .prepare<[number], { found: number }>(
        `SELECT 1 AS found
         FROM candidate_evidence ce
         JOIN memory_candidate mc ON mc.id = ce.candidate_id
         WHERE ce.passage_id = ? AND mc.status IN ('pending','rejected')
         LIMIT 1`,
      )
      .get(passageId),
  );
}

function isEpisodeOrigin(origin: string): boolean {
  return origin === "conversation" || origin === "reflection" || origin === "backfill";
}

function episodeFromPassage(
  db: Db,
  passage: NonNullable<ReturnType<typeof getPassage>>,
): RecallItem | null {
  const message = getMessage(db, passage.message_id);
  if (!message || message.role !== "user") return null;
  const conversation = getConversation(db, message.conversation_id);
  return {
    kind: "episode",
    episode: {
      passage_id: passage.id,
      start_offset: passage.start_offset,
      end_offset: passage.end_offset,
      // Reconstruction follows the same least-disclosure projection as live
      // episode retrieval; source navigation can resolve the id explicitly.
      message: { ...message, content: passage.text },
      conversation_title: conversation?.title ?? null,
      excerpt: passage.text,
      score: 0,
      via: [],
    },
  };
}

function parseRetrieval(value: string | null): {
  via: ContextSelection["via"];
  estimated_tokens: number;
  field_provenance: IntentFieldProvenance | null;
} {
  if (!value) return { via: [], estimated_tokens: 0, field_provenance: null };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return { via: validVia(parsed), estimated_tokens: 0, field_provenance: null };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { via: [], estimated_tokens: 0, field_provenance: null };
    }
    const record = parsed as Record<string, unknown>;
    return {
      via: validVia(record.via),
      estimated_tokens:
        typeof record.estimated_tokens === "number" &&
        Number.isInteger(record.estimated_tokens) &&
        record.estimated_tokens >= 0
          ? record.estimated_tokens
          : 0,
      field_provenance: parseFieldProvenance(record.field_provenance),
    };
  } catch {
    return { via: [], estimated_tokens: 0, field_provenance: null };
  }
}

function parseFieldProvenance(value: unknown): IntentFieldProvenance | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "goal" && record.kind !== "commitment" && record.kind !== "project") {
    return null;
  }
  if (typeof record.fields !== "object" || record.fields === null) return null;
  const fields = record.fields as Record<string, unknown>;
  const required = record.kind === "goal"
    ? ["title", "status", "priority", "target_at", "project_id", "confidence"]
    : record.kind === "commitment"
      ? [
        "title",
        "owner_entity_id",
        "linked_goal_id",
        "project_id",
        "status",
        "due_at",
        "snoozed_until",
        "confidence",
      ]
      : ["entity_id", "status", "progress_summary", "progress_percent", "blocked_at", "confidence"];
  if (required.some((name) => !validFieldSource(fields[name]))) return null;
  return value as IntentFieldProvenance;
}

function validFieldSource(value: unknown): value is FieldProvenanceSource {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.event_id === null || Number.isInteger(record.event_id)) &&
    (record.source_message_id === null || Number.isInteger(record.source_message_id)) &&
    (record.passage_id === undefined ||
      record.passage_id === null ||
      Number.isInteger(record.passage_id)) &&
    (record.source_kind === "message" ||
      record.source_kind === "user_action" ||
      record.source_kind === "system") &&
    typeof record.recorded_at === "string"
  );
}

function validVia(value: unknown): ContextSelection["via"] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<ContextSelection["via"][number]>([
    "lexical",
    "semantic",
    "graph",
    "core",
    "policy",
  ]);
  return value.filter(
    (entry): entry is ContextSelection["via"][number] =>
      typeof entry === "string" && allowed.has(entry as ContextSelection["via"][number]),
  );
}

function validReason(value: string | null): ContextSelection["reason"] {
  const allowed = new Set<ContextSelection["reason"]>([
    "interaction_contract",
    "query_relevant",
    "historical",
    "open_loop",
    "follow_through",
  ]);
  return value && allowed.has(value as ContextSelection["reason"])
    ? (value as ContextSelection["reason"])
    : "query_relevant";
}

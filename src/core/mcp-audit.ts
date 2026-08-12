import { createHash } from "node:crypto";

import type { Db } from "./db";
import { now } from "./db";
import type { McpMutationEventType } from "./schema";

export type McpRecallKind =
  | "fact"
  | "episode"
  | "goal"
  | "commitment"
  | "facet"
  | "candidate"
  | "project";

export type McpRecallAuditItem = {
  kind: McpRecallKind;
  id: number;
  snapshot: unknown;
};

export type McpMutationAuditEvent = {
  operationId: string;
  toolName: string;
  requestHash: string;
  eventType: McpMutationEventType;
  targetKind?: string | null;
  targetId?: number | null;
  sourceMessageId?: number | null;
  approvalExpiresAt?: string | null;
};

/** Persist exactly what an MCP read returned, independently of any chat response. */
export function recordMcpRecallAudit(
  db: Db,
  toolName: string,
  queryText: string,
  items: readonly McpRecallAuditItem[],
): void {
  if (items.length === 0) return;
  const insert = db.prepare<[string, string, McpRecallKind, number, number, string, string]>(
    `INSERT INTO mcp_recall_audit
       (tool_name, query_text, item_kind, item_id, rank, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const timestamp = now();
  db.transaction(() => {
    items.forEach((item, index) => {
      insert.run(
        toolName,
        queryText,
        item.kind,
        item.id,
        index,
        JSON.stringify(item.snapshot),
        timestamp,
      );
    });
  })();
}

/**
 * Bind an approval to the complete, type-checked MCP request without retaining an
 * unapproved copy of its potentially personal payload. Object keys are sorted so the
 * same request has one digest regardless of JavaScript insertion order.
 */
export function mcpMutationRequestHash(toolName: string, args: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ arguments: args, tool_name: toolName }))
    .digest("hex");
}

/** Append one immutable event in the lifecycle of an MCP mutation request. */
export function recordMcpMutationEvent(db: Db, event: McpMutationAuditEvent): void {
  db.prepare<
    [string, string, string, string | null, number | null, McpMutationEventType, number | null, string | null, string]
  >(
    `INSERT INTO mcp_mutation_event
       (operation_id, tool_name, request_hash, target_kind, target_id, event_type,
        source_message_id, approval_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.operationId,
    event.toolName,
    event.requestHash,
    event.targetKind ?? null,
    event.targetId ?? null,
    event.eventType,
    event.sourceMessageId ?? null,
    event.approvalExpiresAt ?? null,
    now(),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP mutation arguments must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error("MCP mutation arguments must be JSON-compatible");
}

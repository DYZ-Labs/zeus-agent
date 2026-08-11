import type { Db } from "./db";
import { now } from "./db";

export type McpRecallKind =
  | "fact"
  | "episode"
  | "goal"
  | "commitment"
  | "facet"
  | "candidate";

export type McpRecallAuditItem = {
  kind: McpRecallKind;
  id: number;
  snapshot: unknown;
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

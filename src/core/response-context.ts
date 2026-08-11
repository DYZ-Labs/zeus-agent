import { getConversation, getMessage } from "./conversations";
import type { Db } from "./db";
import { evidenceForFact, getFact } from "./facts";
import { getCommitment, getGoal } from "./intentions";
import type { RecallItem } from "./schema";
import { RecallItem as RecallItemSchema } from "./schema";

export function recalledForResponse(db: Db, assistantMessageId: number): RecallItem[] {
  const rows = db
    .prepare<
      [number],
      { item_kind: RecallItem["kind"]; item_id: number; rank: number; snapshot_json: string | null }
    >(
      `SELECT item_kind, item_id, rank, snapshot_json
       FROM response_context
       WHERE assistant_message_id = ?
       ORDER BY rank`,
    )
    .all(assistantMessageId);

  return rows.flatMap((row): RecallItem[] => {
    if (row.snapshot_json) {
      try {
        const parsed = RecallItemSchema.safeParse(JSON.parse(row.snapshot_json) as unknown);
        if (parsed.success) return [parsed.data];
      } catch {
        // Fall through to live reconstruction for a manually damaged snapshot.
      }
    }
    if (row.item_kind === "fact") {
      const fact = getFact(db, row.item_id);
      return fact
        ? [{ kind: "fact", fact, evidence: evidenceForFact(db, fact.id) }]
        : [];
    }
    if (row.item_kind === "episode") {
      const message = getMessage(db, row.item_id);
      if (!message || message.role !== "user") return [];
      const conversation = getConversation(db, message.conversation_id);
      return [
        {
          kind: "episode",
          episode: {
            message,
            conversation_title: conversation?.title ?? null,
            excerpt: message.content,
            score: 0,
            via: [],
          },
        },
      ];
    }
    if (row.item_kind === "goal") {
      const goal = getGoal(db, row.item_id);
      return goal ? [{ kind: "goal", goal }] : [];
    }
    const commitment = getCommitment(db, row.item_id);
    return commitment ? [{ kind: "commitment", commitment }] : [];
  });
}

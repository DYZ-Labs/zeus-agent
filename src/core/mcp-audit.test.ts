import { describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import { openTestDb } from "./db";
import { mcpMutationRequestHash, recordMcpMutationEvent } from "./mcp-audit";

describe("MCP mutation audit", () => {
  it("binds hashes to canonical typed arguments", () => {
    const first = mcpMutationRequestHash("zeus_update_open_loop", {
      id: 7,
      kind: "goal",
      status: "paused",
    });
    const reordered = mcpMutationRequestHash("zeus_update_open_loop", {
      status: "paused",
      kind: "goal",
      id: 7,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered).toBe(first);
    expect(
      mcpMutationRequestHash("zeus_update_open_loop", {
        id: 7,
        kind: "goal",
        status: "abandoned",
      }),
    ).not.toBe(first);
    expect(mcpMutationRequestHash("different_tool", { id: 7 })).not.toBe(
      mcpMutationRequestHash("zeus_update_open_loop", { id: 7 }),
    );
  });

  it("keeps unapproved events payload-free and erases source-linked approval history", () => {
    const db = openTestDb();
    const conversation = createConversation(db, { source: "mcp" });
    const source = appendMessage(db, conversation.id, "user", "I approve pausing goal:7.", {
      origin: "user_action",
      recallState: "blocked",
    });
    const operationId = "operation-1";
    const requestHash = mcpMutationRequestHash("zeus_update_open_loop", {
      id: 7,
      kind: "goal",
      status: "paused",
    });

    recordMcpMutationEvent(db, {
      operationId,
      toolName: "zeus_update_open_loop",
      requestHash,
      eventType: "approval_requested",
      targetKind: "goal",
      targetId: 7,
    });
    recordMcpMutationEvent(db, {
      operationId,
      toolName: "zeus_update_open_loop",
      requestHash,
      eventType: "approved",
      targetKind: "goal",
      targetId: 7,
      sourceMessageId: source.id,
    });
    recordMcpMutationEvent(db, {
      operationId,
      toolName: "zeus_update_open_loop",
      requestHash,
      eventType: "applied",
      targetKind: "goal",
      targetId: 7,
      sourceMessageId: source.id,
    });

    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info(mcp_mutation_event)")
      .all()
      .map((column) => column.name);
    expect(columns).not.toContain("request_json");
    expect(columns).not.toContain("payload_json");
    expect(() =>
      recordMcpMutationEvent(db, {
        operationId: "bad-source",
        toolName: "zeus_update_open_loop",
        requestHash,
        eventType: "approval_requested",
        sourceMessageId: source.id,
      })
    ).toThrow();

    db.prepare("DELETE FROM conversation WHERE id = ?").run(conversation.id);
    expect(
      db
        .prepare<[], { event_type: string }>(
          "SELECT event_type FROM mcp_mutation_event ORDER BY id",
        )
        .all(),
    ).toEqual([{ event_type: "approval_requested" }]);
  });
});

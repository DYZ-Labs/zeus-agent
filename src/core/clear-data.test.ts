import { describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import { openTestDb } from "./db";
import { setLabsEnabled, setRememberingMode } from "./experience";
import { recordFact } from "./facts";
import { clearZeusData } from "./retention";
import { selfEntity } from "./entities";

describe("clearZeusData", () => {
  it("removes all personal and derived state while preserving account ownership", () => {
    const db = openTestDb();
    const conversation = createConversation(db, { title: "Private reset source" });
    const source = appendMessage(db, conversation.id, "user", "I collect hand-made maps.");
    recordFact(db, {
      subjectId: selfEntity(db).id,
      predicate: "collects_private_maps",
      object: "hand-made maps",
      sourceMessageId: source.id,
    });
    setRememberingMode(db, "off");
    setLabsEnabled(db, true);
    db.prepare(
      `INSERT INTO app_owner (id, supabase_user_id, email, bound_at)
       VALUES (1, '00000000-0000-4000-8000-000000000001', 'owner@example.com', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO mcp_mutation_event
       (operation_id, tool_name, request_hash, event_type, created_at)
       VALUES ('pending-reset', 'zeus_update_open_loop', ?, 'approval_requested', ?)`,
    ).run("a".repeat(64), "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO coarse_location (id, zone_id, observed_at, expires_at, created_at)
       VALUES (1, 'private-zone', ?, ?, ?)`,
    ).run(
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

    expect(clearZeusData(db)).toBe(1);

    for (const table of [
      "conversation", "message", "fact", "memory_candidate", "understanding_facet",
      "goal", "commitment", "project", "work_plan", "recommendation_cycle",
      "follow_through_event", "mcp_recall_audit", "mcp_mutation_event", "memory_job",
      "evidence_passage", "extraction_run", "understanding_backfill_job", "coarse_location",
      "embedding", "passage_embedding", "facet_embedding",
    ] as const) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.prepare("SELECT supabase_user_id, email FROM app_owner").get()).toEqual({
      supabase_user_id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.com",
    });
    expect(db.prepare("SELECT slug, name FROM entity").all()).toEqual([
      { slug: "self", name: "You" },
    ]);
    expect(db.prepare("SELECT remembering_mode, onboarding_status, labs_enabled FROM experience_setting").get()).toEqual({
      remembering_mode: "automatic",
      onboarding_status: "welcome",
      labs_enabled: 0,
    });
    expect(db.prepare("SELECT name FROM predicate WHERE name = 'collects_private_maps'").get()).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

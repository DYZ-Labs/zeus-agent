import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  createCandidate,
  recordCandidateResolution,
  resolveCandidate,
} from "./candidates";
import { recordResponseContext } from "./context";
import { appendMessage, createConversation, getConversation } from "./conversations";
import { openTestDb } from "./db";
import { toBlob } from "./embed";
import { getEntity, upsertEntity, upsertEntityWithEvidence } from "./entities";
import { searchEpisodes } from "./episodes";
import {
  closeFacet,
  correctFacet,
  evidenceForFacet,
  forgetFacet,
  getFacet,
  recordFacet,
} from "./facets";
import { recordMcpRecallAudit } from "./mcp-audit";
import { MIGRATIONS } from "./migrations";
import {
  commitmentEvents,
  createCommitment,
  createGoal,
  getCommitment,
  getGoal,
  goalEvents,
  updateCommitment,
  updateGoal,
} from "./intentions";
import { ensureEvidencePassage } from "./passages";
import {
  createProject,
  getProject,
  projectEvents,
  updateProject,
} from "./projects";
import {
  conversationDependencies,
  deleteConversationWithMemory,
} from "./retention";
import { recalledForResponse } from "./response-context";

describe("claim-level retention", () => {
  it("restores an independently sourced facet when its sole close source is erased", () => {
    const db = openTestDb();
    const sourceConversation = createConversation(db);
    const closeConversation = createConversation(db);
    const source = appendMessage(db, sourceConversation.id, "user", "I value careful pacing.");
    const closeSource = appendMessage(
      db,
      closeConversation.id,
      "user",
      "That careful-pacing preference no longer applies.",
    );
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const facet = recordFacet(db, {
      kind: "value",
      statement: "Careful pacing matters",
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });
    closeFacet(db, facet.id, closeSource.id);
    expect(getFacet(db, facet.id)?.valid_to).not.toBeNull();

    deleteConversationWithMemory(db, closeConversation.id);

    expect(getFacet(db, facet.id)?.valid_to).toBeNull();
    expect(
      db.prepare<[number]>("SELECT 1 FROM facet_event WHERE source_message_id = ?")
        .get(closeSource.id),
    ).toBeUndefined();
  });

  it("removes response, MCP, and opportunity traces when a facet is explicitly forgotten", () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "At work, prioritize focus time.");
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const facet = recordFacet(db, {
      kind: "preference",
      statement: "Prioritize focus time",
      machineEffect: "boost",
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });
    const assistant = appendMessage(db, conversation.id, "assistant", "Understood.");
    db.prepare(
      `INSERT INTO response_context
         (assistant_message_id, item_kind, item_id, rank, snapshot_json,
          selection_reason, selection_score, retrieval_json, created_at)
       VALUES (?, 'facet', ?, 0, ?, 'query_relevant', 1, '["policy"]', ?)`,
    ).run(assistant.id, facet.id, JSON.stringify({ kind: "facet", facet }), new Date().toISOString());
    recordMcpRecallAudit(db, "zeus_recall", "focus", [
      { kind: "facet", id: facet.id, snapshot: { statement: facet.statement } },
    ]);
    db.prepare(
      `INSERT INTO recommendation_cycle
         (policy_version, trigger, context_json, query_text, candidate_scores_json,
          applied_facet_ids_json, exclusions_json, selected_commitment_id,
          recommendation_json, source_message_id, created_at)
       VALUES ('test', 'chat', '{}', '', '[]', ?, '[]', NULL, NULL, ?, ?)`,
    ).run(JSON.stringify([facet.id]), source.id, new Date().toISOString());

    expect(forgetFacet(db, facet.id)).toBe(true);
    expect(db.prepare("SELECT 1 FROM response_context WHERE item_kind='facet' AND item_id=?").get(facet.id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM mcp_recall_audit WHERE item_kind='facet' AND item_id=?").get(facet.id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM recommendation_cycle").get()).toBeUndefined();
  });

  it("rehomes multiply evidenced facets and removes their final source and indexes", () => {
    const db = openTestDb();
    const firstConversation = createConversation(db, { title: "First" });
    const secondConversation = createConversation(db, { title: "Second" });
    const first = appendMessage(db, firstConversation.id, "user", "I value calm decisions.");
    const second = appendMessage(
      db,
      secondConversation.id,
      "user",
      "I still value calm decisions.",
    );
    const firstPassage = ensureEvidencePassage(db, {
      messageId: first.id,
      quote: "I value calm decisions.",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const secondPassage = ensureEvidencePassage(db, {
      messageId: second.id,
      quote: "I still value calm decisions.",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const facet = recordFacet(db, {
      kind: "value",
      statement: "Calm decision-making matters to the user",
      sourceMessageId: first.id,
      passageIds: [firstPassage.id],
      confidence: 0.95,
    });
    recordFacet(db, {
      kind: "value",
      statement: facet.statement,
      sourceMessageId: second.id,
      passageIds: [secondPassage.id],
      confidence: 0.8,
    });
    db.prepare<[number, Buffer, number, string, string]>(
      `INSERT INTO facet_embedding (facet_id, vec, dim, model, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(facet.id, toBlob(Float32Array.from([1, 0])), 2, "test", new Date().toISOString());
    recordMcpRecallAudit(db, "test", "calm", [
      { kind: "facet", id: facet.id, snapshot: { statement: facet.statement } },
    ]);

    expect(conversationDependencies(db, firstConversation.id)).toMatchObject({
      passages: 1,
      facetsWithOtherEvidence: 1,
      facetsOnlyHere: 0,
    });
    deleteConversationWithMemory(db, firstConversation.id);
    expect(getConversation(db, firstConversation.id)).toBeNull();
    expect(getFacet(db, facet.id)?.source_message_id).toBe(second.id);
    expect(getFacet(db, facet.id)?.confidence).toBe(0.8);
    expect(evidenceForFacet(db, facet.id).map((entry) => entry.passage_id)).toEqual([
      secondPassage.id,
    ]);

    deleteConversationWithMemory(db, secondConversation.id);
    expect(getFacet(db, facet.id)).toBeNull();
    expect(
      db.prepare<[number]>("SELECT 1 FROM facet_fts WHERE rowid = ?").get(facet.id),
    ).toBeUndefined();
    expect(
      db.prepare<[number]>("SELECT 1 FROM facet_embedding WHERE facet_id = ?").get(facet.id),
    ).toBeUndefined();
    expect(
      db
        .prepare<[number]>(
          "SELECT 1 FROM mcp_recall_audit WHERE item_kind = 'facet' AND item_id = ?",
        )
        .get(facet.id),
    ).toBeUndefined();
  });

  it("restores a sourced facet version when its correction source is deleted", () => {
    const db = openTestDb();
    const originalConversation = createConversation(db);
    const correctionConversation = createConversation(db);
    const original = appendMessage(db, originalConversation.id, "user", "I prefer short answers.");
    const correction = appendMessage(
      db,
      correctionConversation.id,
      "user",
      "Correction: I prefer detailed answers.",
    );
    const originalPassage = ensureEvidencePassage(db, {
      messageId: original.id,
      quote: original.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const correctionPassage = ensureEvidencePassage(db, {
      messageId: correction.id,
      quote: correction.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const oldFacet = recordFacet(db, {
      kind: "communication_style",
      statement: "The user prefers short answers",
      sourceMessageId: original.id,
      passageIds: [originalPassage.id],
    });
    const replacement = correctFacet(db, oldFacet.id, {
      statement: "The user prefers detailed answers",
      sourceMessageId: correction.id,
      passageIds: [correctionPassage.id],
    });
    expect(replacement).not.toBeNull();
    expect(getFacet(db, oldFacet.id)?.valid_to).not.toBeNull();

    deleteConversationWithMemory(db, correctionConversation.id);
    expect(getFacet(db, replacement!.id)).toBeNull();
    expect(getFacet(db, oldFacet.id)?.valid_to).toBeNull();
    expect(getFacet(db, oldFacet.id)?.superseded_by).toBeNull();
  });

  it("replays surviving goal and commitment fields after a later update source is deleted", () => {
    const db = openTestDb();
    const baseConversation = createConversation(db, { title: "Base intentions" });
    const deletedConversation = createConversation(db, { title: "Deleted updates" });
    const survivingConversation = createConversation(db, { title: "Surviving update" });
    const base = appendMessage(
      db,
      baseConversation.id,
      "user",
      "I want to launch; draft the plan.",
    );
    const deletedUpdate = appendMessage(
      db,
      deletedConversation.id,
      "user",
      "Rename the launch, make it high priority, and mark both complete.",
    );
    const survivingUpdate = appendMessage(
      db,
      survivingConversation.id,
      "user",
      "I am more confident about those plans.",
    );
    const goal = createGoal(db, {
      title: "Launch",
      status: "active",
      priority: "normal",
      sourceMessageId: base.id,
      confidence: 0.9,
    });
    const commitment = createCommitment(db, {
      title: "Draft launch plan",
      linkedGoalId: goal.id,
      status: "open",
      sourceMessageId: base.id,
      confidence: 0.9,
    });
    updateGoal(db, goal.id, {
      title: "Launch brilliantly",
      status: "achieved",
      priority: "high",
      targetAt: "2030-06-01T00:00:00.000Z",
      confidence: 0.96,
      sourceMessageId: deletedUpdate.id,
      sourceKind: "message",
    });
    updateCommitment(db, commitment.id, {
      title: "Publish launch plan",
      status: "done",
      dueAt: "2030-05-15T00:00:00.000Z",
      snoozedUntil: "2030-05-01T00:00:00.000Z",
      confidence: 0.96,
      sourceMessageId: deletedUpdate.id,
      sourceKind: "message",
    });
    // These later events snapshot the deleted wording in before/after, but change
    // confidence only. Replay must not treat their unchanged fields as new evidence.
    updateGoal(db, goal.id, {
      confidence: 0.99,
      sourceMessageId: survivingUpdate.id,
      sourceKind: "message",
    });
    updateCommitment(db, commitment.id, {
      confidence: 0.99,
      sourceMessageId: survivingUpdate.id,
      sourceKind: "message",
    });
    recordMcpRecallAudit(db, "zeus_open_loops", "open", [
      { kind: "goal", id: goal.id, snapshot: getGoal(db, goal.id) },
      { kind: "commitment", id: commitment.id, snapshot: getCommitment(db, commitment.id) },
    ]);
    expect(conversationDependencies(db, deletedConversation.id)).toMatchObject({
      goals: 1,
      commitments: 1,
    });

    deleteConversationWithMemory(db, deletedConversation.id);

    expect(getGoal(db, goal.id)).toMatchObject({
      title: "Launch",
      status: "active",
      priority: "normal",
      target_at: null,
      confidence: 0.99,
      source_message_id: base.id,
      closed_at: null,
    });
    expect(getCommitment(db, commitment.id)).toMatchObject({
      title: "Draft launch plan",
      status: "open",
      due_at: null,
      snoozed_until: null,
      confidence: 0.99,
      source_message_id: base.id,
      closed_at: null,
    });
    expect(goalEvents(db, goal.id).map((event) => event.source_message_id)).toEqual([
      base.id,
      survivingUpdate.id,
    ]);
    expect(
      commitmentEvents(db, commitment.id).map((event) => event.source_message_id),
    ).toEqual([base.id, survivingUpdate.id]);
    expect(goalEvents(db, goal.id).map((event) => event.detail_json).join(" ")).not.toContain(
      "Launch brilliantly",
    );
    expect(
      commitmentEvents(db, commitment.id).map((event) => event.detail_json).join(" "),
    ).not.toContain("Publish launch plan");
    expect(JSON.parse(goalEvents(db, goal.id)[1]?.detail_json ?? "{}"))
      .toEqual({ changes: { confidence: 0.99 } });
    expect(JSON.parse(commitmentEvents(db, commitment.id)[1]?.detail_json ?? "{}"))
      .toEqual({ changes: { confidence: 0.99 } });
    expect(
      db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM mcp_recall_audit WHERE item_kind IN ('goal','commitment')",
        )
        .get()?.count,
    ).toBe(0);
  });

  it("rehomes projects to surviving evidence without retaining deleted progress text", () => {
    const db = openTestDb();
    const originalConversation = createConversation(db, { title: "Original project" });
    const survivingConversation = createConversation(db, { title: "Current project" });
    const linkedConversation = createConversation(db, { title: "Linked goal" });
    const original = appendMessage(
      db,
      originalConversation.id,
      "user",
      "Apollo is planned and the private first draft is nearly ready.",
    );
    const surviving = appendMessage(
      db,
      survivingConversation.id,
      "user",
      "Apollo is active now.",
    );
    const linked = appendMessage(
      db,
      linkedConversation.id,
      "user",
      "I want to ship Apollo.",
    );
    const entity = upsertEntity(db, { name: "Apollo", kind: "project" });
    const project = createProject(db, {
      entityId: entity.id,
      status: "planned",
      progressSummary: "The private first draft is nearly ready",
      progressPercent: 0.8,
      sourceMessageId: original.id,
    });
    updateProject(db, project.id, {
      status: "active",
      sourceMessageId: surviving.id,
      sourceKind: "message",
    });
    const goal = createGoal(db, {
      title: "Ship Apollo",
      projectId: project.id,
      sourceMessageId: linked.id,
    });
    const responseConversation = createConversation(db, { title: "Response" });
    const response = appendMessage(
      db,
      responseConversation.id,
      "assistant",
      "Apollo is active.",
    );
    recordResponseContext(db, response.id, [{ kind: "project", project: getProject(db, project.id)! }]);
    recordMcpRecallAudit(db, "zeus_projects", "Apollo", [
      { kind: "project", id: project.id, snapshot: getProject(db, project.id) },
    ]);

    expect(conversationDependencies(db, originalConversation.id).projects).toBe(1);
    deleteConversationWithMemory(db, originalConversation.id);

    expect(getProject(db, project.id)).toMatchObject({
      status: "active",
      progress_summary: null,
      progress_percent: null,
      source_message_id: surviving.id,
    });
    expect(projectEvents(db, project.id)).toMatchObject([
      { event_type: "status_changed", source_message_id: surviving.id },
    ]);
    expect(projectEvents(db, project.id)[0]?.detail_json ?? "").not.toContain(
      "private first draft",
    );
    expect(projectEvents(db, project.id)[0]).toMatchObject({
      from_status: null,
      to_status: "active",
      detail_json: null,
    });
    expect(recalledForResponse(db, response.id)).toEqual([]);
    expect(
      db
        .prepare<[number], { found: number }>(
          "SELECT 1 AS found FROM mcp_recall_audit WHERE item_kind = 'project' AND item_id = ?",
        )
        .get(project.id),
    ).toBeUndefined();

    deleteConversationWithMemory(db, survivingConversation.id);
    expect(getProject(db, project.id)).toBeNull();
    expect(getGoal(db, goal.id)?.project_id).toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("does not rehome a named project to a pronoun-only status event", () => {
    const db = openTestDb();
    const identityConversation = createConversation(db, { title: "Project identity" });
    const statusConversation = createConversation(db, { title: "Later status" });
    const identitySource = appendMessage(
      db,
      identityConversation.id,
      "user",
      "Project Nightjar is planned.",
    );
    const statusSource = appendMessage(
      db,
      statusConversation.id,
      "user",
      "It is active now.",
    );
    const entity = upsertEntityWithEvidence(db, {
      name: "Project Nightjar",
      kind: "project",
      sourceMessageId: identitySource.id,
    });
    const project = createProject(db, {
      entityId: entity.id,
      sourceMessageId: identitySource.id,
    });
    updateProject(db, project.id, {
      status: "active",
      sourceMessageId: statusSource.id,
      sourceKind: "message",
    });

    deleteConversationWithMemory(db, identityConversation.id);

    expect(getProject(db, project.id)).toBeNull();
    expect(getEntity(db, entity.id)).toBeNull();
    expect(getConversation(db, statusConversation.id)).not.toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("does not treat a surviving event's inherited snapshot as new intention evidence", () => {
    const db = openTestDb();
    const deletedConversation = createConversation(db, { title: "Deleted intention" });
    const survivingConversation = createConversation(db, { title: "Later status" });
    const deleted = appendMessage(
      db,
      deletedConversation.id,
      "user",
      "My confidential goal is Project Nightjar and I must draft the Nightjar memo.",
    );
    const surviving = appendMessage(
      db,
      survivingConversation.id,
      "user",
      "Mark both of those as complete.",
    );
    const goal = createGoal(db, {
      title: "Confidential Project Nightjar",
      sourceMessageId: deleted.id,
    });
    const commitment = createCommitment(db, {
      title: "Draft the Nightjar memo",
      linkedGoalId: goal.id,
      sourceMessageId: deleted.id,
    });
    updateGoal(db, goal.id, {
      status: "achieved",
      sourceMessageId: surviving.id,
      sourceKind: "message",
    });
    updateCommitment(db, commitment.id, {
      status: "done",
      sourceMessageId: surviving.id,
      sourceKind: "message",
    });

    deleteConversationWithMemory(db, deletedConversation.id);

    expect(getGoal(db, goal.id)).toBeNull();
    expect(getCommitment(db, commitment.id)).toBeNull();
    expect(getConversation(db, survivingConversation.id)).not.toBeNull();
    expect(
      db.prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM goal_event
         WHERE detail_json LIKE '%Nightjar%'`,
      ).get()?.count,
    ).toBe(0);
    expect(
      db.prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM commitment_event
         WHERE detail_json LIKE '%Nightjar%'`,
      ).get()?.count,
    ).toBe(0);
  });

  it("replays project links on goals and commitments after their update source is deleted", () => {
    const db = openTestDb();
    const baseConversation = createConversation(db, { title: "Base" });
    const projectConversation = createConversation(db, { title: "Project" });
    const deletedConversation = createConversation(db, { title: "Temporary links" });
    const base = appendMessage(db, baseConversation.id, "user", "I want to launch and draft it.");
    const projectSource = appendMessage(db, projectConversation.id, "user", "Apollo is planned.");
    const temporaryLink = appendMessage(
      db,
      deletedConversation.id,
      "user",
      "Temporarily link both launch tasks to Apollo.",
    );
    const entity = upsertEntity(db, { name: "Apollo", kind: "project" });
    const project = createProject(db, {
      entityId: entity.id,
      sourceMessageId: projectSource.id,
    });
    const goal = createGoal(db, { title: "Launch", sourceMessageId: base.id });
    const commitment = createCommitment(db, {
      title: "Draft launch",
      sourceMessageId: base.id,
    });
    updateGoal(db, goal.id, {
      projectId: project.id,
      sourceMessageId: temporaryLink.id,
      sourceKind: "message",
    });
    updateCommitment(db, commitment.id, {
      projectId: project.id,
      sourceMessageId: temporaryLink.id,
      sourceKind: "message",
    });

    deleteConversationWithMemory(db, deletedConversation.id);

    expect(getGoal(db, goal.id)?.project_id).toBeNull();
    expect(getCommitment(db, commitment.id)?.project_id).toBeNull();
    expect(getProject(db, project.id)).not.toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("removes only passage traces sourced by the deleted conversation when ids collide", async () => {
    const db = openTestDb();
    const keptConversation = createConversation(db, { title: "Keep" });
    const firstKept = appendMessage(db, keptConversation.id, "user", "A first kept passage.");
    ensureEvidencePassage(db, {
      messageId: firstKept.id,
      quote: firstKept.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });

    // The deleted message receives id 2. Delay its passage so passage id 2 can
    // independently belong to a kept message and prove the id spaces cannot be mixed.
    const deletedConversation = createConversation(db, { title: "Delete" });
    const deletedSource = appendMessage(
      db,
      deletedConversation.id,
      "user",
      "A source passage that will be deleted.",
    );
    const secondKept = appendMessage(
      db,
      keptConversation.id,
      "user",
      "A uniquely retained passage.",
    );
    const keptPassage = ensureEvidencePassage(db, {
      messageId: secondKept.id,
      quote: secondKept.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const deletedPassage = ensureEvidencePassage(db, {
      messageId: deletedSource.id,
      quote: deletedSource.content,
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    expect(keptPassage.id).toBe(deletedSource.id);

    const keptHit = (await searchEpisodes(db, "uniquely retained", { queryVector: null }))[0];
    const deletedHit = (await searchEpisodes(db, "source passage deleted", {
      queryVector: null,
    }))[0];
    expect(keptHit?.passage_id).toBe(keptPassage.id);
    expect(deletedHit?.passage_id).toBe(deletedPassage.id);

    const responseConversation = createConversation(db, { title: "Response" });
    const assistant = appendMessage(db, responseConversation.id, "assistant", "I recalled both.");
    recordResponseContext(db, assistant.id, [
      { kind: "episode", episode: keptHit! },
      { kind: "episode", episode: deletedHit! },
    ]);
    recordMcpRecallAudit(db, "zeus_recall", "both passages", [
      {
        kind: "episode",
        id: keptPassage.id,
        snapshot: {
          passage_id: keptPassage.id,
          source_message_id: secondKept.id,
          excerpt: keptPassage.text,
        },
      },
      {
        kind: "episode",
        id: deletedPassage.id,
        snapshot: {
          passage_id: deletedPassage.id,
          source_message_id: deletedSource.id,
          excerpt: deletedPassage.text,
        },
      },
    ]);

    deleteConversationWithMemory(db, deletedConversation.id);

    expect(getConversation(db, responseConversation.id)).not.toBeNull();
    const recalled = recalledForResponse(db, assistant.id);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.kind === "episode" ? recalled[0].episode.passage_id : null).toBe(
      keptPassage.id,
    );
    expect(recalled[0]?.kind === "episode" ? recalled[0].episode.message.content : null).toBe(
      keptPassage.text,
    );
    expect(
      db
        .prepare<[], { item_id: number }>(
          "SELECT item_id FROM mcp_recall_audit WHERE item_kind = 'episode' ORDER BY id",
        )
        .all()
        .map((row) => row.item_id),
    ).toEqual([keptPassage.id]);
  });

  it("projects legacy message-keyed traces through one eligible passage and abstains on ambiguity", () => {
    const db = openTestDb();
    const sourceConversation = createConversation(db, { title: "Legacy source" });
    const source = appendMessage(
      db,
      sourceConversation.id,
      "user",
      "The recallable sentence. A neighbouring private sentence.",
    );
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: "The recallable sentence.",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const responseConversation = createConversation(db, { title: "Legacy response" });
    const assistant = appendMessage(db, responseConversation.id, "assistant", "Old response.");
    const oldSnapshot = {
      kind: "episode",
      episode: {
        message: source,
        conversation_title: "Legacy source",
        excerpt: source.content,
        score: 0,
        via: [],
      },
    };
    db.prepare<[number, number, string, string]>(
      `INSERT INTO response_context
         (assistant_message_id, item_kind, item_id, rank, selection_reason,
          selection_score, retrieval_json, created_at, snapshot_json)
       VALUES (?, 'episode', ?, 0, NULL, NULL, NULL, ?, ?)`,
    ).run(assistant.id, source.id, new Date().toISOString(), JSON.stringify(oldSnapshot));

    const recalled = recalledForResponse(db, assistant.id);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.kind === "episode" ? recalled[0].episode : null).toMatchObject({
      passage_id: passage.id,
      start_offset: passage.start_offset,
      end_offset: passage.end_offset,
      message: { id: source.id, content: passage.text },
      excerpt: passage.text,
    });
    expect(JSON.stringify(recalled)).not.toContain("neighbouring private");

    ensureEvidencePassage(db, {
      messageId: source.id,
      quote: "A neighbouring private sentence.",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    expect(recalledForResponse(db, assistant.id)).toEqual([]);
  });
});

describe("understanding migrations", () => {
  it("repairs stores whose understanding migration omitted backfill items", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 9)) db.exec(migration.sql);
    db.exec("DROP TABLE understanding_backfill_item");
    const conversation = createConversation(db, { title: "Deletable chat" });
    appendMessage(db, conversation.id, "user", "This source should be deletable.");

    expect(() => db.exec(MIGRATIONS[9]!.sql)).not.toThrow();
    expect(conversationDependencies(db, conversation.id).backfillItems).toBe(0);
    expect(() => deleteConversationWithMemory(db, conversation.id)).not.toThrow();
    expect(getConversation(db, conversation.id)).toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("upgrades stores created before candidate resolution auditing existed", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 8)) db.exec(migration.sql);
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I prefer concise plans.");
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "pending",
    });
    const candidate = createCandidate(db, {
      kind: "facet",
      payload: { statement: "The user prefers concise plans" },
      reason: "inference",
      confidence: 0.8,
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });

    db.exec("DROP TABLE candidate_resolution_event");
    expect(() => db.exec(MIGRATIONS[8]!.sql)).not.toThrow();
    expect(
      db
        .prepare<[number], { count: number }>(
          "SELECT COUNT(*) AS count FROM candidate_evidence WHERE candidate_id = ?",
        )
        .get(candidate.id)?.count,
    ).toBe(1);
    expect(
      db
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM candidate_resolution_event",
        )
        .get()?.count,
    ).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("adds backfill_preview without losing candidate evidence or resolution audit", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 8)) db.exec(migration.sql);
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "I prefer concise plans.");
    const passage = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: source.content,
      sensitivity: "normal",
      recallStatus: "pending",
    });
    const candidate = createCandidate(db, {
      kind: "facet",
      payload: { statement: "The user prefers concise plans" },
      reason: "inference",
      confidence: 0.8,
      sourceMessageId: source.id,
      passageIds: [passage.id],
    });
    recordCandidateResolution(db, {
      candidateId: candidate.id,
      decision: "rejected",
      sourceMessageId: source.id,
    });

    db.exec(MIGRATIONS[8]!.sql);
    expect(
      db
        .prepare<[number], { count: number }>(
          "SELECT COUNT(*) AS count FROM candidate_evidence WHERE candidate_id = ?",
        )
        .get(candidate.id)?.count,
    ).toBe(1);
    expect(
      db
        .prepare<[number], { count: number }>(
          "SELECT COUNT(*) AS count FROM candidate_resolution_event WHERE candidate_id = ?",
        )
        .get(candidate.id)?.count,
    ).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_candidate
             (kind, payload_json, reason, reasons_json, confidence,
              source_message_id, status, origin, created_at)
           VALUES ('facet', '{}', 'backfill_preview', '["backfill_preview"]',
                   0.8, ?, 'pending', 'backfill', ?)`,
        )
        .run(source.id, new Date().toISOString()),
    ).not.toThrow();
    db.close();
  });
});

describe("passage semantic privacy", () => {
  it("never lets a blocked neighbouring span influence semantic episode recall", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "I enjoy quiet mornings. My secret diagnosis is private.",
    );
    const allowed = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: "I enjoy quiet mornings.",
      sensitivity: "normal",
      recallStatus: "allowed",
    });
    const blocked = ensureEvidencePassage(db, {
      messageId: source.id,
      quote: "My secret diagnosis is private.",
      sensitivity: "sensitive",
      recallStatus: "blocked",
    });
    const timestamp = new Date().toISOString();
    const insert = db.prepare<[number, Buffer, number, string, string]>(
      `INSERT INTO passage_embedding (passage_id, vec, dim, model, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // Use the production model key so the loader sees these deterministic vectors.
    insert.run(
      allowed.id,
      toBlob(Float32Array.from([0, 1])),
      2,
      "Xenova/bge-small-en-v1.5",
      timestamp,
    );
    insert.run(
      blocked.id,
      toBlob(Float32Array.from([1, 0])),
      2,
      "Xenova/bge-small-en-v1.5",
      timestamp,
    );
    const pendingFacet = createCandidate(db, {
      kind: "facet",
      payload: { statement: "The user values quiet mornings" },
      reason: "inference",
      confidence: 0.7,
      sourceMessageId: source.id,
      passageIds: [allowed.id],
    });

    expect(
      await searchEpisodes(db, "secret diagnosis", {
        queryVector: Float32Array.from([1, 0]),
      }),
    ).toEqual([]);
    expect(
      await searchEpisodes(db, "quiet mornings", {
        queryVector: Float32Array.from([0, 1]),
      }),
    ).toEqual([]);
    resolveCandidate(db, pendingFacet.id, "accepted");
    const recalled = await searchEpisodes(db, "unmatched wording", {
      queryVector: Float32Array.from([0, 1]),
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.excerpt).toBe("I enjoy quiet mornings.");
    expect(recalled[0]?.message.content).toBe("I enjoy quiet mornings.");
    expect(recalled[0]?.message.content).not.toContain("diagnosis");
  });
});

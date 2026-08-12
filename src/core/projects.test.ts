import { beforeEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import { buildContext } from "./context";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { upsertEntity, upsertEntityWithEvidence } from "./entities";
import { applyExtraction } from "./extract";
import { createCommitment, createGoal } from "./intentions";
import { allowWholeMessagePassage } from "./passages";
import {
  createProject,
  getProject,
  getProjectByEntityId,
  listProjects,
  markProjectBlocked,
  markProjectUnblocked,
  projectEvents,
  recordProjectProgress,
  updateProject,
} from "./projects";
import { ProjectView } from "./schema";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

function projectSource(content = "Project Apollo is now an active project.") {
  const conversation = createConversation(db, { title: "Project update" });
  const message = appendMessage(db, conversation.id, "user", content);
  const entity = upsertEntityWithEvidence(db, {
    name: "Project Apollo",
    kind: "project",
    aliases: ["Apollo"],
    sourceMessageId: message.id,
  });
  return { conversation, message, entity };
}

describe("project lifecycle", () => {
  it("retrieves a relevant project with linked goals and commitments as one context cluster", async () => {
    const { message, entity } = projectSource();
    const project = createProject(db, {
      entityId: entity.id,
      status: "active",
      sourceMessageId: message.id,
    });
    const lifecycle = createConversation(db, { title: "Apollo lifecycle" });
    const goalSource = appendMessage(db, lifecycle.id, "user", "My goal is to ship the beta.");
    const goal = createGoal(db, {
      title: "Ship the beta",
      projectId: project.id,
      sourceMessageId: goalSource.id,
    });
    const commitmentSource = appendMessage(
      db,
      lifecycle.id,
      "user",
      "I will write the acceptance tests.",
    );
    const commitment = createCommitment(db, {
      title: "Write the acceptance tests",
      linkedGoalId: goal.id,
      projectId: project.id,
      sourceMessageId: commitmentSource.id,
    });

    const context = await buildContext(db, "What is happening with Project Apollo?", {
      queryVector: null,
    });
    expect(context.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "project", project: expect.objectContaining({ id: project.id }) }),
        expect.objectContaining({ kind: "goal", goal: expect.objectContaining({ id: goal.id }) }),
        expect.objectContaining({
          kind: "commitment",
          commitment: expect.objectContaining({ id: commitment.id }),
        }),
      ]),
    );
  });

  it("materializes and updates a project lifecycle from accepted, sourced project facts", () => {
    const conversation = createConversation(db);
    const started = appendMessage(db, conversation.id, "user", "I am working on Project Apollo.");
    const applied = applyExtraction(
      db,
      {
        entities: [{ name: "Project Apollo", kind: "project", aliases: ["Apollo"] }],
        facts: [
          {
            subject: "self",
            predicate: "works_on",
            object: "Project Apollo",
            object_entity: "Project Apollo",
            confidence: 0.98,
            supersedes_previous: false,
            evidence: [{ source_message_id: started.id, quote: started.content }],
            grounding: "user_statement",
            explicitness: "explicit",
            sensitivity: "normal",
            ambiguity: "clear",
          },
        ],
      },
      started.id,
    );

    expect(applied.projects).toMatchObject([
      {
        entity_name: "Project Apollo",
        status: "active",
        source_message_id: started.id,
      },
    ]);
    const completed = appendMessage(db, conversation.id, "user", "Project Apollo is completed.");
    const update = applyExtraction(
      db,
      {
        entities: [],
        facts: [
          {
            subject: "Project Apollo",
            predicate: "status",
            object: "completed",
            object_entity: null,
            confidence: 0.99,
            supersedes_previous: true,
            evidence: [{ source_message_id: completed.id, quote: completed.content }],
            grounding: "user_statement",
            explicitness: "explicit",
            sensitivity: "normal",
            ambiguity: "clear",
          },
        ],
      },
      completed.id,
    );

    expect(update.projects[0]).toMatchObject({
      id: applied.projects[0]?.id,
      status: "completed",
      source_message_id: started.id,
    });
    expect(projectEvents(db, applied.projects[0]!.id).map((event) => event.event_type)).toEqual([
      "created",
      "status_changed",
    ]);
  });

  it("does not demote an active project when an unrelated project fact is accepted", () => {
    const { message, entity } = projectSource();
    const project = createProject(db, {
      entityId: entity.id,
      status: "active",
      sourceMessageId: message.id,
    });
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "Project Apollo uses TypeScript.");
    applyExtraction(
      db,
      {
        entities: [],
        facts: [{
          subject: "Project Apollo",
          predicate: "uses",
          object: "TypeScript",
          object_entity: null,
          confidence: 0.98,
          supersedes_previous: false,
          evidence: [{ source_message_id: source.id, quote: source.content }],
          grounding: "user_statement",
          explicitness: "explicit",
          sensitivity: "normal",
          ambiguity: "clear",
        }],
      },
      source.id,
    );
    expect(getProject(db, project.id)?.status).toBe("active");
  });

  it("creates a source-backed project and links extracted goals and commitments", () => {
    const conversation = createConversation(db);
    const source = appendMessage(
      db,
      conversation.id,
      "user",
      "For Project Atlas, I want to launch the beta and I will draft the test plan.",
    );
    const applied = applyExtraction(
      db,
      {
        entities: [{ name: "Project Atlas", kind: "project", aliases: ["Atlas"] }],
        facts: [],
        goals: [
          {
            existing_id: null,
            title: "Launch the Atlas beta",
            status: "active",
            priority: null,
            target_at: null,
            project_name: "Project Atlas",
            confidence: 0.98,
            evidence: [{ source_message_id: source.id, quote: source.content }],
            grounding: "user_statement",
            explicitness: "explicit",
            sensitivity: "normal",
            ambiguity: "clear",
          },
        ],
        commitments: [
          {
            existing_id: null,
            title: "Draft the Atlas test plan",
            owner: "self",
            linked_goal_title: "Launch the Atlas beta",
            project_name: "Project Atlas",
            status: "open",
            due_at: null,
            confidence: 0.98,
            evidence: [{ source_message_id: source.id, quote: source.content }],
            grounding: "user_statement",
            explicitness: "explicit",
            sensitivity: "normal",
            ambiguity: "clear",
          },
        ],
      },
      source.id,
    );

    expect(applied.projects).toHaveLength(1);
    expect(applied.projects[0]).toMatchObject({
      entity_name: "Project Atlas",
      status: "planned",
      source_message_id: source.id,
    });
    expect(applied.goals[0]?.project_id).toBe(applied.projects[0]?.id);
    expect(applied.commitments[0]?.project_id).toBe(applied.projects[0]?.id);
    expect(applied.commitments[0]?.linked_goal_id).toBe(applied.goals[0]?.id);
  });

  it("keys a source-backed lifecycle to an existing project entity", () => {
    const { message, entity } = projectSource();
    const passage = allowWholeMessagePassage(db, message.id);

    const project = createProject(db, {
      entityId: entity.id,
      status: "active",
      progressSummary: "Discovery is underway",
      progressPercent: 0.15,
      confidence: 0.96,
      sourceMessageId: message.id,
      passageId: passage.id,
    });

    expect(ProjectView.parse(project)).toEqual(project);
    expect(project).toMatchObject({
      entity_id: entity.id,
      entity_name: "Project Apollo",
      entity_slug: "project-apollo",
      status: "active",
      progress_summary: "Discovery is underway",
      progress_percent: 0.15,
      confidence: 0.96,
      source_message_id: message.id,
      blocked_at: null,
      closed_at: null,
    });
    expect(getProject(db, project.id)).toEqual(project);
    expect(getProjectByEntityId(db, entity.id)).toEqual(project);
    expect(listProjects(db)).toEqual([project]);
    expect(projectEvents(db, project.id)).toMatchObject([
      {
        event_type: "created",
        from_status: null,
        to_status: "active",
        source_message_id: message.id,
        passage_id: passage.id,
        source_kind: "message",
      },
    ]);
  });

  it("preserves append-only status, progress, blocked, and unblocked events", () => {
    const { message, entity } = projectSource("I am planning Project Apollo.");
    const project = createProject(db, {
      entityId: entity.id,
      sourceMessageId: message.id,
    });
    const conversation = createConversation(db, { title: "Project lifecycle" });
    const activeSource = appendMessage(db, conversation.id, "user", "Apollo is active now.");
    const blockedSource = appendMessage(
      db,
      conversation.id,
      "user",
      "Apollo is blocked by vendor access.",
    );

    updateProject(db, project.id, {
      status: "active",
      sourceMessageId: activeSource.id,
      sourceKind: "message",
    });
    recordProjectProgress(db, project.id, {
      summary: "Completed discovery",
      percent: 0.35,
      sourceKind: "user_action",
    });
    const blocked = markProjectBlocked(db, project.id, {
      reason: "Waiting for vendor access",
      sourceMessageId: blockedSource.id,
      sourceKind: "message",
    });
    expect(blocked?.blocked_at).not.toBeNull();

    // Replaying the same sourced transition is idempotent.
    markProjectBlocked(db, project.id, {
      reason: "Waiting for vendor access",
      sourceMessageId: blockedSource.id,
      sourceKind: "message",
    });
    expect(projectEvents(db, project.id).filter((event) => event.event_type === "blocked"))
      .toHaveLength(1);

    markProjectUnblocked(db, project.id, {
      resolution: "Access granted",
      sourceKind: "user_action",
    });
    const completed = updateProject(db, project.id, {
      status: "completed",
      progressSummary: "Shipped",
      progressPercent: 1,
      sourceKind: "user_action",
    });

    expect(completed).toMatchObject({
      status: "completed",
      progress_summary: "Shipped",
      progress_percent: 1,
      blocked_at: null,
    });
    expect(completed?.closed_at).not.toBeNull();
    expect(listProjects(db)).toEqual([]);
    expect(listProjects(db, { includeClosed: true })).toHaveLength(1);
    expect(projectEvents(db, project.id).map((event) => event.event_type)).toEqual([
      "created",
      "status_changed",
      "progress",
      "blocked",
      "unblocked",
      "status_changed",
    ]);

    const progressEvent = projectEvents(db, project.id).find(
      (event) => event.event_type === "progress",
    );
    expect(JSON.parse(progressEvent?.detail_json ?? "{}")).toEqual({
      before: { summary: null, percent: null },
      after: { summary: "Completed discovery", percent: 0.35 },
    });

    const reopened = updateProject(db, project.id, {
      status: "active",
      sourceKind: "user_action",
    });
    expect(reopened?.closed_at).toBeNull();
  });

  it("keeps the initial source while later user statements add audit events", () => {
    const { message, entity } = projectSource("Project Apollo is planned.");
    const project = createProject(db, {
      entityId: entity.id,
      sourceMessageId: message.id,
    });
    const secondConversation = createConversation(db);
    const secondSource = appendMessage(
      db,
      secondConversation.id,
      "user",
      "Apollo has started.",
    );

    const sameProject = createProject(db, {
      entityId: entity.id,
      status: "active",
      sourceMessageId: secondSource.id,
    });

    expect(sameProject.id).toBe(project.id);
    expect(sameProject.source_message_id).toBe(message.id);
    expect(sameProject.status).toBe("active");
    expect(projectEvents(db, project.id).map((event) => event.source_message_id)).toEqual([
      message.id,
      secondSource.id,
    ]);

    // A repeat extraction from the same source does not duplicate its audit record.
    createProject(db, {
      entityId: entity.id,
      status: "active",
      sourceMessageId: secondSource.id,
    });
    expect(projectEvents(db, project.id)).toHaveLength(2);
  });

  it("requires real user provenance and matching evidence passages", () => {
    const conversation = createConversation(db);
    const user = appendMessage(db, conversation.id, "user", "Project Apollo is planned.");
    const other = appendMessage(db, conversation.id, "user", "A separate observation.");
    const assistant = appendMessage(db, conversation.id, "assistant", "Apollo is planned.");
    const projectEntity = upsertEntity(db, { name: "Apollo", kind: "project" });
    const personEntity = upsertEntity(db, { name: "Pat", kind: "person" });
    const passage = allowWholeMessagePassage(db, user.id);

    expect(() =>
      createProject(db, {
        entityId: projectEntity.id,
        sourceMessageId: assistant.id,
      }),
    ).toThrow(/stored user message/u);
    expect(() =>
      createProject(db, {
        entityId: personEntity.id,
        sourceMessageId: user.id,
      }),
    ).toThrow(/not a project entity/u);

    const project = createProject(db, {
      entityId: projectEntity.id,
      sourceMessageId: user.id,
      passageId: passage.id,
    });
    expect(() =>
      recordProjectProgress(db, project.id, {
        percent: 0.5,
        sourceMessageId: other.id,
        sourceKind: "message",
        passageId: passage.id,
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      updateProject(db, project.id, {
        status: "active",
        sourceKind: "message",
      }),
    ).toThrow(/require a source message/u);
    expect(() => updateProject(db, project.id, { status: "active" })).toThrow(
      /explicit user_action/u,
    );
  });

  it("validates progress and requires a meaningful progress observation", () => {
    const { message, entity } = projectSource();
    const project = createProject(db, {
      entityId: entity.id,
      sourceMessageId: message.id,
    });

    expect(() => recordProjectProgress(db, project.id, {})).toThrow(/summary or percent/u);
    expect(() =>
      recordProjectProgress(db, project.id, { percent: -0.1, sourceKind: "user_action" }),
    ).toThrow(/between 0 and 1/u);
    expect(() =>
      updateProject(db, project.id, {
        progressPercent: 1.1,
        sourceKind: "user_action",
      }),
    ).toThrow(/between 0 and 1/u);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import { appendMessage, createConversation } from "./conversations";
import type { Db } from "./db";
import { openTestDb } from "./db";
import { putEmbedding } from "./embed";
import {
  addAlias,
  AmbiguousEntityError,
  aliasesOf,
  foldAlias,
  getEntity,
  listEntities,
  mergeEntities,
  resolveEntity,
  resolveEntityCandidates,
  selfEntity,
  slugify,
  upsertEntity,
} from "./entities";
import { factsForEntity, recordFact } from "./facts";
import { createCommitment, createGoal, getCommitment, getGoal } from "./intentions";
import {
  createProject,
  getProject,
  getProjectByEntityId,
  projectEvents,
  recordProjectProgress,
} from "./projects";
import {
  activeWorkAuthorization,
  authorizeWorkPlan,
  createWorkPlan,
  getWorkAuthorization,
  getWorkPlan,
  listWorkRuns,
  resumeWorkRun,
  runWorkPlan,
} from "./work-plans";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

describe("normalization", () => {
  it("folds aliases to a comparable form", () => {
    expect(foldAlias("  Sarah   Chen ")).toBe("sarah chen");
    expect(foldAlias("SARAH")).toBe("sarah");
  });

  it("slugifies names, including accented ones", () => {
    expect(slugify("Sarah Chen")).toBe("sarah-chen");
    expect(slugify("Café Zürich")).toBe("cafe-zurich");
    expect(slugify("!!!")).toBe("entity");
  });
});

describe("resolution", () => {
  it("treats Sarah, Sarah Chen, and sarah as one person", () => {
    const created = upsertEntity(db, {
      name: "Sarah Chen",
      kind: "person",
      aliases: ["Sarah"],
    });

    expect(resolveEntity(db, "Sarah")?.id).toBe(created.id);
    expect(resolveEntity(db, "sarah chen")?.id).toBe(created.id);
    expect(resolveEntity(db, "  SARAH  ")?.id).toBe(created.id);

    // One entity, not three. (`self` is also a person, so exclude it.)
    const people = listEntities(db, { kind: "person" }).filter((e) => e.slug !== "self");
    expect(people).toHaveLength(1);
  });

  it("returns null for someone it has never heard of", () => {
    expect(resolveEntity(db, "Nobody At All")).toBeNull();
  });

  it("upserting an existing entity adds aliases rather than duplicating", () => {
    const first = upsertEntity(db, { name: "Acme", kind: "org" });
    const second = upsertEntity(db, { name: "Acme", kind: "org", aliases: ["Acme Corp"] });

    expect(second.id).toBe(first.id);
    expect(aliasesOf(db, first.id)).toContain("acme corp");
  });

  it("surfaces a shared alias as ambiguous instead of choosing its first owner", () => {
    const chen = upsertEntity(db, { name: "Sarah Chen", kind: "person", aliases: ["Sarah"] });
    const jones = upsertEntity(db, { name: "Sarah Jones", kind: "person" });

    expect(addAlias(db, jones.id, "Sarah")).toBe(true);
    expect(resolveEntity(db, "Sarah")).toBeNull();
    expect(resolveEntityCandidates(db, "Sarah").map((entity) => entity.id)).toEqual([
      chen.id,
      jones.id,
    ]);
    expect(resolveEntity(db, "Sarah Jones")?.id).toBe(jones.id);
  });

  it("refuses to upsert an ambiguous exact name even when slugs differ", () => {
    const a = upsertEntity(db, { name: "Apollo", kind: "project" });
    db.prepare(
      "INSERT INTO entity (kind, name, slug, created_at, updated_at) VALUES ('org','Apollo','apollo-2','x','x')",
    ).run();

    expect(a.slug).toBe("apollo");
    expect(() => upsertEntity(db, { name: "Apollo", kind: "project" })).toThrow(
      AmbiguousEntityError,
    );
  });
});

describe("the self entity", () => {
  it("exists on a fresh database and answers to first-person aliases", () => {
    const me = selfEntity(db);
    expect(me.slug).toBe("self");
    expect(resolveEntity(db, "me")?.id).toBe(me.id);
    expect(resolveEntity(db, "I")?.id).toBe(me.id);
  });
});

describe("merging", () => {
  it("folds a duplicate entity into the canonical one without losing facts", () => {
    const short = upsertEntity(db, { name: "Sarah", kind: "person" });
    const full = upsertEntity(db, { name: "Sarah Chen", kind: "person" });

    recordFact(db, { subjectId: short.id, predicate: "likes", object: "hiking" });
    recordFact(db, { subjectId: full.id, predicate: "works_at", object: "Acme" });

    mergeEntities(db, short.id, full.id);

    expect(getEntity(db, short.id)).toBeNull();
    const facts = factsForEntity(db, full.id);
    expect(facts.map((fact) => fact.object).sort()).toEqual(["Acme", "hiking"]);
    expect(resolveEntity(db, "Sarah")?.id).toBe(full.id);
  });

  it("re-points incoming graph edges when merging", () => {
    const me = selfEntity(db).id;
    const short = upsertEntity(db, { name: "Acme", kind: "org" });
    const full = upsertEntity(db, { name: "Acme Corporation", kind: "org" });

    recordFact(db, {
      subjectId: me,
      predicate: "works_at",
      object: "Acme",
      objectEntityId: short.id,
    });

    mergeEntities(db, short.id, full.id);

    const facts = factsForEntity(db, full.id, { includeIncoming: true });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.object_entity_id).toBe(full.id);
  });

  it("re-points commitment owners when merging", () => {
    const duplicate = upsertEntity(db, { name: "Sam", kind: "person" });
    const canonical = upsertEntity(db, { name: "Sam Rivera", kind: "person" });
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "Sam will send the draft.");
    const commitment = createCommitment(db, {
      title: "Send the draft",
      ownerEntityId: duplicate.id,
      sourceMessageId: source.id,
    });

    mergeEntities(db, duplicate.id, canonical.id);

    expect(getCommitment(db, commitment.id)?.owner_entity_id).toBe(canonical.id);
    expect(getCommitment(db, commitment.id)?.owner_name).toBe("Sam Rivera");
  });

  it("re-points a project lifecycle when only the duplicate entity owns one", () => {
    const duplicate = upsertEntity(db, { name: "Apollo", kind: "project" });
    const canonical = upsertEntity(db, { name: "Project Apollo", kind: "project" });
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "Apollo is an active project.");
    const project = createProject(db, {
      entityId: duplicate.id,
      status: "active",
      sourceMessageId: source.id,
    });

    mergeEntities(db, duplicate.id, canonical.id);

    expect(getProjectByEntityId(db, duplicate.id)).toBeNull();
    expect(getProjectByEntityId(db, canonical.id)).toMatchObject({
      id: project.id,
      entity_name: "Project Apollo",
      status: "active",
      source_message_id: source.id,
    });
    expect(projectEvents(db, project.id)).toMatchObject([
      { event_type: "created", source_message_id: source.id },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("combines project lifecycles while invalidating hash-bound plan scope", async () => {
    const canonical = upsertEntity(db, { name: "Project Apollo", kind: "project" });
    const duplicate = upsertEntity(db, { name: "Apollo Initiative", kind: "project" });
    const conversation = createConversation(db);
    const canonicalSource = appendMessage(
      db,
      conversation.id,
      "user",
      "Project Apollo is planned.",
    );
    const duplicateSource = appendMessage(
      db,
      conversation.id,
      "user",
      "The Apollo Initiative is active.",
    );
    const progressSource = appendMessage(
      db,
      conversation.id,
      "user",
      "Apollo finished discovery and is 40 percent complete.",
    );
    const canonicalProject = createProject(db, {
      entityId: canonical.id,
      sourceMessageId: canonicalSource.id,
    });
    const duplicateProject = createProject(db, {
      entityId: duplicate.id,
      status: "active",
      sourceMessageId: duplicateSource.id,
    });
    recordProjectProgress(db, duplicateProject.id, {
      summary: "Discovery complete",
      percent: 0.4,
      sourceMessageId: progressSource.id,
      sourceKind: "message",
    });
    const goal = createGoal(db, {
      title: "Ship Apollo",
      projectId: duplicateProject.id,
      sourceMessageId: duplicateSource.id,
    });
    const commitment = createCommitment(db, {
      title: "Draft the Apollo brief",
      projectId: duplicateProject.id,
      sourceMessageId: duplicateSource.id,
    });
    const workPlan = createWorkPlan(db, {
      proposal: {
        objective: "Draft Apollo brief",
        steps: [{
          title: "Draft brief",
          instruction: "Prepare the brief in the local store.",
          effect_kind: "prepare_local",
          depends_on: [],
        }],
        allowed_effects: ["prepare_local"],
        completion_criteria: ["A local draft is ready"],
        limits: {
          max_model_tool_calls: 4,
          max_retries_per_step: 1,
          max_duration_seconds: 300,
        },
      },
      sourceMessageId: duplicateSource.id,
      sourceProjectId: duplicateProject.id,
      origin: "explicit_request",
    });
    const authorization = authorizeWorkPlan(db, workPlan.plan.id, {
      planHash: workPlan.plan.plan_hash,
      authorizationKind: "explicit_request",
      allowedEffects: ["prepare_local"],
      maxModelToolCalls: 4,
      maxRetriesPerStep: 1,
      maxDurationSeconds: 300,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceMessageId: duplicateSource.id,
    });
    const run = await runWorkPlan(db, workPlan.plan.id);
    expect(run.status).toBe("paused");
    expect(activeWorkAuthorization(db, workPlan.plan.id)?.id).toBe(authorization.id);

    mergeEntities(db, duplicate.id, canonical.id);

    expect(getProject(db, duplicateProject.id)).toBeNull();
    expect(getProject(db, canonicalProject.id)).toMatchObject({
      entity_id: canonical.id,
      status: "active",
      progress_summary: "Discovery complete",
      progress_percent: 0.4,
      source_message_id: canonicalSource.id,
    });
    expect(projectEvents(db, canonicalProject.id)).toMatchObject([
      { event_type: "created", source_message_id: canonicalSource.id },
      { event_type: "created", source_message_id: duplicateSource.id },
      { event_type: "progress", source_message_id: progressSource.id },
    ]);
    expect(getGoal(db, goal.id)?.project_id).toBe(canonicalProject.id);
    expect(getCommitment(db, commitment.id)?.project_id).toBe(canonicalProject.id);
    expect(
      db
        .prepare<[number], { source_project_id: number | null }>(
          "SELECT source_project_id FROM work_plan WHERE id = ?",
        )
        .get(workPlan.plan.id)?.source_project_id,
    ).toBe(canonicalProject.id);
    expect(getWorkPlan(db, workPlan.plan.id)?.plan.status).toBe("paused");
    expect(activeWorkAuthorization(db, workPlan.plan.id)).toBeNull();
    expect(getWorkAuthorization(db, authorization.id)?.revoked_at).not.toBeNull();
    expect(listWorkRuns(db, workPlan.plan.id)[0]).toMatchObject({
      id: run.id,
      status: "paused",
      error_code: "scope_invalidated",
    });

    const resumed = await resumeWorkRun(db, run.id);
    expect(resumed).toMatchObject({ status: "paused", error_code: "plan_hash_changed" });
    expect(activeWorkAuthorization(db, workPlan.plan.id)).toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("reconciles duplicate and conflicting live facts after a merge", () => {
    const duplicate = upsertEntity(db, { name: "Sam", kind: "person" });
    const canonical = upsertEntity(db, { name: "Sam Rivera", kind: "person" });
    recordFact(db, {
      subjectId: duplicate.id,
      predicate: "likes",
      object: "hiking",
      validFrom: "2025-01-01",
    });
    recordFact(db, {
      subjectId: canonical.id,
      predicate: "likes",
      object: "hiking",
      validFrom: "2025-02-01",
    });
    recordFact(db, {
      subjectId: duplicate.id,
      predicate: "works_at",
      object: "Old Co",
      validFrom: "2024-01-01",
    });
    recordFact(db, {
      subjectId: canonical.id,
      predicate: "works_at",
      object: "New Co",
      validFrom: "2025-01-01",
    });

    mergeEntities(db, duplicate.id, canonical.id);

    const facts = factsForEntity(db, canonical.id, { includeSuperseded: true });
    expect(facts.filter((fact) => fact.predicate === "likes" && fact.valid_to === null))
      .toHaveLength(1);
    expect(
      facts
        .filter((fact) => fact.predicate === "works_at" && fact.valid_to === null)
        .map((fact) => fact.object),
    ).toEqual(["New Co"]);
    expect(
      facts.find((fact) => fact.predicate === "works_at" && fact.object === "Old Co"),
    ).toMatchObject({ valid_to: "2025-01-01T00:00:00.000Z" });
  });

  it("rebuilds merged fact text and clears stale semantic indexes", () => {
    const me = selfEntity(db).id;
    const duplicate = upsertEntity(db, { name: "Sam", kind: "person" });
    const canonical = upsertEntity(db, { name: "Alexandra Jones", kind: "person" });
    const outgoing = recordFact(db, {
      subjectId: duplicate.id,
      predicate: "likes",
      object: "hiking",
    }).fact;
    const incoming = recordFact(db, {
      subjectId: me,
      predicate: "knows",
      object: "Sam",
      objectEntityId: duplicate.id,
    }).fact;
    putEmbedding(db, "fact", outgoing.id, new Float32Array([1]));
    putEmbedding(db, "fact", incoming.id, new Float32Array([1]));
    putEmbedding(db, "entity", duplicate.id, new Float32Array([1]));
    putEmbedding(db, "entity", canonical.id, new Float32Array([1]));

    mergeEntities(db, duplicate.id, canonical.id);

    const renamedHits = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?")
      .all("alexandra");
    const staleHits = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM fact_fts WHERE fact_fts MATCH ?")
      .all("sam");
    expect(renamedHits.map((row) => row.rowid)).toContain(outgoing.id);
    expect(staleHits.map((row) => row.rowid)).toEqual([incoming.id]);

    const affectedEmbeddings = db
      .prepare<[], { owner_kind: string; owner_id: number }>(
        `SELECT owner_kind, owner_id FROM embedding
         WHERE (owner_kind = 'fact' AND owner_id IN (${outgoing.id}, ${incoming.id}))
            OR (owner_kind = 'entity' AND owner_id = ${canonical.id})`,
      )
      .all();
    expect(affectedEmbeddings).toEqual([]);
  });

  it("preserves entity evidence, alias evidence, and facet scopes", () => {
    const duplicate = upsertEntity(db, {
      name: "Sam",
      kind: "person",
      aliases: ["Coach"],
    });
    const canonical = upsertEntity(db, { name: "Sam Rivera", kind: "person" });
    const conversation = createConversation(db);
    const source = appendMessage(db, conversation.id, "user", "Coach Sam values collaboration.");
    db.prepare<[number, string]>(
      "INSERT INTO entity_alias (entity_id, alias, created_at) VALUES (?, 'coach', ?)",
    ).run(canonical.id, "2025-02-01T00:00:00.000Z");
    db.prepare<[number, number, string]>(
      `INSERT INTO entity_evidence
         (entity_id, source_message_id, kind, created_at)
       VALUES (?, ?, 'mention', ?)`,
    ).run(duplicate.id, source.id, "2025-01-01T00:00:00.000Z");
    db.prepare<[number, number, string]>(
      `INSERT INTO entity_evidence
         (entity_id, source_message_id, kind, created_at)
       VALUES (?, ?, 'mention', ?)`,
    ).run(canonical.id, source.id, "2025-02-01T00:00:00.000Z");
    db.prepare<[number, string, number, string]>(
      `INSERT INTO entity_alias_evidence
         (entity_id, alias, source_message_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(duplicate.id, "coach", source.id, "2025-01-01T00:00:00.000Z");
    const facetId = Number(
      db.prepare<[number, string, number, string, string]>(
        `INSERT INTO understanding_facet
           (kind, statement, scope_kind, scope_entity_id, importance, sensitivity,
            confidence, valid_from, source_message_id, created_at, updated_at)
         VALUES ('relationship_dynamic', 'Values collaboration', 'entity', ?,
                 'normal', 'normal', 0.9, ?, ?, ?, ?)`,
      ).run(
        duplicate.id,
        "2025-01-01T00:00:00.000Z",
        source.id,
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
      ).lastInsertRowid,
    );
    db.prepare<[number, string]>("INSERT INTO facet_fts (rowid, text) VALUES (?, ?)").run(
      facetId,
      "relationship dynamic Values collaboration",
    );

    mergeEntities(db, duplicate.id, canonical.id);

    const entityEvidence = db
      .prepare<[number], { entity_id: number; created_at: string }>(
        `SELECT entity_id, created_at FROM entity_evidence
         WHERE source_message_id = ? AND kind = 'mention'`,
      )
      .all(source.id);
    expect(entityEvidence).toEqual([
      { entity_id: canonical.id, created_at: "2025-01-01T00:00:00.000Z" },
    ]);
    expect(
      db.prepare<[number, string], { source_message_id: number }>(
        `SELECT source_message_id FROM entity_alias_evidence
         WHERE entity_id = ? AND alias = ?`,
      ).all(canonical.id, "coach"),
    ).toEqual([{ source_message_id: source.id }]);
    expect(
      db.prepare<[number], { scope_entity_id: number }>(
        "SELECT scope_entity_id FROM understanding_facet WHERE id = ?",
      ).get(facetId)?.scope_entity_id,
    ).toBe(canonical.id);
    expect(
      db.prepare<[string], { rowid: number }>(
        "SELECT rowid FROM facet_fts WHERE facet_fts MATCH ?",
      ).all("collaboration"),
    ).toEqual([{ rowid: facetId }]);
  });

  it("refuses to merge away the self entity", () => {
    const me = selfEntity(db);
    const other = upsertEntity(db, { name: "Someone", kind: "person" });
    expect(() => mergeEntities(db, me.id, other.id)).toThrow(/self/u);
  });
});

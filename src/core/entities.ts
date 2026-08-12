import type { Db } from "./db";
import { now } from "./db";
import { SELF_SLUG } from "./migrations";
import type { Entity, EntityKind } from "./schema";
import { invalidateWorkPlansForSourceLink } from "./work-plans";

/**
 * Entity resolution. The job here is that "Sarah", "Sarah Chen", and "sarah" are one
 * person, not three — because a memory that splits an entity three ways answers
 * questions with a third of what it knows.
 */

/** Normalize a name for alias matching: lowercase, collapse whitespace, strip edges. */
export function foldAlias(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * kebab-case slug, used as the stable URL and dedup key.
 *
 * The combining-mark strip is load-bearing: NFKD splits "ü" into "u" + U+0308, and
 * without removing the mark the generic non-alphanumeric pass turns it into a dash
 * ("Zürich" → "zu-rich").
 */
export function slugify(raw: string): string {
  const base = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return base || "entity";
}

type EntityRow = Entity;

const SELECT_ENTITY = `
  SELECT entity.id AS id, entity.kind AS kind, entity.name AS name,
         entity.slug AS slug, entity.summary AS summary,
         entity.created_at AS created_at, entity.updated_at AS updated_at
  FROM entity
`;

export function getEntity(db: Db, id: number): Entity | null {
  const row = db
    .prepare<[number], EntityRow>(`${SELECT_ENTITY} WHERE id = ?`)
    .get(id);
  return row ?? null;
}

export function getEntityBySlug(db: Db, slug: string): Entity | null {
  const row = db
    .prepare<[string], EntityRow>(`${SELECT_ENTITY} WHERE slug = ?`)
    .get(slug);
  return row ?? null;
}

/** The entity representing the user. Guaranteed to exist by the seed migration. */
export function selfEntity(db: Db): Entity {
  const entity = getEntityBySlug(db, SELF_SLUG);
  if (!entity) {
    throw new Error(
      "The 'self' entity is missing — the database was not migrated. Call openDb().",
    );
  }
  return entity;
}

export class AmbiguousEntityError extends Error {
  readonly candidates: Entity[];

  constructor(name: string, candidates: Entity[]) {
    super(`Entity reference "${name}" is ambiguous`);
    this.name = "AmbiguousEntityError";
    this.candidates = candidates;
  }
}

export function resolveEntityCandidates(db: Db, name: string): Entity[] {
  const folded = foldAlias(name);
  if (!folded) return [];

  const exact = db
    .prepare<[string, string], EntityRow>(
      `${SELECT_ENTITY} WHERE slug = ? OR lower(name) = ? ORDER BY id`,
    )
    .all(slugify(name), folded);
  if (exact.length > 0) return uniqueEntities(exact);

  return uniqueEntities(
    db
      .prepare<[string], EntityRow>(
        `SELECT e.id, e.kind, e.name, e.slug, e.summary, e.created_at, e.updated_at
         FROM entity e
         JOIN entity_alias a ON a.entity_id = e.id
         WHERE a.alias = ? ORDER BY e.id`,
      )
      .all(folded),
  );
}

/** Find an entity by any known alias, slug, or exact name. Returns null if unknown. */
export function resolveEntity(db: Db, name: string): Entity | null {
  const candidates = resolveEntityCandidates(db, name);
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Bind an alias to an entity.
 *
 * Aliases are globally unique: one alias points at exactly one entity. If the alias is
 * already taken by someone else we skip rather than throw — a second "Sarah" should not
 * crash the extraction pass, it should just keep her fuller name. Returns whether it bound.
 */
export function addAlias(db: Db, entityId: number, alias: string): boolean {
  const folded = foldAlias(alias);
  if (!folded) return false;

  db.prepare<[number, string, string]>(
    "INSERT OR IGNORE INTO entity_alias (entity_id, alias, created_at) VALUES (?, ?, ?)",
  ).run(entityId, folded, now());
  return Boolean(
    db.prepare<[number, string]>(
      "SELECT 1 FROM entity_alias WHERE entity_id = ? AND alias = ?",
    ).get(entityId, folded),
  );
}

export function aliasesOf(db: Db, entityId: number): string[] {
  return db
    .prepare<[number], { alias: string }>(
      "SELECT alias FROM entity_alias WHERE entity_id = ? ORDER BY alias",
    )
    .all(entityId)
    .map((row) => row.alias);
}

/** Claim a free slug, disambiguating collisions as `name-2`, `name-3`, … */
function uniqueSlug(db: Db, name: string): string {
  const base = slugify(name);
  const taken = db.prepare<[string], { slug: string }>(
    "SELECT slug FROM entity WHERE slug = ?",
  );

  if (!taken.get(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.get(candidate)) return candidate;
  }
  throw new Error(`Could not find a free slug for "${name}"`);
}

export type UpsertEntityInput = {
  name: string;
  kind: EntityKind;
  aliases?: readonly string[];
};

/**
 * Find an entity by name/alias, or create it. Always binds the given name and aliases,
 * so the next mention of any of them resolves here.
 */
export function upsertEntity(db: Db, input: UpsertEntityInput): Entity {
  const candidates = resolveEntityCandidates(db, input.name);
  if (candidates.length > 1) throw new AmbiguousEntityError(input.name, candidates);
  const existing = candidates[0] ?? null;

  if (existing) {
    for (const alias of [input.name, ...(input.aliases ?? [])]) {
      addAlias(db, existing.id, alias);
    }
    return existing;
  }

  const timestamp = now();
  const slug = uniqueSlug(db, input.name);
  const result = db
    .prepare<[EntityKind, string, string, string, string]>(
      `INSERT INTO entity (kind, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.kind, input.name.trim(), slug, timestamp, timestamp);

  const id = Number(result.lastInsertRowid);
  for (const alias of [input.name, ...(input.aliases ?? [])]) {
    addAlias(db, id, alias);
  }

  const created = getEntity(db, id);
  if (!created) throw new Error(`Entity ${id} vanished immediately after insert`);
  return created;
}

export function upsertEntityWithEvidence(
  db: Db,
  input: UpsertEntityInput & {
    sourceMessageId: number;
    evidenceKind?: "mention" | "assertion" | "correction";
  },
): Entity {
  const source = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(input.sourceMessageId);
  if (source?.role !== "user") {
    throw new Error("Entity evidence requires a stored user message");
  }
  return db.transaction(() => {
    const entity = upsertEntity(db, input);
    db.prepare<[number, number, string, string]>(
      `INSERT OR IGNORE INTO entity_evidence
         (entity_id, source_message_id, kind, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      entity.id,
      input.sourceMessageId,
      input.evidenceKind ?? "mention",
      now(),
    );
    for (const alias of [input.name, ...(input.aliases ?? [])]) {
      const folded = foldAlias(alias);
      if (!folded) continue;
      addAlias(db, entity.id, folded);
      db.prepare<[number, string, number, string]>(
        `INSERT OR IGNORE INTO entity_alias_evidence
           (entity_id, alias, source_message_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(entity.id, folded, input.sourceMessageId, now());
    }
    return entity;
  })();
}

export function setEntitySummary(db: Db, id: number, summary: string | null): void {
  db.prepare<[string | null, string, number]>(
    "UPDATE entity SET summary = ?, updated_at = ? WHERE id = ?",
  ).run(summary, now(), id);
}

export type ListEntitiesOptions = {
  kind?: EntityKind;
  query?: string;
  limit?: number;
};

export function listEntities(db: Db, options: ListEntitiesOptions = {}): Entity[] {
  const limit = options.limit ?? 200;
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.kind) {
    clauses.push("kind = ?");
    params.push(options.kind);
  }
  if (options.query?.trim()) {
    clauses.push("(lower(name) LIKE ? OR slug LIKE ?)");
    const like = `%${foldAlias(options.query)}%`;
    params.push(like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);

  return db
    .prepare<unknown[], EntityRow>(
      `${SELECT_ENTITY} ${where} ORDER BY name COLLATE NOCASE LIMIT ?`,
    )
    .all(...params);
}

/**
 * Fold `sourceId` into `targetId`: move its facts and aliases, then delete it.
 *
 * The curation UI needs this because extraction will occasionally split one person in
 * two ("Sarah" before her surname is ever mentioned, "Sarah Chen" after). Merging is
 * strictly additive — no fact is dropped.
 */
export function mergeEntities(db: Db, sourceId: number, targetId: number): void {
  if (sourceId === targetId) return;

  const source = getEntity(db, sourceId);
  const target = getEntity(db, targetId);
  if (!source) throw new Error(`Source entity ${sourceId} does not exist`);
  if (!target) throw new Error(`Target entity ${targetId} does not exist`);
  if (source.slug === SELF_SLUG) {
    throw new Error("Refusing to merge away the 'self' entity");
  }

  db.transaction(() => {
    const sourceAliasEvidence = db
      .prepare<
        [number],
        { alias: string; source_message_id: number; created_at: string }
      >(
        `SELECT alias, source_message_id, created_at
         FROM entity_alias_evidence
         WHERE entity_id = ?
         ORDER BY alias, source_message_id`,
      )
      .all(sourceId);
    const affectedFactIds = db
      .prepare<[number, number], { id: number }>(
        `SELECT id FROM fact
         WHERE subject_id = ? OR object_entity_id = ?
         ORDER BY id`,
      )
      .all(sourceId, sourceId)
      .map((row) => row.id);

    reconcileMergedProjects(db, sourceId, targetId, target.kind);

    db.prepare<[number, number]>(
      "UPDATE fact SET subject_id = ? WHERE subject_id = ?",
    ).run(targetId, sourceId);
    db.prepare<[number, number]>(
      "UPDATE fact SET object_entity_id = ? WHERE object_entity_id = ?",
    ).run(targetId, sourceId);
    db.prepare<[number, number]>(
      "UPDATE commitment SET owner_entity_id = ? WHERE owner_entity_id = ?",
    ).run(targetId, sourceId);
    db.prepare<[number, number]>(
      "UPDATE understanding_facet SET scope_entity_id = ? WHERE scope_entity_id = ?",
    ).run(targetId, sourceId);

    reconcileMergedFacts(db, targetId);
    reconcileMergedFacets(db, targetId);

    // Evidence is additive. Re-point unique evidence rows without losing either
    // source when both halves of the merge already cite the same message.
    db.prepare<[number, number]>(
      `INSERT INTO entity_evidence
         (entity_id, source_message_id, kind, created_at)
       SELECT ?, source_message_id, kind, created_at
       FROM entity_evidence WHERE entity_id = ?
       ON CONFLICT (entity_id, source_message_id, kind) DO UPDATE SET
         created_at = MIN(entity_evidence.created_at, excluded.created_at)`,
    ).run(targetId, sourceId);
    db.prepare<[number]>("DELETE FROM entity_evidence WHERE entity_id = ?").run(sourceId);

    // Subject names participate in lexical and semantic fact text. Rebuild every
    // fact touched by the merge (including incoming graph edges) and discard its
    // now-stale vector so the normal reindex backlog can regenerate it.
    const readFact = db.prepare<
      [number],
      { id: number; subject_name: string; predicate: string; object: string }
    >(
      `SELECT f.id, e.name AS subject_name, f.predicate, f.object
       FROM fact f JOIN entity e ON e.id = f.subject_id
       WHERE f.id = ?`,
    );
    const deleteFactFts = db.prepare<[number]>("DELETE FROM fact_fts WHERE rowid = ?");
    const insertFactFts = db.prepare<[number, string]>(
      "INSERT INTO fact_fts (rowid, text) VALUES (?, ?)",
    );
    const deleteFactEmbedding = db.prepare<[number]>(
      "DELETE FROM embedding WHERE owner_kind = 'fact' AND owner_id = ?",
    );
    for (const factId of affectedFactIds) {
      const fact = readFact.get(factId);
      if (!fact) continue;
      deleteFactFts.run(factId);
      insertFactFts.run(
        factId,
        `${fact.subject_name} ${fact.predicate.replace(/_/gu, " ")} ${fact.object}`,
      );
      deleteFactEmbedding.run(factId);
    }

    // Re-point aliases individually. Aliases may now be ambiguous across unrelated
    // entities, so delete only the source binding and preserve all evidence attached
    // to the binding being moved.
    for (const alias of aliasesOf(db, sourceId)) {
      db.prepare<[number, string]>(
        "DELETE FROM entity_alias WHERE entity_id = ? AND alias = ?",
      ).run(sourceId, alias);
      db.prepare<[number, string, string]>(
        `INSERT OR IGNORE INTO entity_alias (entity_id, alias, created_at)
         VALUES (?, ?, ?)`,
      ).run(targetId, alias, now());
      const evidenceRows = sourceAliasEvidence.filter((entry) => entry.alias === alias);
      const insertEvidence = db.prepare<[number, string, number, string]>(
        `INSERT INTO entity_alias_evidence
           (entity_id, alias, source_message_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (entity_id, alias, source_message_id) DO UPDATE SET
           created_at = MIN(entity_alias_evidence.created_at, excluded.created_at)`,
      );
      for (const evidence of evidenceRows) {
        insertEvidence.run(targetId, alias, evidence.source_message_id, evidence.created_at);
      }
    }

    db.prepare<[number, number]>(
      "DELETE FROM embedding WHERE owner_kind = 'entity' AND owner_id IN (?, ?)",
    ).run(sourceId, targetId);
    db.prepare<[number]>("DELETE FROM entity WHERE id = ?").run(sourceId);
    db.prepare<[string, number]>("UPDATE entity SET updated_at = ? WHERE id = ?").run(
      now(),
      targetId,
    );
  })();
}

/**
 * Reconcile the lifecycle row attached to a project entity before the duplicate
 * entity is removed. A project is keyed one-to-one to its entity, so the simple
 * foreign-key update works only when the canonical entity does not already own a
 * lifecycle. When both sides do, retain the canonical project's stable id, append
 * both event histories to it, repoint every durable project link, and use the most
 * recently updated projection as the current view.
 *
 * Event rows are intentionally not rewritten or deduplicated: their source messages
 * and detail snapshots are provenance, including the identity under which an event
 * was originally recorded.
 */
function reconcileMergedProjects(
  db: Db,
  sourceEntityId: number,
  targetEntityId: number,
  targetKind: EntityKind,
): void {
  type ProjectProjection = {
    id: number;
    status: string;
    progress_summary: string | null;
    progress_percent: number | null;
    blocked_at: string | null;
    confidence: number;
    updated_at: string;
    closed_at: string | null;
  };
  const read = db.prepare<[number], ProjectProjection>(
    `SELECT id, status, progress_summary, progress_percent, blocked_at,
            confidence, updated_at, closed_at
     FROM project WHERE entity_id = ?`,
  );
  const sourceProject = read.get(sourceEntityId);
  if (!sourceProject) return;
  if (targetKind !== "project") {
    throw new Error("A project lifecycle can only be merged into a project entity");
  }

  const targetProject = read.get(targetEntityId);
  if (!targetProject) {
    db.prepare<[number, number]>(
      "UPDATE project SET entity_id = ? WHERE entity_id = ?",
    ).run(targetEntityId, sourceEntityId);
    return;
  }

  db.prepare<[number, number]>(
    "UPDATE goal SET project_id = ? WHERE project_id = ?",
  ).run(targetProject.id, sourceProject.id);
  db.prepare<[number, number]>(
    "UPDATE commitment SET project_id = ? WHERE project_id = ?",
  ).run(targetProject.id, sourceProject.id);
  invalidateWorkPlansForSourceLink(db, "project", sourceProject.id);
  db.prepare<[number, number]>(
    "UPDATE work_plan SET source_project_id = ? WHERE source_project_id = ?",
  ).run(targetProject.id, sourceProject.id);
  db.prepare<[number, number]>(
    "UPDATE project_event SET project_id = ? WHERE project_id = ?",
  ).run(targetProject.id, sourceProject.id);

  const sourceIsNewer =
    sourceProject.updated_at > targetProject.updated_at ||
    (sourceProject.updated_at === targetProject.updated_at &&
      sourceProject.id > targetProject.id);
  if (sourceIsNewer) {
    db.prepare<[
      string,
      string | null,
      number | null,
      string | null,
      number,
      string,
      string | null,
      number,
    ]>(
      `UPDATE project
       SET status = ?, progress_summary = ?, progress_percent = ?, blocked_at = ?,
           confidence = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
    ).run(
      sourceProject.status,
      sourceProject.progress_summary,
      sourceProject.progress_percent,
      sourceProject.blocked_at,
      sourceProject.confidence,
      sourceProject.updated_at,
      sourceProject.closed_at,
      targetProject.id,
    );
  }

  db.prepare<[number]>("DELETE FROM project WHERE id = ?").run(sourceProject.id);
}

function reconcileMergedFacts(db: Db, entityId: number): void {
  type FactRow = {
    id: number;
    subject_id: number;
    predicate: string;
    object: string;
    object_entity_id: number | null;
    confidence: number;
    valid_from: string;
    assertion_count: number;
    last_seen_at: string;
  };
  const live = db
    .prepare<[number, number], FactRow>(
      `SELECT id, subject_id, predicate, object, object_entity_id, confidence,
              valid_from, assertion_count, last_seen_at
       FROM fact
       WHERE valid_to IS NULL AND (subject_id = ? OR object_entity_id = ?)
       ORDER BY id`,
    )
    .all(entityId, entityId);
  const exactGroups = new Map<string, FactRow[]>();
  for (const fact of live) {
    const objectKey = fact.object_entity_id === null
      ? `text:${foldAlias(fact.object)}`
      : `entity:${fact.object_entity_id}`;
    const key = `${fact.subject_id}\u0000${fact.predicate}\u0000${objectKey}`;
    exactGroups.set(key, [...(exactGroups.get(key) ?? []), fact]);
  }

  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareTemporalFact);
    const winner = ordered.at(-1)!;
    for (const loser of ordered.slice(0, -1)) mergeDuplicateFact(db, loser, winner);
  }

  const remaining = db
    .prepare<[number], FactRow & { cardinality: string }>(
      `SELECT f.id, f.subject_id, f.predicate, f.object, f.object_entity_id,
              f.confidence, f.valid_from, f.assertion_count, f.last_seen_at,
              p.cardinality
       FROM fact f
       JOIN predicate p ON p.name = f.predicate
       WHERE f.valid_to IS NULL AND f.subject_id = ? AND p.cardinality = 'single'
       ORDER BY f.id`,
    )
    .all(entityId);
  const singleGroups = new Map<string, FactRow[]>();
  for (const fact of remaining) {
    const key = `${fact.subject_id}\u0000${fact.predicate}`;
    singleGroups.set(key, [...(singleGroups.get(key) ?? []), fact]);
  }
  for (const group of singleGroups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareTemporalFact);
    const winner = ordered.at(-1)!;
    for (const stale of ordered.slice(0, -1)) {
      const validTo = winner.valid_from < stale.valid_from
        ? stale.valid_from
        : winner.valid_from;
      db.prepare<[string, number, number]>(
        "UPDATE fact SET valid_to = ?, superseded_by = ? WHERE id = ?",
      ).run(validTo, winner.id, stale.id);
    }
  }
}

function compareTemporalFact(
  left: { id: number; valid_from: string },
  right: { id: number; valid_from: string },
): number {
  return left.valid_from.localeCompare(right.valid_from) || left.id - right.id;
}

function mergeDuplicateFact(
  db: Db,
  loser: {
    id: number;
    confidence: number;
    assertion_count: number;
    last_seen_at: string;
  },
  winner: {
    id: number;
    confidence: number;
    assertion_count: number;
    last_seen_at: string;
  },
): void {
  db.prepare<[number, number]>(
    `INSERT INTO fact_evidence
       (fact_id, source_message_id, passage_id, kind, confidence, created_at)
     SELECT ?, source_message_id, passage_id, kind, confidence, created_at
     FROM fact_evidence WHERE fact_id = ?
     ON CONFLICT (fact_id, source_message_id) DO UPDATE SET
       confidence = MAX(fact_evidence.confidence, excluded.confidence),
       passage_id = COALESCE(fact_evidence.passage_id, excluded.passage_id)`,
  ).run(winner.id, loser.id);
  db.prepare<[number, number]>(
    "UPDATE fact SET superseded_by = ? WHERE superseded_by = ?",
  ).run(winner.id, loser.id);
  db.prepare<[number, number, string, number]>(
    `UPDATE fact
     SET confidence = ?, assertion_count = ?, last_seen_at = ?
     WHERE id = ?`,
  ).run(
    Math.max(winner.confidence, loser.confidence),
    winner.assertion_count + loser.assertion_count,
    winner.last_seen_at > loser.last_seen_at ? winner.last_seen_at : loser.last_seen_at,
    winner.id,
  );
  db.prepare<[number]>("DELETE FROM fact_fts WHERE rowid = ?").run(loser.id);
  db.prepare<[number]>(
    "DELETE FROM embedding WHERE owner_kind = 'fact' AND owner_id = ?",
  ).run(loser.id);
  db.prepare<[number]>("DELETE FROM fact WHERE id = ?").run(loser.id);
}

function reconcileMergedFacets(db: Db, entityId: number): void {
  type FacetRow = {
    id: number;
    kind: string;
    statement: string;
    condition_text: string | null;
    confidence: number;
  };
  const facets = db
    .prepare<[number], FacetRow>(
      `SELECT id, kind, statement, condition_text, confidence
       FROM understanding_facet
       WHERE scope_entity_id = ? AND valid_to IS NULL
       ORDER BY id`,
    )
    .all(entityId);
  const groups = new Map<string, FacetRow[]>();
  for (const facet of facets) {
    const key = `${facet.kind}\u0000${foldAlias(facet.statement)}\u0000${foldAlias(facet.condition_text ?? "")}`;
    groups.set(key, [...(groups.get(key) ?? []), facet]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = group.at(-1)!;
    for (const loser of group.slice(0, -1)) {
      db.prepare<[number, number]>(
        `INSERT INTO facet_evidence
           (facet_id, passage_id, kind, confidence, created_at)
         SELECT ?, passage_id, kind, confidence, created_at
         FROM facet_evidence WHERE facet_id = ?
         ON CONFLICT (facet_id, passage_id) DO UPDATE SET
           confidence = MAX(facet_evidence.confidence, excluded.confidence)`,
      ).run(winner.id, loser.id);
      db.prepare<[number, number]>(
        "UPDATE facet_event SET facet_id = ? WHERE facet_id = ?",
      ).run(winner.id, loser.id);
      db.prepare<[number, number]>(
        "UPDATE understanding_facet SET superseded_by = ? WHERE superseded_by = ?",
      ).run(winner.id, loser.id);
      db.prepare<[number]>("DELETE FROM facet_fts WHERE rowid = ?").run(loser.id);
      db.prepare<[number]>("DELETE FROM facet_embedding WHERE facet_id = ?").run(loser.id);
      db.prepare<[number]>("DELETE FROM understanding_facet WHERE id = ?").run(loser.id);
      db.prepare<[number, number]>(
        "UPDATE understanding_facet SET confidence = MAX(confidence, ?) WHERE id = ?",
      ).run(loser.confidence, winner.id);
    }
  }
}

function uniqueEntities(entities: readonly Entity[]): Entity[] {
  return [...new Map(entities.map((entity) => [entity.id, entity])).values()];
}

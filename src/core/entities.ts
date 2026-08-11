import type { Db } from "./db";
import { now } from "./db";
import { SELF_SLUG } from "./migrations";
import type { Entity, EntityKind } from "./schema";

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
  SELECT id, kind, name, slug, summary, created_at, updated_at FROM entity
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

/** Find an entity by any known alias, slug, or exact name. Returns null if unknown. */
export function resolveEntity(db: Db, name: string): Entity | null {
  const folded = foldAlias(name);
  if (!folded) return null;

  const byAlias = db
    .prepare<[string], EntityRow>(
      `${SELECT_ENTITY} WHERE id = (SELECT entity_id FROM entity_alias WHERE alias = ?)`,
    )
    .get(folded);
  if (byAlias) return byAlias;

  const bySlug = getEntityBySlug(db, slugify(name));
  if (bySlug) return bySlug;

  return (
    db
      .prepare<[string], EntityRow>(`${SELECT_ENTITY} WHERE lower(name) = ?`)
      .get(folded) ?? null
  );
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

  const existing = db
    .prepare<[string], { entity_id: number }>(
      "SELECT entity_id FROM entity_alias WHERE alias = ?",
    )
    .get(folded);

  if (existing) return existing.entity_id === entityId;

  db.prepare<[number, string, string]>(
    "INSERT INTO entity_alias (entity_id, alias, created_at) VALUES (?, ?, ?)",
  ).run(entityId, folded, now());
  return true;
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
  const existing = resolveEntity(db, input.name);

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
    db.prepare<[number, number]>(
      "UPDATE fact SET subject_id = ? WHERE subject_id = ?",
    ).run(targetId, sourceId);
    db.prepare<[number, number]>(
      "UPDATE fact SET object_entity_id = ? WHERE object_entity_id = ?",
    ).run(targetId, sourceId);

    // Re-point aliases individually so a collision with the target's existing
    // aliases is skipped rather than aborting the whole merge.
    for (const alias of aliasesOf(db, sourceId)) {
      db.prepare<[string]>("DELETE FROM entity_alias WHERE alias = ?").run(alias);
      addAlias(db, targetId, alias);
    }

    db.prepare<[number]>("DELETE FROM embedding WHERE owner_kind = 'entity' AND owner_id = ?").run(
      sourceId,
    );
    db.prepare<[number]>("DELETE FROM entity WHERE id = ?").run(sourceId);
    db.prepare<[string, number]>("UPDATE entity SET updated_at = ? WHERE id = ?").run(
      now(),
      targetId,
    );
  })();
}

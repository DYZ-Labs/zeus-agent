import type { Db } from "./db";
import { now } from "./db";
import { foldAlias } from "./entities";
import type { Cardinality, EvidenceKind, Fact, FactEvidence, FactView } from "./schema";

/**
 * Facts: atomic assertions with provenance and a validity window.
 *
 * The single most important property here is that nothing in the write path ever
 * destroys a fact. Superseding sets `valid_to` and links `superseded_by`, so
 * "where do I work?" and "where did I work before?" are both answerable. Only an
 * explicit user action (`forgetFact`) removes a row.
 */

// ---------------------------------------------------------------------------
// Predicate registry
// ---------------------------------------------------------------------------

export type Predicate = {
  name: string;
  cardinality: Cardinality;
  description: string | null;
  created_at: string;
};

export function getPredicate(db: Db, name: string): Predicate | null {
  return (
    db
      .prepare<[string], Predicate>(
        "SELECT name, cardinality, description, created_at FROM predicate WHERE name = ?",
      )
      .get(name) ?? null
  );
}

/**
 * Register a predicate if it is new.
 *
 * Unknown predicates default to `multi`, which is the non-destructive choice: a new
 * value sits alongside the old one instead of closing it. Promoting a predicate to
 * `single` is a deliberate, reviewable act — never something extraction does implicitly.
 */
export function ensurePredicate(db: Db, name: string): Predicate {
  const existing = getPredicate(db, name);
  if (existing) return existing;

  db.prepare<[string, string]>(
    "INSERT INTO predicate (name, cardinality, created_at) VALUES (?, 'multi', ?)",
  ).run(name, now());

  const created = getPredicate(db, name);
  if (!created) throw new Error(`Predicate "${name}" vanished after insert`);
  return created;
}

export function setPredicateCardinality(db: Db, name: string, cardinality: Cardinality): void {
  ensurePredicate(db, name);
  db.prepare<[Cardinality, string]>(
    "UPDATE predicate SET cardinality = ? WHERE name = ?",
  ).run(cardinality, name);
}

export function listPredicates(db: Db): Predicate[] {
  return db
    .prepare<[], Predicate>(
      "SELECT name, cardinality, description, created_at FROM predicate ORDER BY name",
    )
    .all();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SELECT_FACT_VIEW = `
  SELECT
    f.id, f.subject_id, f.predicate, f.object, f.object_entity_id,
    f.confidence, f.valid_from, f.valid_to, f.superseded_by,
    f.source_message_id, f.assertion_count, f.last_seen_at, f.created_at,
    s.name  AS subject_name,
    s.slug  AS subject_slug,
    o.name  AS object_entity_name,
    o.slug  AS object_entity_slug
  FROM fact f
  JOIN entity s ON s.id = f.subject_id
  LEFT JOIN entity o ON o.id = f.object_entity_id
`;

export function getFact(db: Db, id: number): FactView | null {
  return db.prepare<[number], FactView>(`${SELECT_FACT_VIEW} WHERE f.id = ?`).get(id) ?? null;
}

export function getFacts(db: Db, ids: readonly number[]): FactView[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare<number[], FactView>(`${SELECT_FACT_VIEW} WHERE f.id IN (${placeholders})`)
    .all(...ids);
}

export function evidenceForFact(db: Db, factId: number): FactEvidence[] {
  return db
    .prepare<[number], FactEvidence>(
      `SELECT id, fact_id, source_message_id, kind, confidence, created_at
       FROM fact_evidence WHERE fact_id = ? ORDER BY created_at, id`,
    )
    .all(factId);
}

/** Attach provenance for an explicit curation action before changing fact state. */
export function addFactEvidence(
  db: Db,
  factId: number,
  sourceMessageId: number,
  kind: EvidenceKind = "correction",
  confidence = 1,
): void {
  if (!getFact(db, factId)) throw new Error(`Fact ${factId} does not exist`);
  recordEvidence(db, factId, sourceMessageId, kind, clampConfidence(confidence), now());
}

export type FactsForEntityOptions = {
  /** Include facts that have been superseded. Default false. */
  includeSuperseded?: boolean;
  /** Also include facts where this entity is the *object* (reverse graph edges). */
  includeIncoming?: boolean;
  limit?: number;
};

export function factsForEntity(
  db: Db,
  entityId: number,
  options: FactsForEntityOptions = {},
): FactView[] {
  const live = options.includeSuperseded ? "" : "AND f.valid_to IS NULL";
  const subjectClause = options.includeIncoming
    ? "(f.subject_id = ? OR f.object_entity_id = ?)"
    : "f.subject_id = ?";
  const params: number[] = options.includeIncoming ? [entityId, entityId] : [entityId];
  params.push(options.limit ?? 500);

  return db
    .prepare<number[], FactView>(
      `${SELECT_FACT_VIEW}
       WHERE ${subjectClause} ${live}
       ORDER BY f.valid_to IS NULL DESC, f.confidence DESC, f.last_seen_at DESC
       LIMIT ?`,
    )
    .all(...params);
}

/** Facts that are currently true for a subject+predicate pair. */
export function liveFacts(db: Db, subjectId: number, predicate: string): FactView[] {
  return db
    .prepare<[number, string], FactView>(
      `${SELECT_FACT_VIEW}
       WHERE f.subject_id = ? AND f.predicate = ? AND f.valid_to IS NULL
       ORDER BY f.last_seen_at DESC`,
    )
    .all(subjectId, predicate);
}

export type TimelineOptions = {
  since?: string;
  until?: string;
  limit?: number;
};

/** Facts in the order Zeus learned them — the "what changed when" view. */
export function timeline(db: Db, options: TimelineOptions = {}): FactView[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.since) {
    clauses.push("f.created_at >= ?");
    params.push(options.since);
  }
  if (options.until) {
    clauses.push("f.created_at <= ?");
    params.push(options.until);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? 200);

  return db
    .prepare<unknown[], FactView>(
      `${SELECT_FACT_VIEW} ${where} ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
    )
    .all(...params);
}

export function countFacts(db: Db): { live: number; superseded: number } {
  const row = db
    .prepare<[], { live: number; superseded: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE valid_to IS NULL)     AS live,
         COUNT(*) FILTER (WHERE valid_to IS NOT NULL) AS superseded
       FROM fact`,
    )
    .get();
  return row ?? { live: 0, superseded: 0 };
}

// ---------------------------------------------------------------------------
// Full-text index
// ---------------------------------------------------------------------------

/** The indexed form of a fact: "Sarah Chen works at Acme". */
export function factSearchText(subjectName: string, predicate: string, object: string): string {
  return `${subjectName} ${predicate.replace(/_/gu, " ")} ${object}`;
}

function indexFact(db: Db, factId: number, text: string): void {
  db.prepare<[number]>("DELETE FROM fact_fts WHERE rowid = ?").run(factId);
  db.prepare<[number, string]>("INSERT INTO fact_fts (rowid, text) VALUES (?, ?)").run(
    factId,
    text,
  );
}

function unindexFact(db: Db, factId: number): void {
  db.prepare<[number]>("DELETE FROM fact_fts WHERE rowid = ?").run(factId);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type RecordFactInput = {
  subjectId: number;
  predicate: string;
  object: string;
  objectEntityId?: number | null;
  /** 0-1. Defaults to 0.8, the "user said it plainly but we did not verify" level. */
  confidence?: number;
  sourceMessageId?: number | null;
  /** When the fact became true. Defaults to when Zeus learned it. */
  validFrom?: string | null;
  evidenceKind?: EvidenceKind;
};

export type RecordFactResult = {
  fact: FactView;
  /** `reasserted` means an identical live fact already existed and was reinforced. */
  outcome: "inserted" | "reasserted";
  /** Ids of facts this write closed. Empty for multi-valued predicates. */
  supersededIds: number[];
};

/**
 * Write a fact, applying supersession.
 *
 * Three outcomes:
 *  - An identical live fact exists → reinforce it (bump `assertion_count`, nudge
 *    confidence). Repetition is evidence, not duplication.
 *  - The predicate is single-valued and the value changed → close the old facts and
 *    insert the new one, linked by `superseded_by`.
 *  - Otherwise → insert alongside.
 *
 * Cardinality alone decides closure. Extraction's `supersedes_previous` hint is
 * deliberately *not* wired to destruction here: a wrong hint on a multi-valued
 * predicate would silently retire true facts, and the cost of that is much higher
 * than the cost of a stale one the user can close from /memory.
 */
export function recordFact(db: Db, input: RecordFactInput): RecordFactResult {
  const predicate = ensurePredicate(db, input.predicate);
  const timestamp = now();
  const confidence = clampConfidence(input.confidence ?? 0.8);
  const object = input.object.trim();

  if (!object) throw new Error("Refusing to record a fact with an empty object");

  const subject = db
    .prepare<[number], { name: string }>("SELECT name FROM entity WHERE id = ?")
    .get(input.subjectId);
  if (!subject) throw new Error(`Subject entity ${input.subjectId} does not exist`);

  return db.transaction((): RecordFactResult => {
    // 1. Already known and still true? Reinforce rather than duplicate.
    const duplicate = liveFacts(db, input.subjectId, predicate.name).find(
      (candidate) =>
        foldAlias(candidate.object) === foldAlias(object) ||
        (candidate.object_entity_id !== null &&
          input.objectEntityId !== null &&
          input.objectEntityId !== undefined &&
          candidate.object_entity_id === input.objectEntityId),
    );

    if (duplicate) {
      const alreadyEvidenced =
        input.sourceMessageId !== null &&
        input.sourceMessageId !== undefined &&
        db
          .prepare<[number, number], { found: number }>(
            `SELECT 1 AS found FROM fact_evidence
             WHERE fact_id = ? AND source_message_id = ?`,
          )
          .get(duplicate.id, input.sourceMessageId) !== undefined;
      if (!alreadyEvidenced) {
        const boosted = clampConfidence(Math.max(duplicate.confidence, confidence) + 0.02);
        db.prepare<[string, number, number]>(
          `UPDATE fact
           SET assertion_count = assertion_count + 1, last_seen_at = ?, confidence = ?
           WHERE id = ?`,
        ).run(timestamp, boosted, duplicate.id);
      }

      recordEvidence(
        db,
        duplicate.id,
        input.sourceMessageId ?? null,
        input.evidenceKind === "correction" ? "correction" : "reassertion",
        confidence,
        timestamp,
      );

      const refreshed = getFact(db, duplicate.id);
      if (!refreshed) throw new Error(`Fact ${duplicate.id} vanished during reassertion`);
      return { fact: refreshed, outcome: "reasserted", supersededIds: [] };
    }

    // 2. Insert the new fact.
    const validFrom = normalizeDate(input.validFrom) ?? timestamp;
    const inserted = db
      .prepare<
        [number, string, string, number | null, number, string, number | null, string, string]
      >(
        `INSERT INTO fact
           (subject_id, predicate, object, object_entity_id, confidence,
            valid_from, source_message_id, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.subjectId,
        predicate.name,
        object,
        input.objectEntityId ?? null,
        confidence,
        validFrom,
        input.sourceMessageId ?? null,
        timestamp,
        timestamp,
      );

    const factId = Number(inserted.lastInsertRowid);
    indexFact(db, factId, factSearchText(subject.name, predicate.name, object));
    recordEvidence(
      db,
      factId,
      input.sourceMessageId ?? null,
      input.evidenceKind ?? "assertion",
      confidence,
      timestamp,
    );

    // 3. Close prior values, but only for single-valued predicates.
    const supersededIds: number[] = [];
    if (predicate.cardinality === "single") {
      const stale = db
        .prepare<[number, string, number], { id: number }>(
          `SELECT id FROM fact
           WHERE subject_id = ? AND predicate = ? AND valid_to IS NULL AND id != ?`,
        )
        .all(input.subjectId, predicate.name, factId);

      const close = db.prepare<[string, number, number]>(
        "UPDATE fact SET valid_to = ?, superseded_by = ? WHERE id = ?",
      );
      for (const row of stale) {
        close.run(timestamp, factId, row.id);
        supersededIds.push(row.id);
      }
    }

    const fact = getFact(db, factId);
    if (!fact) throw new Error(`Fact ${factId} vanished immediately after insert`);
    return { fact, outcome: "inserted", supersededIds };
  })();
}

function recordEvidence(
  db: Db,
  factId: number,
  sourceMessageId: number | null,
  kind: EvidenceKind,
  confidence: number,
  timestamp: string,
): void {
  if (sourceMessageId === null) return;
  db.prepare<[number, number, EvidenceKind, number, string]>(
    `INSERT INTO fact_evidence
       (fact_id, source_message_id, kind, confidence, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (fact_id, source_message_id) DO UPDATE SET
       kind = excluded.kind,
       confidence = MAX(fact_evidence.confidence, excluded.confidence)`,
  ).run(factId, sourceMessageId, kind, confidence, timestamp);
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0.01, value));
}

/** Close a fact by hand — the curation UI's "this is no longer true" action. */
export function supersedeFact(db: Db, id: number, supersededBy: number | null = null): void {
  db.prepare<[string, number | null, number]>(
    "UPDATE fact SET valid_to = ?, superseded_by = ? WHERE id = ? AND valid_to IS NULL",
  ).run(now(), supersededBy, id);
}

export type CorrectFactInput = {
  object?: string;
  confidence?: number;
  objectEntityId?: number | null;
  validFrom?: string | null;
  sourceMessageId: number;
};

/**
 * Correct a fact by inserting a sourced replacement and closing the old assertion.
 * The original wording and provenance remain readable as history.
 */
export function correctFact(db: Db, id: number, input: CorrectFactInput): FactView | null {
  const existing = getFact(db, id);
  if (!existing) return null;

  const object = input.object?.trim() || existing.object;
  if (foldAlias(object) === foldAlias(existing.object)) return existing;

  const replacement = recordFact(db, {
    subjectId: existing.subject_id,
    predicate: existing.predicate,
    object,
    confidence: input.confidence ?? existing.confidence,
    objectEntityId:
      input.objectEntityId === undefined ? existing.object_entity_id : input.objectEntityId,
    validFrom: input.validFrom,
    sourceMessageId: input.sourceMessageId,
    evidenceKind: "correction",
  }).fact;
  if (replacement.id !== existing.id) supersedeFact(db, existing.id, replacement.id);
  return replacement;
}

/**
 * Permanently remove a fact. The one destructive operation in this module, reachable
 * only from an explicit user action — never from extraction. "Make it forget this"
 * has to actually work, or the memory is not trustworthy.
 */
export function forgetFact(db: Db, id: number): boolean {
  return db.transaction((): boolean => {
    unindexFact(db, id);
    db.prepare<[number]>(
      "DELETE FROM embedding WHERE owner_kind = 'fact' AND owner_id = ?",
    ).run(id);
    db.prepare<[number]>(
      "DELETE FROM response_context WHERE item_kind = 'fact' AND item_id = ?",
    ).run(id);
    db.prepare<[number]>("UPDATE fact SET superseded_by = NULL WHERE superseded_by = ?").run(id);
    const result = db.prepare<[number]>("DELETE FROM fact WHERE id = ?").run(id);
    return result.changes > 0;
  })();
}

/** Rebuild the FTS index from scratch. Used by `scripts/reindex.ts`. */
export function reindexFacts(db: Db): number {
  const rows = db
    .prepare<[], { id: number; predicate: string; object: string; subject_name: string }>(
      `SELECT f.id, f.predicate, f.object, s.name AS subject_name
       FROM fact f JOIN entity s ON s.id = f.subject_id`,
    )
    .all();

  db.transaction(() => {
    db.exec("DELETE FROM fact_fts");
    const insert = db.prepare<[number, string]>(
      "INSERT INTO fact_fts (rowid, text) VALUES (?, ?)",
    );
    for (const row of rows) {
      insert.run(row.id, factSearchText(row.subject_name, row.predicate, row.object));
    }
  })();

  return rows.length;
}

export type { Fact };

import type { Db } from "./db";
import { now } from "./db";
import { getMessage } from "./conversations";
import { embed, loadFacetVectors, nearest } from "./embed";
import { allowPassage, getPassage } from "./passages";
import { toFtsQuery } from "./search";
import type {
  FacetEvidence,
  FacetImportance,
  FacetKind,
  FacetMachineEffect,
  FacetScope,
  FacetScopeKind,
  FacetSensitivity,
  UnderstandingFacet,
  UnderstandingFacetView,
} from "./schema";

export type {
  FacetEvidence,
  FacetImportance,
  FacetKind,
  FacetMachineEffect,
  FacetScope,
  FacetScopeKind,
  FacetSensitivity,
  UnderstandingFacet,
  UnderstandingFacetView,
} from "./schema";

export const FACET_KINDS = [
  "value",
  "decision_criterion",
  "constraint",
  "preference",
  "motivation",
  "routine",
  "communication_style",
  "working_style",
  "boundary",
  "capacity_pattern",
  "skill",
  "relationship_dynamic",
] as const;

export type FacetScopeInput = FacetScope;

export type RecordFacetInput = {
  kind: FacetKind;
  statement: string;
  scope?: FacetScopeInput;
  condition?: string | null;
  importance?: FacetImportance;
  sensitivity?: FacetSensitivity;
  confidence?: number;
  machineEffect?: FacetMachineEffect | null;
  validFrom?: string | null;
  sourceMessageId: number;
  passageIds: readonly number[];
  evidenceKind?: FacetEvidence["kind"];
  sourceKind?: "message" | "user_action" | "system";
  /** Corrections always create a new temporal version, even when only policy fields change. */
  forceNewVersion?: boolean;
};

export type FacetSearchHit = {
  facet: UnderstandingFacetView;
  score: number;
  via: readonly ("lexical" | "semantic" | "core")[];
};

const SELECT_FACET = `
  SELECT f.id, f.kind, f.statement, f.scope_kind, f.scope_label,
         f.scope_entity_id, f.scope_goal_id, f.scope_commitment_id,
         f.condition_text, f.importance, f.sensitivity, f.confidence,
         f.machine_effect, f.valid_from, f.valid_to, f.superseded_by,
         f.source_message_id, f.created_at, f.updated_at,
         e.name AS scope_entity_name, e.slug AS scope_entity_slug,
         g.title AS scope_goal_title, c.title AS scope_commitment_title
  FROM understanding_facet f
  LEFT JOIN entity e ON e.id = f.scope_entity_id
  LEFT JOIN goal g ON g.id = f.scope_goal_id
  LEFT JOIN commitment c ON c.id = f.scope_commitment_id
`;

export function getFacet(db: Db, id: number): UnderstandingFacetView | null {
  return (
    db.prepare<[number], UnderstandingFacetView>(`${SELECT_FACET} WHERE f.id = ?`).get(id) ??
    null
  );
}

export function listFacets(
  db: Db,
  options: {
    includeClosed?: boolean;
    kinds?: readonly FacetKind[];
    limit?: number;
  } = {},
): UnderstandingFacetView[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (!options.includeClosed) clauses.push("f.valid_to IS NULL");
  if (options.kinds?.length) {
    clauses.push(`f.kind IN (${options.kinds.map(() => "?").join(",")})`);
    params.push(...options.kinds);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? 500);
  return db
    .prepare<Array<string | number>, UnderstandingFacetView>(
      `${SELECT_FACET} ${where}
       ORDER BY f.valid_to IS NULL DESC,
                CASE f.importance WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                f.updated_at DESC, f.id DESC
       LIMIT ?`,
    )
    .all(...params);
}

export function evidenceForFacet(db: Db, facetId: number): FacetEvidence[] {
  return db
    .prepare<[number], FacetEvidence>(
      `SELECT fe.id, fe.facet_id, fe.passage_id, fe.kind, fe.confidence,
              fe.created_at, p.message_id AS source_message_id, p.text AS quote,
              p.start_offset, p.end_offset
       FROM facet_evidence fe
       JOIN evidence_passage p ON p.id = fe.passage_id
       WHERE fe.facet_id = ?
       ORDER BY fe.id`,
    )
    .all(facetId);
}

export function recordFacet(db: Db, input: RecordFacetInput): UnderstandingFacetView {
  const statement = input.statement.replace(/\s+/gu, " ").trim();
  if (!statement) throw new Error("Refusing to record an empty understanding facet");
  if (input.passageIds.length === 0) {
    throw new Error("Every understanding facet requires claim-level evidence");
  }
  const source = getMessage(db, input.sourceMessageId);
  if (!source || source.role !== "user") {
    throw new Error("Understanding facet source must be a stored user message");
  }
  const passages = input.passageIds.map((id) => getPassage(db, id));
  if (passages.some((passage) => passage === null)) {
    throw new Error("Understanding facet references an unknown evidence passage");
  }
  if (!passages.some((passage) => passage?.message_id === input.sourceMessageId)) {
    throw new Error("Initial understanding evidence must include the source message");
  }

  const scope = scopeColumns(input.scope ?? { kind: "global" });
  validateScopeTarget(db, input.scope ?? { kind: "global" });
  const duplicate = input.forceNewVersion
    ? null
    : findMatchingLiveFacet(db, {
        kind: input.kind,
        statement,
        ...scope,
      });

  return db.transaction((): UnderstandingFacetView => {
    if (duplicate) {
      for (const passage of passages) {
        if (passage) {
          addFacetEvidence(
            db,
            duplicate.id,
            passage.id,
            input.evidenceKind ?? "assertion",
            input.confidence ?? 0.9,
          );
          if (input.sensitivity === "sensitive") allowPassage(db, passage.id);
        }
      }
      db.prepare<[number, string, number]>(
        `UPDATE understanding_facet
         SET confidence = MIN(1, MAX(confidence, ?)), updated_at = ?
         WHERE id = ?`,
      ).run(clamp(input.confidence ?? 0.9), now(), duplicate.id);
      return getFacet(db, duplicate.id) ?? duplicate;
    }

    const timestamp = now();
    const validFrom = normalizeDate(input.validFrom) ?? timestamp;
    const result = db
      .prepare<[
        FacetKind,
        string,
        FacetScopeKind,
        string | null,
        number | null,
        number | null,
        number | null,
        string | null,
        FacetImportance,
        FacetSensitivity,
        number,
        FacetMachineEffect | null,
        string,
        number,
        string,
        string,
      ]>(
        `INSERT INTO understanding_facet
           (kind, statement, scope_kind, scope_label, scope_entity_id,
            scope_goal_id, scope_commitment_id, condition_text, importance,
            sensitivity, confidence, machine_effect, valid_from,
            source_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        statement,
        scope.scope_kind,
        scope.scope_label,
        scope.scope_entity_id,
        scope.scope_goal_id,
        scope.scope_commitment_id,
        input.condition?.trim() || null,
        input.importance ?? "normal",
        input.sensitivity ?? "normal",
        clamp(input.confidence ?? 0.9),
        input.machineEffect ?? null,
        validFrom,
        input.sourceMessageId,
        timestamp,
        timestamp,
      );
    const id = Number(result.lastInsertRowid);
    for (const passage of passages) {
      if (!passage) continue;
      addFacetEvidence(
        db,
        id,
        passage.id,
        input.evidenceKind ?? "assertion",
        input.confidence ?? 0.9,
      );
      if (input.sensitivity === "sensitive") allowPassage(db, passage.id);
    }
    indexFacet(db, id, facetSearchText(input.kind, statement, input.condition));
    insertFacetEvent(
      db,
      id,
      "accepted",
      { statement, scope: input.scope ?? { kind: "global" } },
      input.sourceMessageId,
      input.sourceKind ?? "message",
    );
    const facet = getFacet(db, id);
    if (!facet) throw new Error("Understanding facet vanished immediately after insert");
    return facet;
  })();
}

export function correctFacet(
  db: Db,
  id: number,
  input: Omit<RecordFacetInput, "kind" | "scope" | "passageIds"> & {
    passageIds: readonly number[];
    kind?: FacetKind;
    scope?: FacetScopeInput;
  },
): UnderstandingFacetView | null {
  const existing = getFacet(db, id);
  if (!existing || existing.valid_to !== null) return null;
  return db.transaction(() => {
    const replacement = recordFacet(db, {
      ...input,
      kind: input.kind ?? existing.kind,
      scope: input.scope ?? scopeFromFacet(existing),
      evidenceKind: "correction",
      forceNewVersion: true,
    });
    const closedAt = replacement.valid_from;
    db.prepare<[string, number, string, number]>(
      `UPDATE understanding_facet
       SET valid_to = ?, superseded_by = ?, updated_at = ?
       WHERE id = ?`,
    ).run(closedAt, replacement.id, closedAt, existing.id);
    insertFacetEvent(
      db,
      existing.id,
      "corrected",
      { superseded_by: replacement.id },
      input.sourceMessageId,
      input.sourceKind ?? "user_action",
    );
    return replacement;
  })();
}

export function closeFacet(
  db: Db,
  id: number,
  sourceMessageId: number,
  validTo: string | null = null,
): UnderstandingFacetView | null {
  const facet = getFacet(db, id);
  if (!facet || facet.valid_to !== null) return facet;
  const timestamp = normalizeDate(validTo) ?? now();
  db.transaction(() => {
    db.prepare<[string, string, number]>(
      "UPDATE understanding_facet SET valid_to = ?, updated_at = ? WHERE id = ?",
    ).run(timestamp, timestamp, id);
    insertFacetEvent(db, id, "closed", null, sourceMessageId, "user_action");
  })();
  return getFacet(db, id);
}

export function forgetFacet(db: Db, id: number): boolean {
  const facet = getFacet(db, id);
  if (!facet) return false;
  return db.transaction(() => {
    db.prepare<[number]>("DELETE FROM facet_fts WHERE rowid = ?").run(id);
    return db.prepare<[number]>("DELETE FROM understanding_facet WHERE id = ?").run(id)
      .changes > 0;
  })();
}

export async function searchFacets(
  db: Db,
  query: string,
  options: {
    limit?: number;
    kinds?: readonly FacetKind[];
    queryVector?: Float32Array | null;
  } = {},
): Promise<FacetSearchHit[]> {
  const limit = options.limit ?? 12;
  const match = toFtsQuery(query);
  const lexical: number[] = [];
  if (match) {
    const kindClause = options.kinds?.length
      ? `AND f.kind IN (${options.kinds.map(() => "?").join(",")})`
      : "";
    const params: Array<string | number> = [match, ...(options.kinds ?? []), limit * 4];
    try {
      lexical.push(
        ...db
          .prepare<Array<string | number>, { id: number }>(
            `SELECT f.id
             FROM understanding_facet f
             JOIN facet_fts ON facet_fts.rowid = f.id
             WHERE facet_fts MATCH ? AND f.valid_to IS NULL ${kindClause}
             ORDER BY bm25(facet_fts),
                      CASE f.importance WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
             LIMIT ?`,
          )
          .all(...params)
          .map((row) => row.id),
      );
    } catch {
      // A damaged or unavailable FTS index degrades to semantic retrieval.
    }
  }

  let vector = options.queryVector;
  if (vector === undefined) {
    try {
      vector = await embed(query);
    } catch {
      vector = null;
    }
  }
  let semantic = vector
    ? nearest(vector, loadFacetVectors(db), limit * 4).map((hit) => hit.ownerId)
    : [];
  if (options.kinds?.length && semantic.length > 0) {
    const allowedKinds = new Set(options.kinds);
    semantic = semantic.filter((id) => {
      const facet = getFacet(db, id);
      return facet !== null && allowedKinds.has(facet.kind);
    });
  }

  const fused = new Map<
    number,
    { score: number; via: Array<"lexical" | "semantic"> }
  >();
  for (const [via, ids] of [
    ["lexical", lexical],
    ["semantic", semantic],
  ] as const) {
    ids.forEach((id, index) => {
      const entry = fused.get(id) ?? { score: 0, via: [] };
      entry.score += 1 / (61 + index);
      if (!entry.via.includes(via)) entry.via.push(via);
      fused.set(id, entry);
    });
  }
  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .flatMap(([id, rank]) => {
      const facet = getFacet(db, id);
      return facet ? [{ facet, score: rank.score, via: rank.via }] : [];
    });
}

export function interactionFacets(db: Db, limit = 6): FacetSearchHit[] {
  return listFacets(db, {
    kinds: ["communication_style", "boundary"],
    limit,
  })
    .filter((facet) => facet.scope_kind === "global" || facet.scope_kind === "domain")
    .map((facet) => ({ facet, score: 1, via: ["core"] as const }));
}

export function reindexFacets(db: Db): number {
  const facets = listFacets(db, { includeClosed: true, limit: 100_000 });
  db.transaction(() => {
    db.exec("DELETE FROM facet_fts");
    for (const facet of facets) {
      indexFacet(db, facet.id, facetSearchText(facet.kind, facet.statement, facet.condition_text));
    }
  })();
  return facets.length;
}

export function facetSearchText(
  kind: FacetKind,
  statement: string,
  condition: string | null | undefined,
): string {
  return `${kind.replace(/_/gu, " ")} ${statement}${condition ? ` ${condition}` : ""}`;
}

function addFacetEvidence(
  db: Db,
  facetId: number,
  passageId: number,
  kind: FacetEvidence["kind"],
  confidence: number,
): void {
  db.prepare<[number, number, FacetEvidence["kind"], number, string]>(
    `INSERT OR IGNORE INTO facet_evidence
       (facet_id, passage_id, kind, confidence, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(facetId, passageId, kind, clamp(confidence), now());
}

function findMatchingLiveFacet(
  db: Db,
  input: {
    kind: FacetKind;
    statement: string;
    scope_kind: FacetScopeKind;
    scope_label: string | null;
    scope_entity_id: number | null;
    scope_goal_id: number | null;
    scope_commitment_id: number | null;
  },
): UnderstandingFacetView | null {
  return (
    db
      .prepare<[
        FacetKind,
        string,
        FacetScopeKind,
        string | null,
        number | null,
        number | null,
        number | null,
      ], UnderstandingFacetView>(
        `${SELECT_FACET}
         WHERE f.kind = ? AND lower(f.statement) = lower(?) AND f.scope_kind = ?
           AND f.scope_label IS ? AND f.scope_entity_id IS ?
           AND f.scope_goal_id IS ? AND f.scope_commitment_id IS ?
           AND f.valid_to IS NULL
         LIMIT 1`,
      )
      .get(
        input.kind,
        input.statement,
        input.scope_kind,
        input.scope_label,
        input.scope_entity_id,
        input.scope_goal_id,
        input.scope_commitment_id,
      ) ?? null
  );
}

function scopeColumns(scope: FacetScopeInput): {
  scope_kind: FacetScopeKind;
  scope_label: string | null;
  scope_entity_id: number | null;
  scope_goal_id: number | null;
  scope_commitment_id: number | null;
} {
  if (scope.kind === "domain") {
    const label = scope.label.trim();
    if (!label) throw new Error("Domain-scoped facets require a label");
    return {
      scope_kind: "domain",
      scope_label: label,
      scope_entity_id: null,
      scope_goal_id: null,
      scope_commitment_id: null,
    };
  }
  return {
    scope_kind: scope.kind,
    scope_label: null,
    scope_entity_id: scope.kind === "entity" ? scope.entityId : null,
    scope_goal_id: scope.kind === "goal" ? scope.goalId : null,
    scope_commitment_id: scope.kind === "commitment" ? scope.commitmentId : null,
  };
}

function scopeFromFacet(facet: UnderstandingFacet): FacetScopeInput {
  if (facet.scope_kind === "global") return { kind: "global" };
  if (facet.scope_kind === "domain") return { kind: "domain", label: facet.scope_label ?? "" };
  if (facet.scope_kind === "entity") return { kind: "entity", entityId: facet.scope_entity_id! };
  if (facet.scope_kind === "goal") return { kind: "goal", goalId: facet.scope_goal_id! };
  return { kind: "commitment", commitmentId: facet.scope_commitment_id! };
}

function validateScopeTarget(db: Db, scope: FacetScopeInput): void {
  const target =
    scope.kind === "entity"
      ? db.prepare<[number]>("SELECT 1 FROM entity WHERE id = ?").get(scope.entityId)
      : scope.kind === "goal"
        ? db.prepare<[number]>("SELECT 1 FROM goal WHERE id = ?").get(scope.goalId)
        : scope.kind === "commitment"
          ? db.prepare<[number]>("SELECT 1 FROM commitment WHERE id = ?").get(scope.commitmentId)
          : true;
  if (!target) throw new Error(`Unknown ${scope.kind} facet scope`);
}

function insertFacetEvent(
  db: Db,
  facetId: number,
  eventType: "accepted" | "corrected" | "closed" | "revived" | "forgotten",
  detail: unknown,
  sourceMessageId: number | null,
  sourceKind: "message" | "user_action" | "system",
): void {
  db.prepare<[number, string, string | null, number | null, string, string]>(
    `INSERT INTO facet_event
       (facet_id, event_type, detail_json, source_message_id, source_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    facetId,
    eventType,
    detail === null ? null : JSON.stringify(detail),
    sourceMessageId,
    sourceKind,
    now(),
  );
}

function indexFacet(db: Db, id: number, text: string): void {
  db.prepare<[number]>("DELETE FROM facet_fts WHERE rowid = ?").run(id);
  db.prepare<[number, string]>("INSERT INTO facet_fts (rowid, text) VALUES (?, ?)").run(
    id,
    text,
  );
}

function clamp(value: number): number {
  return Math.max(0.01, Math.min(1, value));
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

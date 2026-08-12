import type { Db } from "./db";
import { now } from "./db";
import { getMessage } from "./conversations";
import type {
  EvidencePassage,
  PassageRecallStatus,
  PassageSensitivity,
} from "./schema";

export type { EvidencePassage, PassageRecallStatus, PassageSensitivity } from "./schema";

export type PassageInput = {
  messageId: number;
  quote: string;
  sensitivity: PassageSensitivity;
  recallStatus: PassageRecallStatus;
  extractionRunId?: number | null;
};

const SELECT_PASSAGE = `
  SELECT id, message_id, start_offset, end_offset, text, sensitivity,
         recall_status, extraction_run_id, created_at
  FROM evidence_passage
`;

export function getPassage(db: Db, id: number): EvidencePassage | null {
  return db.prepare<[number], EvidencePassage>(`${SELECT_PASSAGE} WHERE id = ?`).get(id) ?? null;
}

export function passagesForMessage(db: Db, messageId: number): EvidencePassage[] {
  return db
    .prepare<[number], EvidencePassage>(
      `${SELECT_PASSAGE} WHERE message_id = ? ORDER BY start_offset, id`,
    )
    .all(messageId);
}

/**
 * Store a claim-sized immutable excerpt. The model supplies a quote, never offsets;
 * deterministic code proves that the quote exists in a real user message and derives
 * the UTF-16 offsets used by JavaScript string slicing.
 */
export function ensureEvidencePassage(db: Db, input: PassageInput): EvidencePassage {
  const message = getMessage(db, input.messageId);
  if (!message || message.role !== "user") {
    throw new Error("Evidence passages require a stored user message");
  }

  const quote = input.quote.trim();
  if (!quote) throw new Error("Evidence quote cannot be empty");
  const start = message.content.indexOf(quote);
  if (start < 0) throw new Error("Evidence quote does not occur in its source message");
  const end = start + quote.length;

  const existing = db
    .prepare<[number, number, number], EvidencePassage>(
      `${SELECT_PASSAGE}
       WHERE message_id = ? AND start_offset = ? AND end_offset = ?`,
    )
    .get(input.messageId, start, end);
  if (existing) {
    const nextStatus = strongerStatus(existing.recall_status, input.recallStatus);
    const nextSensitivity = strongerSensitivity(existing.sensitivity, input.sensitivity);
    if (nextStatus !== existing.recall_status || nextSensitivity !== existing.sensitivity) {
      db.prepare<[PassageSensitivity, PassageRecallStatus, number]>(
        "UPDATE evidence_passage SET sensitivity = ?, recall_status = ? WHERE id = ?",
      ).run(nextSensitivity, nextStatus, existing.id);
      syncPassageIndex(db, existing.id, quote, nextStatus);
    }
    return getPassage(db, existing.id) ?? existing;
  }

  const createdAt = now();
  const result = db
    .prepare<[
      number,
      number,
      number,
      string,
      PassageSensitivity,
      PassageRecallStatus,
      number | null,
      string,
    ]>(
      `INSERT INTO evidence_passage
         (message_id, start_offset, end_offset, text, sensitivity,
          recall_status, extraction_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      start,
      end,
      quote,
      input.sensitivity,
      input.recallStatus,
      input.extractionRunId ?? null,
      createdAt,
    );
  const id = Number(result.lastInsertRowid);
  syncPassageIndex(db, id, quote, input.recallStatus);
  const passage = getPassage(db, id);
  if (!passage) throw new Error("Evidence passage vanished immediately after insert");
  return passage;
}

/** Mark a successfully assessed, non-sensitive user message as episodically recallable. */
export function allowWholeMessagePassage(
  db: Db,
  messageId: number,
  extractionRunId: number | null = null,
): EvidencePassage {
  const message = getMessage(db, messageId);
  if (!message || message.role !== "user") {
    throw new Error("Only stored user messages can become episodes");
  }
  const passage = ensureEvidencePassage(db, {
    messageId,
    quote: message.content,
    sensitivity: "normal",
    recallStatus: "allowed",
    extractionRunId,
  });
  db.prepare<[number]>(
    "UPDATE message SET recall_state = 'classified' WHERE id = ?",
  ).run(messageId);
  return passage;
}

/** Withhold a source on classifier failure or when it contains unresolved sensitivity. */
export function blockMessageRecall(db: Db, messageId: number): void {
  const passages = passagesForMessage(db, messageId);
  db.transaction(() => {
    for (const passage of passages) {
      db.prepare<[number]>(
        "UPDATE evidence_passage SET recall_status = 'blocked' WHERE id = ?",
      ).run(passage.id);
      syncPassageIndex(db, passage.id, passage.text, "blocked");
    }
    db.prepare<[number]>("UPDATE message SET recall_state = 'blocked' WHERE id = ?").run(
      messageId,
    );
  })();
}

/**
 * Accepting one candidate unlocks only the exact supporting passage, and only
 * after every proposal sharing that passage has been accepted. Pending or rejected
 * interpretations must never make the underlying episode available by association.
 */
export function allowPassage(db: Db, passageId: number): EvidencePassage | null {
  const passage = getPassage(db, passageId);
  if (!passage) return null;
  const unresolved = db
    .prepare<[number], { found: number }>(
      `SELECT 1 AS found
       FROM candidate_evidence ce
       JOIN memory_candidate mc ON mc.id = ce.candidate_id
       WHERE ce.passage_id = ? AND mc.status IN ('pending','rejected')
       LIMIT 1`,
    )
    .get(passageId);
  if (unresolved) {
    if (passage.recall_status === "allowed") {
      db.prepare<[number]>(
        "UPDATE evidence_passage SET recall_status = 'pending' WHERE id = ?",
      ).run(passageId);
      syncPassageIndex(db, passageId, passage.text, "pending");
    }
    return getPassage(db, passageId);
  }
  db.prepare<[number]>(
    "UPDATE evidence_passage SET recall_status = 'allowed' WHERE id = ?",
  ).run(passageId);
  syncPassageIndex(db, passageId, passage.text, "allowed");
  db.prepare<[number]>("UPDATE message SET recall_state = 'classified' WHERE id = ?").run(
    passage.message_id,
  );
  return getPassage(db, passageId);
}

/** Keep one exact claim out of episodic recall without suppressing neighbouring text. */
export function withholdPassage(db: Db, passageId: number): EvidencePassage | null {
  const passage = getPassage(db, passageId);
  if (!passage) return null;
  if (passage.recall_status !== "blocked") {
    db.prepare<[number]>(
      "UPDATE evidence_passage SET recall_status = 'pending' WHERE id = ?",
    ).run(passageId);
  }
  syncPassageIndex(db, passageId, passage.text, "pending");
  return getPassage(db, passageId);
}

export function deletePassagesForMessage(db: Db, messageId: number): void {
  const ids = passagesForMessage(db, messageId).map((passage) => passage.id);
  db.transaction(() => {
    for (const id of ids) {
      db.prepare<[number]>("DELETE FROM passage_fts WHERE rowid = ?").run(id);
    }
    db.prepare<[number]>("DELETE FROM evidence_passage WHERE message_id = ?").run(messageId);
  })();
}

export function reindexPassages(db: Db): number {
  const passages = db
    .prepare<[], Pick<EvidencePassage, "id" | "text">>(
      `SELECT p.id, p.text FROM evidence_passage p
       WHERE p.recall_status = 'allowed'
         AND NOT EXISTS (
           SELECT 1 FROM candidate_evidence ce
           JOIN memory_candidate mc ON mc.id = ce.candidate_id
           WHERE ce.passage_id = p.id AND mc.status IN ('pending','rejected')
         )
       ORDER BY p.id`,
    )
    .all();
  db.transaction(() => {
    db.exec("DELETE FROM passage_fts");
    const insert = db.prepare<[number, string]>(
      "INSERT INTO passage_fts (rowid, text) VALUES (?, ?)",
    );
    for (const passage of passages) insert.run(passage.id, passage.text);
  })();
  return passages.length;
}

/** Conservative lexical override: a model may add sensitivity, never remove this flag. */
export function sourceLooksSensitive(text: string): boolean {
  return /\b(diagnos(?:is|ed)|medical|medication|therapy|therapist|mental health|salary|income|debt|bank|account number|credit card|legal|lawsuit|passport|password|secret|sexual|pregnan|religion|politic(?:s|al)|disability)\b/iu.test(
    text,
  );
}

function syncPassageIndex(
  db: Db,
  passageId: number,
  text: string,
  status: PassageRecallStatus,
): void {
  db.prepare<[number]>("DELETE FROM passage_fts WHERE rowid = ?").run(passageId);
  if (status === "allowed") {
    db.prepare<[number, string]>(
      "INSERT INTO passage_fts (rowid, text) VALUES (?, ?)",
    ).run(passageId, text);
  }
}

function strongerStatus(
  current: PassageRecallStatus,
  proposed: PassageRecallStatus,
): PassageRecallStatus {
  // Discovery of uncertainty must be able to retract an earlier broad allowance.
  // Explicit acceptance uses allowPassage(), which deliberately overrides this order.
  if (current === "blocked" || proposed === "blocked") return "blocked";
  if (current === "pending" || proposed === "pending") return "pending";
  return "allowed";
}

function strongerSensitivity(
  current: PassageSensitivity,
  proposed: PassageSensitivity,
): PassageSensitivity {
  const rank: Record<PassageSensitivity, number> = { normal: 0, uncertain: 1, sensitive: 2 };
  return rank[proposed] > rank[current] ? proposed : current;
}

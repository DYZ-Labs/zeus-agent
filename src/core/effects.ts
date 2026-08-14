import { createHash, randomUUID } from "node:crypto";

import { availableCapability, getCapability, getConnector } from "./connectors";
import type { ConnectorView } from "./connectors";
import type { Db } from "./db";
import { now } from "./db";
import { callCapability, ConnectorError } from "./mcp-client";
import { errorSignature, logEvent } from "./observability";
import type {
  CapabilitySlot,
  ConnectorCapability,
  EffectEvent,
  EffectEventType,
  ProposedEffect,
  WriteEffectKind,
} from "./schema";

/**
 * The payload gate.
 *
 * Authorizing a work plan approves a *scope*: these effects, these limits, this hash. It
 * cannot approve a *payload*, because the concrete request — which event, which time,
 * which people — only exists once the earlier steps have run. Treating the scope approval
 * as payload approval is the failure this module exists to prevent.
 *
 * So a run that reaches a write effect stops. It records exactly what it intends to send
 * and pauses at its durable checkpoint. The user reads that payload and confirms it by
 * hash, in a real message of their own. Execution then sends those bytes and no others:
 * the hash is recomputed from storage immediately before dispatch, so an edited payload
 * fails closed rather than going out under an old confirmation.
 *
 * Nothing here infers intent. Silence is not confirmation, an assistant sentence is not
 * confirmation, and an expired proposal is simply dead.
 */

/** Long enough to step away and come back; short enough that stale intent cannot fire. */
const DEFAULT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 20_000;
const MAX_PREVIEW = 2_000;

export type ProposeEffectInput = {
  workRunId: number;
  workStepId: number;
  slot: CapabilitySlot;
  payload: Record<string, unknown>;
  /** One plain sentence describing what will happen, shown next to the raw payload. */
  previewText: string;
  /** Stable across retries so one logical step cannot send twice. */
  providerRequestKey: string;
  expiresAt?: string;
};

export type ProposedEffectView = ProposedEffect & {
  payload: unknown;
  reversal: unknown;
  capability: ConnectorCapability;
  connector: ConnectorView;
  events: EffectEvent[];
};

export type EffectExecutionResult = {
  effect: ProposedEffect;
  status: "executed" | "failed";
  errorCode: string | null;
};

const SELECT_EFFECT = `
  SELECT id, work_run_id, work_step_id, connector_capability_id, effect_kind,
         payload_json, payload_hash, preview_text, reversal_json, status,
         idempotency_key, provider_request_key, expires_at, created_at, updated_at
  FROM proposed_effect
`;

/** Canonical digest of what would be sent. Key order must not change it. */
export function payloadHash(
  slot: CapabilitySlot,
  remoteToolName: string,
  payload: unknown,
): string {
  return createHash("sha256")
    .update(`${slot}\n${remoteToolName}\n${canonicalJson(payload)}`)
    .digest("hex");
}

/**
 * Record an intended external call without making it.
 *
 * Re-proposing the same payload for the same step returns the existing row rather than a
 * second one, so a resumed run cannot ask the user to confirm the same thing twice.
 */
export function proposeEffect(db: Db, input: ProposeEffectInput): ProposedEffectView {
  const available = availableCapability(db, input.slot);
  if (!available) {
    throw new Error(`No connected service currently provides ${input.slot}`);
  }
  const { capability } = available;
  if (capability.effect_kind === "external_read") {
    throw new Error("A read does not need confirmation and must not be proposed as an effect");
  }
  const payloadJson = canonicalJson(input.payload);
  if (payloadJson.length > MAX_PAYLOAD_BYTES) {
    throw new Error("That external request is too large to review");
  }
  const hash = payloadHash(input.slot, capability.remote_tool_name, input.payload);
  const previewText = normalizedPreview(input.previewText);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_CONFIRMATION_TTL_MS).toISOString();

  return db.transaction((): ProposedEffectView => {
    const existing = db
      .prepare<[string], ProposedEffect>(`${SELECT_EFFECT} WHERE payload_hash = ?`)
      .get(hash);
    if (existing) return requireView(db, existing.id);

    const timestamp = now();
    const inserted = db
      .prepare<
        [number, number, number, WriteEffectKind, string, string, string, string, string,
         string, string, string]
      >(
        `INSERT INTO proposed_effect
           (work_run_id, work_step_id, connector_capability_id, effect_kind, payload_json,
            payload_hash, preview_text, idempotency_key, provider_request_key, expires_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workRunId,
        input.workStepId,
        capability.id,
        capability.effect_kind as WriteEffectKind,
        payloadJson,
        hash,
        previewText,
        `effect:${randomUUID()}`,
        input.providerRequestKey,
        expiresAt,
        timestamp,
        timestamp,
      );
    const id = Number(inserted.lastInsertRowid);
    appendEffectEvent(db, id, "proposed", null, { slot: input.slot });
    logEvent({
      event: "effect_proposed",
      outcome: "ok",
      slot: input.slot,
      effect: capability.effect_kind,
      effect_id: id,
      run_id: input.workRunId,
    });
    return requireView(db, id);
  })();
}

export function getProposedEffect(db: Db, id: number): ProposedEffectView | null {
  const row = db.prepare<[number], ProposedEffect>(`${SELECT_EFFECT} WHERE id = ?`).get(id);
  return row ? view(db, row) : null;
}

export function listPendingEffects(db: Db, options: { at?: Date } = {}): ProposedEffectView[] {
  const at = (options.at ?? new Date()).toISOString();
  return db
    .prepare<[string], ProposedEffect>(
      `${SELECT_EFFECT}
       WHERE status = 'pending_confirmation' AND expires_at > ?
       ORDER BY id`,
    )
    .all(at)
    .map((row) => view(db, row));
}

/** Requests that actually happened, most recent first — the "what did Zeus do?" list. */
export function listExecutedEffects(db: Db, limit = 10): ProposedEffectView[] {
  return db
    .prepare<[number], ProposedEffect>(
      `${SELECT_EFFECT}
       WHERE status IN ('executed', 'reverted')
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => view(db, row));
}

export function effectsForRun(db: Db, runId: number): ProposedEffectView[] {
  return db
    .prepare<[number], ProposedEffect>(`${SELECT_EFFECT} WHERE work_run_id = ? ORDER BY id`)
    .all(runId)
    .map((row) => view(db, row));
}

/**
 * Accept one exact payload.
 *
 * The confirming message must be the user's own and must contain the payload hash. That
 * is the same proof `assertExactApprovalMessage` requires for a plan: a confirmation the
 * user could not have read is not a confirmation.
 */
export function confirmEffect(
  db: Db,
  id: number,
  payloadHashToConfirm: string,
  sourceMessageId: number,
): ProposedEffectView {
  return db.transaction((): ProposedEffectView => {
    const effect = requireEffect(db, id);
    assertPending(effect);
    if (effect.payload_hash !== payloadHashToConfirm) {
      throw new Error("That confirmation does not match this exact external request");
    }
    assertExactConfirmationMessage(db, sourceMessageId, effect.payload_hash);
    // The grant must still be the one this payload was built against.
    const capability = getCapability(db, effect.connector_capability_id);
    if (!capability || capability.enabled !== 1) {
      throw new Error("The capability behind this request is no longer available");
    }
    setStatus(db, id, "confirmed");
    appendEffectEvent(db, id, "confirmed", sourceMessageId, null);
    logEvent({
      event: "effect_confirmed",
      outcome: "ok",
      effect: effect.effect_kind,
      effect_id: id,
      message_id: sourceMessageId,
    });
    return requireView(db, id);
  })();
}

export function declineEffect(
  db: Db,
  id: number,
  sourceMessageId: number,
  reason?: string,
): ProposedEffectView {
  return db.transaction((): ProposedEffectView => {
    const effect = requireEffect(db, id);
    assertPending(effect);
    assertUserMessage(db, sourceMessageId);
    setStatus(db, id, "declined");
    appendEffectEvent(db, id, "declined", sourceMessageId, reason ? { reason } : null);
    logEvent({
      event: "effect_declined",
      outcome: "ok",
      effect: effect.effect_kind,
      effect_id: id,
    });
    return requireView(db, id);
  })();
}

/**
 * Retire proposals nobody answered.
 *
 * Deliberately not "act on it after a while": an unanswered proposal expires rather than
 * escalating, because the absence of a decision is not a decision.
 */
export function expireStaleEffects(db: Db, options: { at?: Date } = {}): number {
  const at = (options.at ?? new Date()).toISOString();
  const stale = db
    .prepare<[string], { id: number }>(
      `SELECT id FROM proposed_effect
       WHERE status = 'pending_confirmation' AND expires_at <= ?`,
    )
    .all(at);
  if (stale.length === 0) return 0;
  return db.transaction((): number => {
    for (const row of stale) {
      setStatus(db, row.id, "expired");
      appendEffectEvent(db, row.id, "expired", null, null);
    }
    return stale.length;
  })();
}

/**
 * Send exactly the confirmed bytes.
 *
 * The hash is recomputed from stored state first, so a payload edited after confirmation
 * cannot ride an old approval. The call itself is never retried: a write whose reply went
 * missing may well have happened, and repeating it is the one failure mode worse than
 * reporting uncertainty.
 */
export async function executeConfirmedEffect(
  db: Db,
  id: number,
  options: { signal?: AbortSignal } = {},
): Promise<EffectExecutionResult> {
  const effect = requireEffect(db, id);
  if (effect.status !== "confirmed") {
    throw new Error("Only a confirmed external request can be executed");
  }
  const capability = getCapability(db, effect.connector_capability_id);
  if (!capability || capability.enabled !== 1) {
    return fail(db, id, "capability_unavailable");
  }
  const payload = JSON.parse(effect.payload_json) as Record<string, unknown>;
  if (payloadHash(capability.slot, capability.remote_tool_name, payload) !== effect.payload_hash) {
    return fail(db, id, "payload_changed_since_confirmation");
  }

  const receiptId = beginConnectorCallReceipt(db, effect, capability.id, payload);
  try {
    const result = await callCapability(db, capability.slot, payload, {
      signal: options.signal,
      capabilityId: capability.id,
    });
    if (result.isError) {
      finishConnectorCallReceipt(db, receiptId, "failed", "remote_reported_error");
      return fail(db, id, "remote_reported_error");
    }
    finishConnectorCallReceipt(db, receiptId, "completed", null);

    const reversal = reversalFor(capability.slot, result.value);
    db.transaction(() => {
      if (reversal) {
        db.prepare<[string, string, number]>(
          "UPDATE proposed_effect SET reversal_json = ?, updated_at = ? WHERE id = ?",
        ).run(JSON.stringify(reversal), now(), id);
      }
      setStatus(db, id, "executed");
      appendEffectEvent(db, id, "executed", null, { reversible: reversal !== null });
    })();
    logEvent({
      event: "effect_executed",
      outcome: "ok",
      slot: capability.slot,
      effect: effect.effect_kind,
      effect_id: id,
    });
    return { effect: requireEffect(db, id), status: "executed", errorCode: null };
  } catch (error) {
    const code = error instanceof ConnectorError ? error.code : "call_failed";
    finishConnectorCallReceipt(db, receiptId, "failed", code);
    logEvent({
      event: "effect_executed",
      outcome: "error",
      slot: capability.slot,
      effect: effect.effect_kind,
      effect_id: id,
      ...errorSignature(error),
    });
    return fail(db, id, code);
  }
}

/**
 * A `connector_call` row means bytes left this machine, so it is written before the call
 * rather than after. A crash mid-flight leaves a 'started' receipt — an honest record that
 * Zeus cannot say whether the request landed, which is the truth in that moment.
 */
function beginConnectorCallReceipt(
  db: Db,
  effect: ProposedEffect,
  capabilityId: number,
  payload: Record<string, unknown>,
): number {
  const callIndex = (db
    .prepare<[number], { max_call_index: number | null }>(
      "SELECT MAX(call_index) AS max_call_index FROM tool_receipt WHERE work_run_id = ?",
    )
    .get(effect.work_run_id)?.max_call_index ?? 0) + 1;
  const inserted = db
    .prepare<[number, number, string, number, number, number, string, string, string]>(
      `INSERT INTO tool_receipt
         (work_run_id, work_step_id, tool_name, effect_kind, connector_capability_id,
          proposed_effect_id, call_index, input_json, status, idempotency_key, started_at)
       VALUES (?, ?, 'connector_call', ?, ?, ?, ?, ?, 'started', ?, ?)`,
    )
    .run(
      effect.work_run_id,
      effect.work_step_id,
      effect.effect_kind,
      capabilityId,
      effect.id,
      callIndex,
      JSON.stringify({ payload_hash: effect.payload_hash, payload }),
      effect.idempotency_key,
      now(),
    );
  return Number(inserted.lastInsertRowid);
}

function finishConnectorCallReceipt(
  db: Db,
  receiptId: number,
  status: "completed" | "failed",
  errorCode: string | null,
): void {
  db.prepare<[string, string | null, string, number]>(
    `UPDATE tool_receipt
     SET status = ?, error_code = ?, completed_at = ?
     WHERE id = ? AND status = 'started'`,
  ).run(status, errorCode, now(), receiptId);
}

/**
 * Undo an executed effect, where the connected service offers a way.
 *
 * A reversal is a fresh external call and therefore needs its own user message. Zeus does
 * not quietly clean up after itself.
 */
export async function revertEffect(
  db: Db,
  id: number,
  sourceMessageId: number,
  options: { signal?: AbortSignal } = {},
): Promise<ProposedEffectView> {
  const effect = requireEffect(db, id);
  if (effect.status !== "executed") {
    throw new Error("Only an executed external request can be reverted");
  }
  assertUserMessage(db, sourceMessageId);
  if (!effect.reversal_json) {
    throw new Error("That connected service offers no way to undo this");
  }
  const reversal = JSON.parse(effect.reversal_json) as {
    slot: CapabilitySlot;
    payload: Record<string, unknown>;
  };
  const result = await callCapability(db, reversal.slot, reversal.payload, {
    signal: options.signal,
  });
  if (result.isError) throw new Error("That connected service refused to undo the change");
  db.transaction(() => {
    setStatus(db, id, "reverted");
    appendEffectEvent(db, id, "reverted", sourceMessageId, null);
  })();
  logEvent({
    event: "effect_reverted",
    outcome: "ok",
    effect: effect.effect_kind,
    effect_id: id,
  });
  return requireView(db, id);
}

export function effectEvents(db: Db, id: number): EffectEvent[] {
  return db
    .prepare<[number], EffectEvent>(
      `SELECT id, proposed_effect_id, event_type, source_message_id, detail_json, created_at
       FROM effect_event WHERE proposed_effect_id = ? ORDER BY id`,
    )
    .all(id);
}

function fail(db: Db, id: number, errorCode: string): EffectExecutionResult {
  db.transaction(() => {
    setStatus(db, id, "failed");
    appendEffectEvent(db, id, "failed", null, { error_code: errorCode });
  })();
  return { effect: requireEffect(db, id), status: "failed", errorCode };
}

/**
 * What it would take to undo this, recorded from the service's own answer.
 *
 * Only a created event is reversible today, and only when the service returned an id. An
 * update is not: Zeus never captured the prior state, and inventing one would be worse
 * than admitting the change stands.
 */
function reversalFor(
  slot: CapabilitySlot,
  value: unknown,
): { slot: CapabilitySlot; payload: Record<string, unknown> } | null {
  if (slot !== "calendar.create_event") return null;
  const id = externalIdOf(value);
  if (id === null) return null;
  return { slot: "calendar.update_event", payload: { event_id: id, status: "cancelled" } };
}

function externalIdOf(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "event_id", "eventId"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function setStatus(db: Db, id: number, status: ProposedEffect["status"]): void {
  db.prepare<[string, string, number]>(
    "UPDATE proposed_effect SET status = ?, updated_at = ? WHERE id = ?",
  ).run(status, now(), id);
}

function appendEffectEvent(
  db: Db,
  proposedEffectId: number,
  eventType: EffectEventType,
  sourceMessageId: number | null,
  detail: Record<string, unknown> | null,
): void {
  db.prepare<[number, EffectEventType, number | null, string | null, string]>(
    `INSERT OR IGNORE INTO effect_event
       (proposed_effect_id, event_type, source_message_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    proposedEffectId,
    eventType,
    sourceMessageId,
    detail ? JSON.stringify(detail) : null,
    now(),
  );
}

function assertPending(effect: ProposedEffect): void {
  if (effect.status === "pending_confirmation") return;
  throw new Error(
    effect.status === "expired"
      ? "That external request expired and would have to be proposed again"
      : "That external request has already been decided",
  );
}

/**
 * The confirming message must be the user's, must name the exact hash, and must not be a
 * refusal. Mirrors `assertExactApprovalMessage` in work-plans.ts.
 *
 * The decision is read from the **first line** only, and everything after it is treated as
 * context. Without that split, a request whose own description contains a word like
 * "cancel" — which is exactly what cancelling a meeting looks like — would be impossible
 * to confirm, because the description would trip the refusal check. The words that decide
 * belong to the user, not to text echoed back from a model or a connected service.
 */
function assertExactConfirmationMessage(db: Db, id: number, hash: string): void {
  const message = db
    .prepare<[number], { role: string; content: string }>(
      "SELECT role, content FROM message WHERE id = ?",
    )
    .get(id);
  if (message?.role !== "user") {
    throw new Error("An external request must be confirmed by a stored user message");
  }
  const normalized = message.content.replace(/\r\n/gu, "\n").trim();
  const decision = (normalized.split("\n")[0] ?? "").replace(/\s+/gu, " ").trim();
  const rejects = /\b(?:do not|don['’]t|dont|never|reject|decline|revoke|stop)\b/iu;
  const confirms = /\b(?:confirm|approve|authorize|send it|go ahead)\b/iu;
  if (!normalized.includes(hash) || !confirms.test(decision) || rejects.test(decision)) {
    throw new Error("Confirmation must explicitly confirm the exact request hash");
  }
}

function assertUserMessage(db: Db, id: number): void {
  const role = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(id)?.role;
  if (role !== "user") {
    throw new Error("An external-request decision must cite a stored user message");
  }
}

function requireEffect(db: Db, id: number): ProposedEffect {
  const effect = db
    .prepare<[number], ProposedEffect>(`${SELECT_EFFECT} WHERE id = ?`)
    .get(id);
  if (!effect) throw new Error("Unknown external request");
  return effect;
}

function requireView(db: Db, id: number): ProposedEffectView {
  const found = getProposedEffect(db, id);
  if (!found) throw new Error("External request vanished after write");
  return found;
}

function view(db: Db, row: ProposedEffect): ProposedEffectView {
  const capability = getCapability(db, row.connector_capability_id);
  if (!capability) throw new Error("External request has no capability");
  const connector = getConnector(db, capability.connector_id);
  if (!connector) throw new Error("External request has no connector");
  return {
    ...row,
    payload: JSON.parse(row.payload_json),
    reversal: row.reversal_json === null ? null : JSON.parse(row.reversal_json),
    capability,
    connector,
    events: effectEvents(db, row.id),
  };
}

function normalizedPreview(value: string): string {
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("An external request needs a plain description");
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 1)}…` : text;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]));
}

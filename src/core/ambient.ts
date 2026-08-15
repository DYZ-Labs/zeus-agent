import { randomUUID } from "node:crypto";

import { syncCalendar } from "./calendar-sync";
import type { Db } from "./db";
import { now } from "./db";
import { getSignal, runDetectors } from "./detectors";
import { logEvent } from "./observability";
import type {
  AmbientDeliveryAttempt,
  AmbientSetting,
  CoarseLocation,
  EvaluationContext,
  FollowThroughRecommendation,
  OpportunityDelivery,
  OpportunityDeliveryChannel,
  RecommendationCycle,
} from "./schema";
import {
  createEvaluationContext,
  evaluateOpportunity,
  markOpportunityDelivered,
  recommendNextAction,
  recommendationForOpportunity,
} from "./stewardship";

const LOCATION_TTL_MS = 30 * 60 * 1000;
const RECENT_DELIVERY_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const MAX_FUTURE_LOCATION_SKEW_MS = 5 * 60 * 1000;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const WORKER_OPPORTUNITY_REUSE_MS = 30 * 60 * 60 * 1000;
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;

export type AmbientSettingUpdate = {
  enabled?: boolean;
  timezone?: string;
  quietStart?: string;
  quietEnd?: string;
  dailyLimit?: 1;
  allowedChannels?: OpportunityDeliveryChannel[];
  locationConsent?: boolean;
  sourceMessageId?: number | null;
};

export type AmbientNotification = {
  idempotencyKey: string;
  opportunityId: number;
  title: string;
  body: string;
  recommendation: FollowThroughRecommendation;
  context: EvaluationContext;
};

/** A delivery adapter returns true only after the operating system accepted delivery. */
export type AmbientNotifier = {
  deliver(notification: AmbientNotification): boolean;
};

export type AmbientRunResult =
  | { status: "disabled" | "channel_disabled" }
  | { status: "quiet_hours" | "daily_limit"; context: EvaluationContext }
  | {
      status: "delivery_in_flight";
      context: EvaluationContext;
      opportunityId: number;
      attemptId: number;
    }
  | { status: "no_opportunity"; context: EvaluationContext; opportunityId: number }
  | {
      status: "delivery_failed";
      context: EvaluationContext;
      opportunityId: number;
      attemptId: number;
      error: string | null;
    }
  | {
      status: "delivered";
      context: EvaluationContext;
      opportunityId: number;
      attemptId: number;
      delivery: OpportunityDelivery;
    };

type ClaimedAmbientDelivery = {
  status: "claimed";
  context: EvaluationContext;
  opportunityId: number;
  attempt: AmbientDeliveryAttempt;
  recommendation: FollowThroughRecommendation;
};

export function getAmbientSetting(db: Db): AmbientSetting {
  const row = db
    .prepare<[], AmbientSetting>(
      `SELECT id, enabled, timezone, quiet_start, quiet_end, daily_limit,
              channels_json, location_consent, source_message_id, updated_at
       FROM ambient_setting WHERE id = 1`,
    )
    .get();
  if (!row) throw new Error("Ambient setting is missing");
  return row;
}

/** Update opt-in policy. Revoking location consent removes the current coarse signal. */
export function updateAmbientSetting(db: Db, update: AmbientSettingUpdate): AmbientSetting {
  const current = getAmbientSetting(db);
  const timezone = update.timezone?.trim() || current.timezone;
  // This derives local fields as well as validating the IANA timezone.
  createEvaluationContext({ trigger: "worker", timezone });

  const quietStart = update.quietStart ?? current.quiet_start;
  const quietEnd = update.quietEnd ?? current.quiet_end;
  assertClockTime(quietStart, "quiet-hours start");
  assertClockTime(quietEnd, "quiet-hours end");

  const dailyLimit = update.dailyLimit ?? current.daily_limit;
  if (dailyLimit !== 1) {
    throw new Error("Ambient delivery is limited to one notification per local day");
  }

  const channels = update.allowedChannels ?? parseAllowedChannels(current.channels_json);
  const uniqueChannels = [...new Set(channels)];
  for (const channel of uniqueChannels) {
    if (!["chat", "today", "mcp", "macos"].includes(channel)) {
      throw new Error(`Unsupported ambient delivery channel: ${channel}`);
    }
  }

  const sourceMessageId =
    update.sourceMessageId === undefined ? current.source_message_id : update.sourceMessageId;
  if (sourceMessageId !== null) assertUserMessage(db, sourceMessageId);
  const locationConsent = update.locationConsent ?? current.location_consent === 1;

  return db.transaction(() => {
    db.prepare<[
      number,
      string,
      string,
      string,
      number,
      string,
      number,
      number | null,
      string,
    ]>(
      `UPDATE ambient_setting
       SET enabled = ?, timezone = ?, quiet_start = ?, quiet_end = ?, daily_limit = ?,
           channels_json = ?, location_consent = ?, source_message_id = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      (update.enabled ?? current.enabled === 1) ? 1 : 0,
      timezone,
      quietStart,
      quietEnd,
      dailyLimit,
      JSON.stringify(uniqueChannels),
      locationConsent ? 1 : 0,
      sourceMessageId,
      now(),
    );
    if (!locationConsent) db.prepare("DELETE FROM coarse_location WHERE id = 1").run();
    return getAmbientSetting(db);
  })();
}

/** Store only a user-named coarse zone. Raw coordinates are not accepted by this API. */
export function recordCoarseLocation(
  db: Db,
  zoneId: string,
  observedAt: string | Date,
): CoarseLocation {
  const setting = getAmbientSetting(db);
  if (setting.location_consent !== 1) {
    throw new Error("Location consent is required before recording a coarse zone");
  }
  const normalizedZone = normalizeZone(zoneId);
  if (!normalizedZone) throw new Error("A coarse location zone is required");
  if (normalizedZone.length > 120) throw new Error("A coarse location zone is too long");

  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(observed.getTime())) throw new Error("Location observation time is invalid");
  if (observed.getTime() > Date.now() + MAX_FUTURE_LOCATION_SKEW_MS) {
    throw new Error("Location observation time is too far in the future");
  }
  const observedIso = observed.toISOString();
  const expiresAt = new Date(observed.getTime() + LOCATION_TTL_MS).toISOString();
  db.prepare<[string, string, string, string]>(
    `INSERT INTO coarse_location (id, zone_id, observed_at, expires_at, created_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       zone_id = excluded.zone_id,
       observed_at = excluded.observed_at,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`,
  ).run(normalizedZone, observedIso, expiresAt, now());
  return getCoarseLocation(db)!;
}

export function getCoarseLocation(db: Db): CoarseLocation | null {
  return (
    db
      .prepare<[], CoarseLocation>(
        "SELECT id, zone_id, observed_at, expires_at, created_at FROM coarse_location WHERE id = 1",
      )
      .get() ?? null
  );
}

export function getFreshCoarseLocation(
  db: Db,
  referenceTime: Date = new Date(),
): CoarseLocation | null {
  if (getAmbientSetting(db).location_consent !== 1) return null;
  const location = getCoarseLocation(db);
  if (!location) return null;
  const observedAt = new Date(location.observed_at).getTime();
  const expiresAt = new Date(location.expires_at).getTime();
  const reference = referenceTime.getTime();
  if (
    !Number.isFinite(reference) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    observedAt > reference + MAX_FUTURE_LOCATION_SKEW_MS ||
    expiresAt <= reference
  ) {
    return null;
  }
  return location;
}

/** Build the portable, auditable context used by the deterministic worker policy. */
export function buildAmbientEvaluationContext(
  db: Db,
  referenceTime: Date = new Date(),
): EvaluationContext {
  const setting = getAmbientSetting(db);
  const location = getFreshCoarseLocation(db, referenceTime);
  return createEvaluationContext({
    trigger: "worker",
    referenceTime,
    timezone: setting.timezone,
    locationZone: location?.zone_id ?? null,
    locationObservedAt: location?.observed_at ?? null,
  });
}

/** Build the same consent-aware context for every product surface. Explicit triggers
 * remain explicit policy invocations; only the fresh coarse-zone signal is shared. */
export function buildEvaluationContextForTrigger(
  db: Db,
  trigger: EvaluationContext["trigger"],
  referenceTime: Date = new Date(),
): EvaluationContext {
  const setting = getAmbientSetting(db);
  const location = getFreshCoarseLocation(db, referenceTime);
  return createEvaluationContext({
    trigger,
    referenceTime,
    timezone: setting.timezone,
    locationZone: location?.zone_id ?? null,
    locationObservedAt: location?.observed_at ?? null,
  });
}

/** Start and end are local HH:mm values. Windows spanning midnight are supported. */
export function isQuietLocalTime(localTime: string, start: string, end: string): boolean {
  assertClockTime(localTime, "local time");
  assertClockTime(start, "quiet-hours start");
  assertClockTime(end, "quiet-hours end");
  const value = clockMinutes(localTime);
  const startValue = clockMinutes(start);
  const endValue = clockMinutes(end);
  // Equal boundaries conservatively mean quiet all day.
  if (startValue === endValue) return true;
  if (startValue < endValue) return value >= startValue && value < endValue;
  return value >= startValue || value < endValue;
}

export function ambientDeliveriesForLocalDay(
  db: Db,
  context: EvaluationContext,
): number {
  const key = localDateKey(new Date(context.evaluated_at), context.timezone);
  const cutoff = new Date(
    new Date(context.evaluated_at).getTime() - RECENT_DELIVERY_LOOKBACK_MS,
  ).toISOString();
  const rows = db
    .prepare<[string], { delivered_at: string }>(
      `SELECT delivered_at FROM opportunity_delivery
       WHERE channel = 'macos' AND delivered_at >= ?`,
    )
    .all(cutoff);
  return rows.filter(
    (row) => localDateKey(new Date(row.delivered_at), context.timezone) === key,
  ).length;
}

export function getAmbientDeliveryAttempt(
  db: Db,
  attemptId: number,
): AmbientDeliveryAttempt | null {
  return (
    db
      .prepare<[number], AmbientDeliveryAttempt>(
        `SELECT id, opportunity_id, channel, local_day, claim_slot, lease_token,
                status, leased_until, notifier_started_at, completed_at, error_code,
                delivery_id, created_at
         FROM ambient_delivery_attempt WHERE id = ?`,
      )
      .get(attemptId) ?? null
  );
}

/**
 * Reuse the exact worker opportunity on Today when it remains the deterministic best
 * eligible commitment in the same configured local day. This makes the notification,
 * Today card, and surfaced accounting one auditable proposal rather than lookalikes.
 */
export function resolveTodayOpportunity(
  db: Db,
  context: EvaluationContext,
  query = "",
): RecommendationCycle | null {
  if (context.trigger !== "today") {
    throw new Error("A Today opportunity requires a Today evaluation context");
  }
  // May be null when the worker's pick was a detected signal rather than a commitment.
  // That is the common case for a conflict alert, so it must not short-circuit the reuse.
  const current = recommendNextAction(db, query, { context });
  const cutoff = new Date(
    new Date(context.evaluated_at).getTime() - WORKER_OPPORTUNITY_REUSE_MS,
  ).toISOString();
  const cycles = db
    .prepare<[string], RecommendationCycle>(
      `SELECT cycle.id, cycle.policy_version, cycle.trigger, cycle.context_json,
              cycle.query_text, cycle.candidate_scores_json,
              cycle.applied_facet_ids_json, cycle.exclusions_json,
              cycle.selected_commitment_id, cycle.selected_signal_id,
              cycle.recommendation_json, cycle.source_message_id, cycle.created_at
       FROM recommendation_cycle cycle
       JOIN opportunity_delivery delivery
         ON delivery.opportunity_id = cycle.id AND delivery.channel = 'macos'
       WHERE cycle.trigger = 'worker' AND delivery.delivered_at >= ?
       ORDER BY delivery.delivered_at DESC, cycle.id DESC
       LIMIT 20`,
    )
    .all(cutoff);
  const today = localDateKey(new Date(context.evaluated_at), context.timezone);
  for (const cycle of cycles) {
    const workerContext = parsedCycleContext(cycle.context_json);
    if (
      !workerContext ||
      workerContext.timezone !== context.timezone ||
      localDateKey(new Date(workerContext.evaluated_at), context.timezone) !== today
    ) {
      continue;
    }
    if (cycle.selected_signal_id !== null) {
      // The notification already started this signal's cooldown, so re-evaluating would
      // now select nothing and Today would look empty to someone who just tapped through.
      // Reusing the exact cycle keeps the notification and the card one proposal.
      const signal = getSignal(db, cycle.selected_signal_id);
      if (signal && signal.resolved_at === null) return cycle;
      continue;
    }
    if (!current) continue;
    const recommendation = recommendationForOpportunity(db, cycle.id);
    if (recommendation?.commitment_id === current.commitment_id) return cycle;
  }
  return null;
}

/**
 * Refresh what Zeus can see, then re-derive what is worth noticing.
 *
 * Separate from `runAmbientEvaluation` because the two answer different questions: this
 * updates the picture, that decides whether to interrupt. Neither calls a model. A failed
 * refresh is not fatal — detectors simply run against the cache they already have, which
 * degrades recall rather than inventing a reason to speak up.
 */
export type AmbientRefreshSettings = {
  enabled: boolean;
  intervalMinutes: number;
  reason: string;
};

const DEFAULT_REFRESH_MINUTES = 15;
const MIN_REFRESH_MINUTES = 5;
const MAX_REFRESH_MINUTES = 180;

/**
 * Whether this process is the one responsible for refreshing signals.
 *
 * Locally a macOS LaunchAgent already runs `refreshExternalSignals` on a timer, so the
 * server doing it too would spend a second set of calls against the same connector budget
 * to learn the same thing. Hosted, nothing runs it at all — which is why a hosted
 * deployment never noticed a double-booking no matter how long it was left running. The
 * default follows that split, and `ZEUS_SIGNAL_REFRESH` overrides it in either direction
 * for the deployment that does not match the assumption.
 */
export function ambientRefreshSettings(
  configuration: { mode: string },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AmbientRefreshSettings {
  const intervalMinutes = refreshIntervalSetting(environment.ZEUS_SIGNAL_REFRESH_MINUTES);
  const configured = environment.ZEUS_SIGNAL_REFRESH?.trim().toLowerCase();

  if (configured === "off") {
    return { enabled: false, intervalMinutes, reason: "explicitly_disabled" };
  }
  if (configured === "on") {
    return { enabled: true, intervalMinutes, reason: "explicitly_enabled" };
  }
  if (configured !== undefined && configured !== "") {
    throw new Error("ZEUS_SIGNAL_REFRESH must be 'on' or 'off'");
  }

  const hosted =
    configuration.mode === "configured" && environment.NODE_ENV === "production";
  return {
    enabled: hosted,
    intervalMinutes,
    reason: hosted ? "hosted" : "not_hosted",
  };
}

function refreshIntervalSetting(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_REFRESH_MINUTES;
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error("ZEUS_SIGNAL_REFRESH_MINUTES must be a whole number of minutes");
  }
  return Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, Number(trimmed)));
}

export async function refreshExternalSignals(
  db: Db,
  options: { at?: Date; signal?: AbortSignal } = {},
): Promise<{ synced: boolean; detected: number; resolved: number }> {
  const at = options.at ?? new Date();
  const synced = await syncCalendar(db, { at, signal: options.signal });
  const result = runDetectors(db, { at });
  logEvent({
    event: "detectors_run",
    outcome: synced ? "ok" : "degraded",
    count: result.created.length,
  });
  return {
    synced: synced !== null,
    detected: result.created.length,
    resolved: result.resolved,
  };
}

/**
 * Evaluate one current opportunity and deliver it at most once within the configured
 * local-day budget. The immediate transaction serializes duplicate LaunchAgent runs.
 * A failed notification is audited as an undelivered cycle and never counted surfaced.
 */
export function runAmbientEvaluation(
  db: Db,
  notifier: AmbientNotifier,
  options: { referenceTime?: Date; query?: string } = {},
): AmbientRunResult {
  const claim = claimAmbientDelivery(db, options);
  if (claim.status !== "claimed") return claim;

  const notification: AmbientNotification = {
    idempotencyKey: claim.attempt.lease_token,
    opportunityId: claim.opportunityId,
    title: "Zeus has one useful next step",
    body: `${claim.recommendation.commitment_title} — ${claim.recommendation.suggested_action}`,
    recommendation: claim.recommendation,
    context: claim.context,
  };
  let delivered = false;
  let error: string | null = null;
  try {
    delivered = notifier.deliver(notification);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Notifier failed";
  }
  if (!delivered) {
    releaseAmbientDeliveryClaim(db, claim.attempt, "notifier_failed");
    return {
      status: "delivery_failed",
      context: claim.context,
      opportunityId: claim.opportunityId,
      attemptId: claim.attempt.id,
      error,
    };
  }

  const delivery = finalizeAmbientDelivery(db, claim.attempt);
  return {
    status: "delivered",
    context: claim.context,
    opportunityId: claim.opportunityId,
    attemptId: claim.attempt.id,
    delivery,
  };
}

function claimAmbientDelivery(
  db: Db,
  options: { referenceTime?: Date; query?: string },
): AmbientRunResult | ClaimedAmbientDelivery {
  return db.transaction((): AmbientRunResult | ClaimedAmbientDelivery => {
    const setting = getAmbientSetting(db);
    if (setting.enabled !== 1) return { status: "disabled" };
    if (!parseAllowedChannels(setting.channels_json).includes("macos")) {
      return { status: "channel_disabled" };
    }

    const context = buildAmbientEvaluationContext(db, options.referenceTime);
    if (isQuietLocalTime(context.local_time, setting.quiet_start, setting.quiet_end)) {
      return { status: "quiet_hours", context };
    }
    const localDay = localDateKey(new Date(context.evaluated_at), context.timezone);
    const claimSlot = `macos:${localDay}`;
    const existing = db
      .prepare<[string], AmbientDeliveryAttempt>(
        `SELECT id, opportunity_id, channel, local_day, claim_slot, lease_token,
                status, leased_until, notifier_started_at, completed_at, error_code,
                delivery_id, created_at
         FROM ambient_delivery_attempt WHERE claim_slot = ?`,
      )
      .get(claimSlot);
    if (existing) {
      if (
        existing.status === "claimed" &&
        Date.parse(existing.leased_until) <= new Date(context.evaluated_at).getTime()
      ) {
        // The notifier may have succeeded immediately before its process died. Keep the
        // daily slot reserved so restart cannot create a duplicate interruption.
        db.prepare<[string, string, number]>(
          `UPDATE ambient_delivery_attempt
           SET status = 'unknown', completed_at = ?, error_code = ?
           WHERE id = ? AND status = 'claimed'`,
        ).run(now(), "lease_expired_delivery_unknown", existing.id);
        return { status: "daily_limit", context };
      }
      if (existing.status === "claimed") {
        return {
          status: "delivery_in_flight",
          context,
          opportunityId: existing.opportunity_id,
          attemptId: existing.id,
        };
      }
      return { status: "daily_limit", context };
    }
    if (ambientDeliveriesForLocalDay(db, context) >= setting.daily_limit) {
      return { status: "daily_limit", context };
    }

    // Always evaluate current state. We intentionally do not replay prior missed cycles.
    const cycle = evaluateOpportunity(db, context, options.query ?? "");
    const recommendation = recommendationForOpportunity(db, cycle.id);
    if (!recommendation) {
      return { status: "no_opportunity", context, opportunityId: cycle.id };
    }
    const leaseToken = randomUUID();
    const claimedAt = now();
    const leasedUntil = new Date(
      new Date(context.evaluated_at).getTime() + DELIVERY_LEASE_MS,
    ).toISOString();
    const inserted = db
      .prepare<[number, string, string, string, string, string, string]>(
        `INSERT INTO ambient_delivery_attempt
           (opportunity_id, channel, local_day, claim_slot, lease_token, status,
            leased_until, notifier_started_at, created_at)
         VALUES (?, 'macos', ?, ?, ?, 'claimed', ?, ?, ?)`,
      )
      .run(
        cycle.id,
        localDay,
        claimSlot,
        leaseToken,
        leasedUntil,
        claimedAt,
        claimedAt,
      );
    const attempt = getAmbientDeliveryAttempt(db, Number(inserted.lastInsertRowid));
    if (!attempt) throw new Error("Ambient delivery claim vanished after insertion");
    return {
      status: "claimed",
      context,
      opportunityId: cycle.id,
      attempt,
      recommendation,
    };
  }).immediate();
}

function releaseAmbientDeliveryClaim(
  db: Db,
  attempt: AmbientDeliveryAttempt,
  errorCode: string,
): void {
  db.transaction(() => {
    db.prepare<[string, string, number, string]>(
      `UPDATE ambient_delivery_attempt
       SET status = 'failed', claim_slot = NULL, completed_at = ?, error_code = ?
       WHERE id = ? AND lease_token = ? AND status = 'claimed'`,
    ).run(now(), errorCode, attempt.id, attempt.lease_token);
  }).immediate();
}

function finalizeAmbientDelivery(
  db: Db,
  attempt: AmbientDeliveryAttempt,
): OpportunityDelivery {
  return db.transaction(() => {
    const current = getAmbientDeliveryAttempt(db, attempt.id);
    if (
      !current ||
      current.lease_token !== attempt.lease_token ||
      current.status !== "claimed"
    ) {
      throw new Error("Ambient delivery claim is no longer active");
    }
    const delivery = markOpportunityDelivered(db, attempt.opportunity_id, "macos");
    if (!delivery) throw new Error("A successful notification could not be recorded");
    const completedAt = now();
    db.prepare<[string, number, number, string]>(
      `UPDATE ambient_delivery_attempt
       SET status = 'succeeded', completed_at = ?, delivery_id = ?, error_code = NULL
       WHERE id = ? AND lease_token = ? AND status = 'claimed'`,
    ).run(completedAt, delivery.id, attempt.id, attempt.lease_token);
    return delivery;
  }).immediate();
}

function parseAllowedChannels(value: string): OpportunityDeliveryChannel[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (channel): channel is OpportunityDeliveryChannel =>
        typeof channel === "string" && ["chat", "today", "mcp", "macos"].includes(channel),
    );
  } catch {
    return [];
  }
}

function assertUserMessage(db: Db, messageId: number): void {
  const message = db
    .prepare<[number], { role: string }>("SELECT role FROM message WHERE id = ?")
    .get(messageId);
  if (message?.role !== "user") throw new Error("Source must be a stored user message");
}

function normalizeZone(zoneId: string): string {
  return zoneId.replace(/\s+/gu, " ").trim().toLowerCase();
}

function assertClockTime(value: string, label: string): void {
  if (!CLOCK_TIME.test(value)) throw new Error(`Invalid ${label}; expected HH:mm`);
}

function clockMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function localDateKey(referenceTime: Date, timezone: string): string {
  if (!Number.isFinite(referenceTime.getTime())) throw new Error("Reference time is invalid");
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(referenceTime);
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not derive the local calendar day");
  return `${year}-${month}-${day}`;
}

function parsedCycleContext(
  value: string,
): { evaluated_at: string; timezone: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.evaluated_at !== "string" ||
      !Number.isFinite(Date.parse(record.evaluated_at)) ||
      typeof record.timezone !== "string"
    ) {
      return null;
    }
    return { evaluated_at: record.evaluated_at, timezone: record.timezone };
  } catch {
    return null;
  }
}

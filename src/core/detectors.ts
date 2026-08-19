import { cachedEvents } from "./calendar-sync";
import { overlappingPairs } from "./calendar-conflicts";
import {
  clock,
  endOf,
  label,
  mentions,
  normalizedPlace,
  startOf,
} from "./calendar-time";
import type { CachedEvent } from "./calendar-time";
import type { Db } from "./db";
import { now } from "./db";
import { listCommitments, listGoals } from "./intentions";
import type { CommitmentView } from "./schema";
import type { DetectedSignal, DetectorKind, EffectKind } from "./schema";
import { guardExternalText } from "./untrusted-data";

/**
 * Deterministic noticing.
 *
 * The follow-through selector ranks commitments — things the user told Zeus about. That
 * cannot notice a flight landing after a dinner starts, because nobody wrote that down as
 * a commitment. Detectors close that gap: they read cached external signals alongside
 * accepted intentions and emit the specific, checkable observations a person would want
 * interrupted for.
 *
 * They are pure functions over the local store and make no model call. That is not a cost
 * decision. A background process that reasons freely about someone's calendar is a
 * different product with a different risk profile; one that applies four named rules can
 * be read, tested, and disbelieved.
 *
 * A detected signal is proposal data, exactly like a follow-through recommendation. It is
 * never a fact about the user, and the external rows it reads are never evidence.
 */

const DAY_MS = 86_400_000;
/** Time between events at different places, under which the second is hard to reach. */
const TRAVEL_GAP_MS = 30 * 60_000;
/** How far ahead a deadline has to be before an unscheduled commitment is worth raising. */
const UNSCHEDULED_HORIZON_MS = 7 * DAY_MS;
const MAX_SIGNALS_PER_RUN = 50;

export type { CachedEvent };

export type DetectionResult = {
  created: DetectedSignal[];
  resolved: number;
};

type Draft = {
  detector: DetectorKind;
  dedupeKey: string;
  subject: Record<string, unknown>;
  commitmentId: number | null;
  severity: number;
  why: string;
  suggestedAction: string;
  effectKind: EffectKind;
  occursAt: string | null;
};

const SELECT_SIGNAL = `
  SELECT id, detector, dedupe_key, subject_json, commitment_id, severity, why,
         suggested_action, effect_kind, occurs_at, detected_at, snoozed_until,
         last_surfaced_at, resolved_at
  FROM detected_signal
`;

/**
 * Run every detector and reconcile the open set.
 *
 * Reconciling matters as much as detecting: a conflict the user fixed in their calendar
 * must stop being raised without anyone telling Zeus it was handled. Signals absent from
 * this pass are resolved rather than left to age.
 */
export function runDetectors(db: Db, options: { at?: Date } = {}): DetectionResult {
  const at = options.at ?? new Date();
  const events = cachedEvents(db, at);
  const commitments = listCommitments(db, { limit: 500 });
  const activeGoalIds = new Set(
    listGoals(db, { limit: 500 }).filter((goal) => goal.status === "active").map((goal) => goal.id),
  );

  const drafts = [
    ...detectCalendarOverlaps(events),
    ...detectTravelGaps(events),
    ...detectDeadlineCollisions(commitments, events, at, activeGoalIds),
    ...detectUnscheduledCommitments(commitments, events, at, activeGoalIds),
  ]
    .sort((left, right) => right.severity - left.severity)
    .slice(0, MAX_SIGNALS_PER_RUN);

  return db.transaction((): DetectionResult => {
    const seen = new Set(drafts.map((draft) => draft.dedupeKey));
    const resolved = resolveAbsentSignals(db, seen, at);
    const created: DetectedSignal[] = [];
    for (const draft of drafts) created.push(upsertSignal(db, draft));
    return { created, resolved };
  })();
}

export function listOpenSignals(db: Db, options: { at?: Date } = {}): DetectedSignal[] {
  const at = (options.at ?? new Date()).toISOString();
  return db
    .prepare<[string], DetectedSignal>(
      `${SELECT_SIGNAL}
       WHERE resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)
       ORDER BY severity DESC, id`,
    )
    .all(at);
}

export function getSignal(db: Db, id: number): DetectedSignal | null {
  return db.prepare<[number], DetectedSignal>(`${SELECT_SIGNAL} WHERE id = ?`).get(id) ?? null;
}

export function signalSubject(signal: DetectedSignal): Record<string, unknown> {
  const parsed: unknown = JSON.parse(signal.subject_json);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Event titles and locations are somebody else's text, and a signal's wording is not a dead
 * end. `signalChatPrompt` splices `why` into a prefilled chat prompt, which arrives back as
 * a *user* message — the one channel Zeus reads as instructions rather than as data. An
 * event anyone can put on the calendar must not be able to reach it.
 *
 * Guarding where the sentence is composed rather than where it is displayed means the stored
 * row is already safe, so every reader inherits that instead of each surface having to
 * remember. The witness is local because a signal has no per-turn "some text was withheld"
 * channel to report into: the marker in the sentence is the report.
 */
function safeExternal(value: string): string {
  return guardExternalText(value, { any: false });
}

/** `label`, over a title that has already passed the guard. */
function safeLabel(event: CachedEvent): string {
  return label({ ...event, title: event.title === null ? null : safeExternal(event.title) });
}


/**
 * Two events claiming the same minutes. The most checkable observation there is.
 *
 * The pairing itself comes from `overlappingPairs`, so a collision Zeus raises unprompted and
 * one it reports when asked in chat are found by the same rule. This adds only the wording.
 */
function detectCalendarOverlaps(events: readonly CachedEvent[]): Draft[] {
  return overlappingPairs(events).map(({ first, second }) => ({
    detector: "calendar_overlap" as const,
    dedupeKey: `calendar_overlap:${first.external_id}:${second.external_id}`,
    subject: { event_ids: [first.external_id, second.external_id] },
    commitmentId: null,
    severity: 70,
    why:
      `${safeLabel(first)} runs until ${clock(endOf(first))} and ${safeLabel(second)} starts at ` +
      `${clock(startOf(second))}.`,
    suggestedAction: `Decide which of ${safeLabel(first)} and ${safeLabel(second)} to move.`,
    effectKind: "modify_external" as const,
    occursAt: second.starts_at,
  }));
}

/**
 * Back-to-back events in different places.
 *
 * Zeus does not know how far apart the places are, so this claims only what it can see:
 * two named locations and very little time between them. The wording says exactly that,
 * rather than asserting the user will be late.
 */
function detectTravelGaps(events: readonly CachedEvent[]): Draft[] {
  const drafts: Draft[] = [];
  for (let index = 0; index + 1 < events.length; index += 1) {
    const first = events[index];
    const second = events[index + 1];
    if (!first || !second) continue;
    if (!first.location || !second.location) continue;
    if (normalizedPlace(first.location) === normalizedPlace(second.location)) continue;
    const gap = Date.parse(second.starts_at) - endOf(first);
    if (gap < 0 || gap >= TRAVEL_GAP_MS) continue;
    drafts.push({
      detector: "travel_gap",
      dedupeKey: `travel_gap:${first.external_id}:${second.external_id}`,
      subject: {
        event_ids: [first.external_id, second.external_id],
        gap_minutes: Math.round(gap / 60_000),
      },
      commitmentId: null,
      severity: 55,
      why:
        `${Math.round(gap / 60_000)} minutes separate ${safeLabel(first)} at ` +
        `${safeExternal(first.location)} from ${safeLabel(second)} at ` +
        `${safeExternal(second.location)}.`,
      suggestedAction: `Check whether ${safeLabel(second)} still works, or move it.`,
      effectKind: "modify_external",
      occursAt: second.starts_at,
    });
  }
  return drafts;
}

/** A commitment falling due on a day the calendar has already filled. */
function detectDeadlineCollisions(
  commitments: readonly CommitmentView[],
  events: readonly CachedEvent[],
  at: Date,
  activeGoalIds: ReadonlySet<number>,
): Draft[] {
  const drafts: Draft[] = [];
  for (const commitment of eligible(commitments, activeGoalIds)) {
    if (!commitment.due_at) continue;
    const due = Date.parse(commitment.due_at);
    if (!Number.isFinite(due) || due < at.getTime() || due > at.getTime() + UNSCHEDULED_HORIZON_MS) {
      continue;
    }
    const dayKey = commitment.due_at.slice(0, 10);
    const sameDay = events.filter((event) => event.starts_at.slice(0, 10) === dayKey);
    const busyMinutes = sameDay.reduce(
      (total, event) => total + Math.max(0, endOf(event) - Date.parse(event.starts_at)) / 60_000,
      0,
    );
    if (busyMinutes < 360) continue;
    drafts.push({
      detector: "deadline_collision",
      dedupeKey: `deadline_collision:${commitment.id}:${dayKey}`,
      subject: {
        commitment_id: commitment.id,
        day: dayKey,
        booked_minutes: Math.round(busyMinutes),
      },
      commitmentId: commitment.id,
      severity: 65,
      why:
        `“${commitment.title}” is due on ${dayKey}, which already has ` +
        `${Math.round(busyMinutes / 60)} hours booked.`,
      suggestedAction: `Start “${commitment.title}” earlier, or move its deadline.`,
      effectKind: "prepare_local",
      occursAt: commitment.due_at,
    });
  }
  return drafts;
}

/** A commitment with a near deadline and no time set aside for it. */
function detectUnscheduledCommitments(
  commitments: readonly CommitmentView[],
  events: readonly CachedEvent[],
  at: Date,
  activeGoalIds: ReadonlySet<number>,
): Draft[] {
  const drafts: Draft[] = [];
  for (const commitment of eligible(commitments, activeGoalIds)) {
    if (!commitment.due_at) continue;
    const due = Date.parse(commitment.due_at);
    if (!Number.isFinite(due) || due < at.getTime() || due > at.getTime() + UNSCHEDULED_HORIZON_MS) {
      continue;
    }
    if (events.some((event) => mentions(event, commitment.title))) continue;
    drafts.push({
      detector: "commitment_unscheduled",
      dedupeKey: `commitment_unscheduled:${commitment.id}`,
      subject: { commitment_id: commitment.id, due_at: commitment.due_at },
      commitmentId: commitment.id,
      severity: due - at.getTime() < 2 * DAY_MS ? 60 : 45,
      why:
        `“${commitment.title}” is due ${commitment.due_at.slice(0, 10)} and nothing in the ` +
        "calendar is set aside for it.",
      suggestedAction: `Hold time for “${commitment.title}” before it is due.`,
      effectKind: "schedule",
      occursAt: commitment.due_at,
    });
  }
  return drafts;
}

function eligible(
  commitments: readonly CommitmentView[],
  activeGoalIds: ReadonlySet<number>,
): CommitmentView[] {
  return commitments.filter((commitment) => {
    if (commitment.status !== "open" && commitment.status !== "waiting") return false;
    // A commitment under a paused goal is deliberately not raised, matching the
    // follow-through selector's own gate.
    if (commitment.linked_goal_id !== null && !activeGoalIds.has(commitment.linked_goal_id)) {
      return false;
    }
    return true;
  });
}

/**
 * Reappearing under the same key keeps a signal's history — including its snooze and the
 * fact it was already surfaced — so a periodic sweep cannot turn one conflict into a
 * fresh interruption every time it runs.
 */
function upsertSignal(db: Db, draft: Draft): DetectedSignal {
  const timestamp = now();
  db.prepare<
    [DetectorKind, string, string, number | null, number, string, string, EffectKind,
     string | null, string]
  >(
    `INSERT INTO detected_signal
       (detector, dedupe_key, subject_json, commitment_id, severity, why,
        suggested_action, effect_kind, occurs_at, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       subject_json = excluded.subject_json,
       severity = excluded.severity,
       why = excluded.why,
       suggested_action = excluded.suggested_action,
       occurs_at = excluded.occurs_at,
       resolved_at = NULL`,
  ).run(
    draft.detector,
    draft.dedupeKey,
    JSON.stringify(draft.subject),
    draft.commitmentId,
    draft.severity,
    draft.why,
    draft.suggestedAction,
    draft.effectKind,
    draft.occursAt,
    timestamp,
  );
  const signal = db
    .prepare<[string], DetectedSignal>(`${SELECT_SIGNAL} WHERE dedupe_key = ?`)
    .get(draft.dedupeKey);
  if (!signal) throw new Error("Detected signal vanished after insertion");
  return signal;
}

/** A conflict the user fixed stops being raised, without anyone having to say so. */
function resolveAbsentSignals(db: Db, seen: ReadonlySet<string>, at: Date): number {
  const open = db
    .prepare<[], { id: number; dedupe_key: string }>(
      "SELECT id, dedupe_key FROM detected_signal WHERE resolved_at IS NULL",
    )
    .all();
  let resolved = 0;
  const update = db.prepare<[string, number]>(
    "UPDATE detected_signal SET resolved_at = ? WHERE id = ?",
  );
  for (const row of open) {
    if (seen.has(row.dedupe_key)) continue;
    update.run(at.toISOString(), row.id);
    resolved += 1;
  }
  return resolved;
}


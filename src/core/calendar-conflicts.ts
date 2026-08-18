import {
  contentWords,
  endOf,
  localDate,
  localMinutesOfDay,
  OVERLAP_GRACE_MS,
  startOf,
} from "./calendar-time";
import type { CachedEvent } from "./calendar-time";

/**
 * Whether an event Zeus is about to create collides with one the user already has.
 *
 * This is the check that replaces asking. That changes what it has to guarantee: a
 * confirmation gate fails safe when it is wrong, because a human reads the payload before
 * anything happens, but a conflict gate that answers "clear" when it does not know is a
 * double-booking with a receipt. So the only route to `clear` runs through proof that a
 * window covering the candidate was actually read, recently. An empty event list is never
 * enough on its own — an unread calendar reports exactly the same thing.
 *
 * Pure. No database, no model call, no clock of its own: every input is passed in, so the
 * whole gate is testable offline and its answers are reproducible.
 */

export const SLOT_GRANULARITY_MS = 15 * 60_000;
export const MIN_DURATION_MS = 15 * 60_000;
export const SEARCH_BEFORE_MS = 86_400_000;
export const SEARCH_AFTER_MS = 7 * 86_400_000;
export const MAX_ALTERNATIVES = 3;

/**
 * How stale a read may be and still support a write.
 *
 * Deliberately far tighter than the one-hour cache TTL that serves detectors. A detector
 * raising a slightly stale conflict costs a glance; a write gate clearing a slot someone
 * booked forty minutes ago costs a collision.
 */
export const MAX_COVERAGE_AGE_MS = 10 * 60_000;

export type CandidateEvent = {
  startsAt: string;
  endsAt: string;
  /** A reschedule must not be judged to conflict with itself. */
  excludeExternalId?: string | null;
};

/** Proof of a successful read, and of which window it covered. */
export type CalendarCoverage = {
  from: string;
  to: string;
  fetchedAt: string;
  eventCount: number;
};

export type FreeSlot = { startsAt: string; endsAt: string };

export type ConflictCheck =
  | { status: "clear"; coverage: CalendarCoverage; consideredEvents: number }
  | {
      status: "conflict";
      conflicts: CachedEvent[];
      alternatives: FreeSlot[];
      coverage: CalendarCoverage;
    }
  | {
      status: "unverifiable";
      reason: "no_coverage" | "stale_coverage" | "outside_coverage" | "unparsable_candidate";
    };

export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  // The grace window is what keeps back-to-back meetings from reading as collisions: an
  // event ending at 10:00 and one starting at 10:00 share an instant, not any minutes.
  return aStart < bEnd - OVERLAP_GRACE_MS && bStart < aEnd - OVERLAP_GRACE_MS;
}

/** Two of the user's own events claiming the same minutes. */
export type EventOverlap = { first: CachedEvent; second: CachedEvent };

/**
 * Every pair of already-scheduled events that collide, in calendar order.
 *
 * The counterpart of `findConflicts`, which asks what collides with a time Zeus is about to
 * take. This asks what already collides with itself, and it lives here rather than in
 * `detectors.ts` so a clash Zeus reports when asked is the same clash it would raise on its
 * own — one overlap rule, one grace window, one answer.
 *
 * Assumes the list is sorted by start, as every reader of the event cache supplies it.
 */
export function overlappingPairs(events: readonly CachedEvent[]): EventOverlap[] {
  const pairs: EventOverlap[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const first = events[index];
    if (!first) continue;
    const firstEnd = endOf(first);
    for (let other = index + 1; other < events.length; other += 1) {
      const second = events[other];
      if (!second) continue;
      // Sorted input, so the first non-overlapping successor ends the run for this event.
      if (startOf(second) >= firstEnd - OVERLAP_GRACE_MS) break;
      pairs.push({ first, second });
    }
  }
  return pairs;
}

/** Cached events claiming any of the candidate's minutes, earliest first. */
export function findConflicts(
  events: readonly CachedEvent[],
  candidate: CandidateEvent,
): CachedEvent[] {
  const start = Date.parse(candidate.startsAt);
  const end = Date.parse(candidate.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return events
    .filter((event) => {
      if (candidate.excludeExternalId && event.external_id === candidate.excludeExternalId) {
        return false;
      }
      const eventStart = startOf(event);
      if (!Number.isFinite(eventStart)) return false;
      return intervalsOverlap(start, end, eventStart, endOf(event));
    })
    .sort((left, right) => startOf(left) - startOf(right));
}

/**
 * The nearest openings of the candidate's own length.
 *
 * Every choice here is fixed rather than inferred, so the same request always produces the
 * same three suggestions: a 15-minute grid aligned in the user's own timezone (aligning in
 * UTC produces :15-offset slots for half-hour zones), inside the user's stated day, ordered
 * by closeness to what they actually asked for, and spaced at least one event-length apart
 * so three suggestions are three real options rather than one option three times.
 *
 * The requested time itself always counts as inside the day: someone who asks for 21:00 is
 * better served by 21:30 than by being told the only opening is 08:00 tomorrow.
 */
export function findFreeSlots(input: {
  events: readonly CachedEvent[];
  candidate: CandidateEvent;
  coverage: CalendarCoverage;
  timezone: string;
  now: string;
  dayStart: string;
  dayEnd: string;
  limit?: number;
}): FreeSlot[] {
  const start = Date.parse(input.candidate.startsAt);
  const end = Date.parse(input.candidate.endsAt);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const duration = Math.max(end - start, MIN_DURATION_MS);
  const coverageFrom = Date.parse(input.coverage.from);
  const coverageTo = Date.parse(input.coverage.to);
  const searchFrom = Math.max(start - SEARCH_BEFORE_MS, nowMs, coverageFrom);
  const searchTo = Math.min(start + SEARCH_AFTER_MS, coverageTo);
  if (!Number.isFinite(searchFrom) || !Number.isFinite(searchTo)) return [];

  const dayStartMinutes = minutesOfDay(input.dayStart) ?? 8 * 60;
  const dayEndMinutes = minutesOfDay(input.dayEnd) ?? 20 * 60;
  const requestedStartMinutes = localMinutesOfDay(start, input.timezone);
  const requestedEndMinutes = localMinutesOfDay(end, input.timezone);

  const found: FreeSlot[] = [];
  const limit = input.limit ?? MAX_ALTERNATIVES;
  const candidates: { slotStart: number; distance: number }[] = [];

  for (
    let slotStart = alignToGrid(searchFrom, input.timezone);
    slotStart + duration <= searchTo;
    slotStart += SLOT_GRANULARITY_MS
  ) {
    if (slotStart < searchFrom) continue;
    if (slotStart === start) continue;
    const slotStartMinutes = localMinutesOfDay(slotStart, input.timezone);
    const slotEndMinutes = slotStartMinutes + duration / 60_000;
    const insideStatedDay =
      slotStartMinutes >= dayStartMinutes && slotEndMinutes <= dayEndMinutes;
    const insideRequestedSpan =
      slotStartMinutes >= requestedStartMinutes && slotEndMinutes <= requestedEndMinutes + 240;
    if (!insideStatedDay && !insideRequestedSpan) continue;
    const conflicts = findConflicts(input.events, {
      startsAt: new Date(slotStart).toISOString(),
      endsAt: new Date(slotStart + duration).toISOString(),
      excludeExternalId: input.candidate.excludeExternalId ?? null,
    });
    if (conflicts.length > 0) continue;
    candidates.push({ slotStart, distance: Math.abs(slotStart - start) });
  }

  candidates.sort((left, right) =>
    left.distance === right.distance
      ? left.slotStart - right.slotStart
      : left.distance - right.distance,
  );

  for (const entry of candidates) {
    if (found.length >= limit) break;
    // Three suggestions fifteen minutes apart is one suggestion. Space them by the length
    // of the thing being scheduled.
    const tooClose = found.some(
      (slot) => Math.abs(Date.parse(slot.startsAt) - entry.slotStart) < duration,
    );
    if (tooClose) continue;
    found.push({
      startsAt: new Date(entry.slotStart).toISOString(),
      endsAt: new Date(entry.slotStart + duration).toISOString(),
    });
  }
  return found;
}

/**
 * The gate itself.
 *
 * Note the order: coverage is established before events are consulted at all. There is no
 * path from an empty event list to `clear` that does not first prove a covering window was
 * read within `MAX_COVERAGE_AGE_MS`.
 */
export function checkCalendarConflicts(input: {
  events: readonly CachedEvent[];
  candidate: CandidateEvent;
  coverage: CalendarCoverage | null;
  timezone: string;
  now: string;
  dayStart: string;
  dayEnd: string;
}): ConflictCheck {
  const start = Date.parse(input.candidate.startsAt);
  const end = Date.parse(input.candidate.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { status: "unverifiable", reason: "unparsable_candidate" };
  }
  if (!input.coverage) return { status: "unverifiable", reason: "no_coverage" };

  const fetchedAt = Date.parse(input.coverage.fetchedAt);
  const nowMs = Date.parse(input.now);
  if (
    !Number.isFinite(fetchedAt) ||
    !Number.isFinite(nowMs) ||
    nowMs - fetchedAt > MAX_COVERAGE_AGE_MS
  ) {
    return { status: "unverifiable", reason: "stale_coverage" };
  }

  const coverageFrom = Date.parse(input.coverage.from);
  const coverageTo = Date.parse(input.coverage.to);
  if (
    !Number.isFinite(coverageFrom) ||
    !Number.isFinite(coverageTo) ||
    start < coverageFrom ||
    end > coverageTo
  ) {
    return { status: "unverifiable", reason: "outside_coverage" };
  }

  const conflicts = findConflicts(input.events, input.candidate);
  if (conflicts.length === 0) {
    return {
      status: "clear",
      coverage: input.coverage,
      consideredEvents: input.events.length,
    };
  }
  return {
    status: "conflict",
    conflicts,
    alternatives: findFreeSlots({
      events: input.events,
      candidate: input.candidate,
      coverage: input.coverage,
      timezone: input.timezone,
      now: input.now,
      dayStart: input.dayStart,
      dayEnd: input.dayEnd,
    }),
    coverage: input.coverage,
  };
}

// ---------------------------------------------------------------------------
// Resolving which existing event the user meant
// ---------------------------------------------------------------------------

export type EventReference = {
  titleText: string | null;
  /** An absolute instant, when the user named a time. */
  startsAt: string | null;
  /** A local calendar day, when they named only a day. */
  dateLocal: string | null;
};

export type TargetResolution =
  | { status: "resolved"; event: CachedEvent }
  | { status: "ambiguous"; candidates: CachedEvent[] }
  | {
      status: "not_found";
      /**
       * What Zeus did see, so a refusal can become a question.
       *
       * Nothing acts on these and nothing may treat them as the calendar's contents: they
       * are, by construction, the entries that failed the match. They exist so the reply can
       * say "I do not see a dinner; I do see this — did you mean it?" instead of asserting
       * that the event does not exist, which is a claim about someone's calendar that a
       * failed lookup does not support.
       */
      nearMisses: CachedEvent[];
    };

export const TARGET_START_TOLERANCE_MS = 15 * 60_000;
export const MAX_TARGET_CANDIDATES = 5;
export const MAX_NEAR_MISSES = 3;
/** How far from the time the user named a non-matching event may be and still be worth naming. */
export const NEAR_MISS_WINDOW_MS = 7 * 86_400_000;

/**
 * Which existing event "my 3pm" or "dinner with Sam" refers to.
 *
 * Deterministic, and it refuses rather than guesses. Two events at 3pm produce a question,
 * never a coin flip — the same rule that makes a shared alias resolve as ambiguous instead
 * of being forced onto one person. With no confirmation gate downstream, "nearest match"
 * would mean cancelling the wrong meeting and finding out afterwards.
 */
export function resolveTargetEvent(
  events: readonly CachedEvent[],
  reference: EventReference,
  options: {
    timezone: string;
    now: string;
    /**
     * Where in time to look when nothing matched — the requested new time, for a
     * reschedule. Never used to resolve a target, only to decide which non-matching events
     * are worth naming back: someone moving something to Thursday is not helped by a list of
     * what is on today.
     */
    anchorAt?: string | null;
  },
): TargetResolution {
  const nowMs = Date.parse(options.now);
  // A meeting that started ten minutes ago is still reschedulable; yesterday's is not.
  const live = events.filter((event) => {
    const eventEnd = endOf(event);
    return Number.isFinite(eventEnd) && eventEnd > nowMs - 3_600_000;
  });
  let pool = live;

  if (reference.dateLocal) {
    pool = pool.filter(
      (event) => localDate(startOf(event), options.timezone) === reference.dateLocal,
    );
  }

  if (reference.startsAt) {
    const target = Date.parse(reference.startsAt);
    if (Number.isFinite(target)) {
      pool = pool.filter(
        (event) => Math.abs(startOf(event) - target) <= TARGET_START_TOLERANCE_MS,
      );
    }
  }

  if (reference.titleText && reference.titleText.trim().length > 0) {
    const needle = reference.titleText.trim().toLocaleLowerCase();
    const words = contentWords(reference.titleText);
    const scored = pool
      .map((event) => {
        const title = (event.title ?? "").toLocaleLowerCase();
        if (title.length > 0 && title.includes(needle)) return { event, score: 100 };
        const eventWords = contentWords(event.title ?? "");
        let shared = 0;
        for (const word of words) if (eventWords.has(word)) shared += 1;
        return { event, score: shared >= Math.min(2, words.size) ? shared : 0 };
      })
      .filter((entry) => entry.score > 0);
    const best = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
    pool = scored.filter((entry) => entry.score === best).map((entry) => entry.event);
  }

  if (pool.length === 0) {
    return { status: "not_found", nearMisses: nearMissesFor(live, reference, nowMs, options.anchorAt ?? null) };
  }
  if (pool.length === 1) {
    const event = pool[0];
    return event
      ? { status: "resolved", event }
      : { status: "not_found", nearMisses: nearMissesFor(live, reference, nowMs, options.anchorAt ?? null) };
  }
  return {
    status: "ambiguous",
    candidates: [...pool]
      .sort((left, right) => startOf(left) - startOf(right))
      .slice(0, MAX_TARGET_CANDIDATES),
  };
}

/**
 * A short, bounded list of what was there instead.
 *
 * Deliberately looser than the strict chain and deliberately incapable of resolving
 * anything: one shared word, or a containment either way, or simply being near the time the
 * user named. The cap and the time window keep this from becoming a dump of somebody's week
 * in exchange for a failed lookup.
 */
function nearMissesFor(
  live: readonly CachedEvent[],
  reference: EventReference,
  nowMs: number,
  anchorAt: string | null,
): CachedEvent[] {
  const needle = reference.titleText?.trim().toLocaleLowerCase() ?? "";
  const words = reference.titleText ? contentWords(reference.titleText) : new Set<string>();
  // How the user pointed at the event first, then where they are putting it, then now.
  const anchor = [reference.startsAt, anchorAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .find((value) => Number.isFinite(value)) ?? nowMs;

  const scored = live
    .map((event) => {
      const title = (event.title ?? "").toLocaleLowerCase();
      let score = 0;
      if (needle.length > 0 && title.length > 0) {
        if (title.includes(needle) || needle.includes(title)) score = 3;
        else {
          const eventWords = contentWords(event.title ?? "");
          for (const word of words) if (eventWords.has(word)) score = Math.max(score, 2);
        }
      }
      const distance = Math.abs(startOf(event) - anchor);
      // Nothing shared a word, so offer what sits around the time they named. Without this
      // a title-only miss has nothing to say, which is the case that started all of this.
      if (score === 0 && Number.isFinite(distance) && distance <= NEAR_MISS_WINDOW_MS) score = 1;
      return { event, score, distance };
    })
    .filter((entry) => entry.score > 0);

  return scored
    .sort((left, right) =>
      left.score === right.score ? left.distance - right.distance : right.score - left.score,
    )
    .slice(0, MAX_NEAR_MISSES)
    .map((entry) => entry.event);
}

// ---------------------------------------------------------------------------
// Timezone-aware helpers
// ---------------------------------------------------------------------------

function minutesOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Round up to the next 15-minute boundary of the user's own clock, not of UTC. */
function alignToGrid(timestamp: number, timezone: string): number {
  const minutes = localMinutesOfDay(timestamp, timezone);
  const remainder = minutes % 15;
  const seconds = new Date(timestamp).getUTCSeconds();
  const millis = new Date(timestamp).getUTCMilliseconds();
  const toNext = remainder === 0 && seconds === 0 && millis === 0
    ? 0
    : (15 - remainder) * 60_000 - seconds * 1_000 - millis;
  return timestamp + toNext;
}

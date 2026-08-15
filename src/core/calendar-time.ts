/**
 * Calendar arithmetic shared by noticing and by acting.
 *
 * `detectors.ts` asks whether two events the user already has collide. `calendar-conflicts.ts`
 * asks whether an event Zeus is about to create collides with them. Those are the same
 * question about different subjects, and they must answer it the same way — otherwise Zeus
 * can refuse to create something it would never have flagged, or create something it would.
 * One definition of "overlap", one rule for a missing end time, one way to name an event.
 */

export type CachedEvent = {
  external_id: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  title: string | null;
};

/** Below this, two events are adjacent rather than genuinely colliding. */
export const OVERLAP_GRACE_MS = 60_000;

/** How long an event with no stated end is assumed to run. */
export const ASSUMED_DURATION_MS = 3_600_000;

export function startOf(event: CachedEvent): number {
  return Date.parse(event.starts_at);
}

export function endOf(event: CachedEvent): number {
  const start = startOf(event);
  const end = event.ends_at === null ? Number.NaN : Date.parse(event.ends_at);
  // A calendar entry with no end is treated as an hour: long enough to collide with the
  // next thing, short enough not to swallow the day.
  return Number.isFinite(end) && end > start ? end : start + ASSUMED_DURATION_MS;
}

export function label(event: CachedEvent): string {
  return event.title && event.title.trim().length > 0 ? `“${event.title.trim()}”` : "an event";
}

export function clock(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 16);
}

export function normalizedPlace(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Whether a calendar entry plainly refers to some titled thing, by shared content words. */
export function mentions(event: CachedEvent, title: string): boolean {
  const words = contentWords(title);
  if (words.size === 0) return false;
  const eventWords = contentWords(event.title ?? "");
  let shared = 0;
  for (const word of words) if (eventWords.has(word)) shared += 1;
  return shared >= Math.min(2, words.size);
}

export function contentWords(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (word) => word.length > 3,
    ),
  );
}

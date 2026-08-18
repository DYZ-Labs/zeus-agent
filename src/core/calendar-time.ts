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

/**
 * Words long enough to survive the length filter and still carry no meaning in a title.
 *
 * Without these, a filler word raises the bar instead of lowering it: "dinner with Sam"
 * against an event called "Dinner" yields {dinner, with} — "Sam" is dropped for being short
 * — so the `min(2, size)` threshold demands two shared words, finds one, and scores zero.
 * The more precisely someone describes the event, the less likely it is to match.
 */
const FILLER_WORDS = new Set([
  "with",
  "from",
  "about",
  "that",
  "this",
  "your",
  "their",
  "some",
]);

export function contentWords(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (word) => word.length > 3 && !FILLER_WORDS.has(word),
    ),
  );
}

// ---------------------------------------------------------------------------

/**
 * Local wall-clock parts for an instant.
 *
 * Everything here goes through `Intl` rather than arithmetic on the UTC value, because a
 * fixed offset is wrong twice a year and permanently wrong for half-hour zones.
 *
 * Lives here rather than in `calendar-conflicts.ts` because the module that owns one
 * definition of "overlap" should own one definition of "what time is that where the user
 * is". Both the gate and the sentences shown to the user now read from the same place.
 */
export function localParts(
  timestamp: number,
  timezone: string,
): { year: string; month: string; day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "00";
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
  };
}

export function localDate(timestamp: number, timezone: string): string {
  if (!Number.isFinite(timestamp)) return "";
  const parts = localParts(timestamp, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localMinutesOfDay(timestamp: number, timezone: string): number {
  const parts = localParts(timestamp, timezone);
  return parts.hour * 60 + parts.minute;
}

/** Exact calendar arithmetic on a YYYY-MM-DD, so "tomorrow" survives a DST boundary. */
function shiftDate(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function meridiem(minutes: number): string {
  return minutes < 720 ? "AM" : "PM";
}

function clockText(minutes: number, withMeridiem: boolean): string {
  const hour24 = Math.floor(minutes / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour12}:${minute}${withMeridiem ? ` ${meridiem(minutes)}` : ""}`;
}

function dayText(timestamp: number, timezone: string, nowMs: number | null): string {
  const date = localDate(timestamp, timezone);
  const today = nowMs === null ? null : localDate(nowMs, timezone);
  if (today !== null) {
    if (date === today) return "today";
    if (date === shiftDate(today, 1)) return "tomorrow";
    if (date === shiftDate(today, -1)) return "yesterday";
  }
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(timestamp));
}

/**
 * One way to write a window, for every surface that shows one.
 *
 * The failure this replaces: `previewFor` emitted raw UTC ISO instants, so the text a person
 * read before approving a change was `2026-08-20T10:30:00.000Z–2026-08-20T11:30:00.000Z`,
 * while the card wrote the same window a third way and the model wrote it a fourth. A window
 * nobody can read at a glance is a window nobody checks.
 *
 * `now` only decides whether a day is named or called today/tomorrow; it never changes which
 * instants are described. Pass null to always name the day — which is what a server render
 * does, because a relative label resolved against two different clocks is a hydration
 * mismatch, and "tomorrow" is not worth one.
 */
export function describeInterval(
  startsAt: string,
  endsAt: string | null,
  timezone: string,
  now: string | null,
): string {
  const start = Date.parse(startsAt);
  const parsedNow = now === null ? null : Date.parse(now);
  const nowMs = parsedNow !== null && Number.isFinite(parsedNow) ? parsedNow : null;
  if (!Number.isFinite(start)) return "";
  const startMinutes = localMinutesOfDay(start, timezone);
  const day = dayText(start, timezone, nowMs);

  const end = endsAt === null ? Number.NaN : Date.parse(endsAt);
  if (!Number.isFinite(end) || end <= start) {
    return `${day} from ${clockText(startMinutes, true)}`;
  }

  const endMinutes = localMinutesOfDay(end, timezone);
  if (localDate(start, timezone) !== localDate(end, timezone)) {
    const endDay = dayText(end, timezone, nowMs);
    return `${day} ${clockText(startMinutes, true)} – ${endDay} ${clockText(endMinutes, true)}`;
  }
  // "10:00–10:30 AM" when the meridiem is shared, "11:30 AM–12:30 PM" when it is not. Saying
  // it twice where it does not change reads as machine output; dropping it where it does
  // changes the meaning.
  const shared = meridiem(startMinutes) === meridiem(endMinutes);
  return shared
    ? `${day} ${clockText(startMinutes, false)}–${clockText(endMinutes, true)}`
    : `${day} ${clockText(startMinutes, true)}–${clockText(endMinutes, true)}`;
}

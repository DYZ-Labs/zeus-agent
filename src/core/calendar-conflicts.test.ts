import { describe, expect, it } from "vitest";

import {
  checkCalendarConflicts,
  findConflicts,
  findFreeSlots,
  MAX_COVERAGE_AGE_MS,
  resolveTargetEvent,
} from "./calendar-conflicts";
import type { CalendarCoverage, CandidateEvent } from "./calendar-conflicts";
import type { CachedEvent } from "./calendar-time";

const NOW = "2026-08-17T09:00:00.000Z";
const TZ = "UTC";

function event(overrides: Partial<CachedEvent> & { external_id: string; starts_at: string }): CachedEvent {
  return {
    ends_at: null,
    location: null,
    title: null,
    ...overrides,
  };
}

function coverage(overrides: Partial<CalendarCoverage> = {}): CalendarCoverage {
  return {
    from: "2026-08-17T00:00:00.000Z",
    to: "2026-09-16T00:00:00.000Z",
    fetchedAt: NOW,
    eventCount: 0,
    ...overrides,
  };
}

function check(input: {
  events?: CachedEvent[];
  candidate: CandidateEvent;
  coverage?: CalendarCoverage | null;
  now?: string;
}) {
  return checkCalendarConflicts({
    events: input.events ?? [],
    candidate: input.candidate,
    coverage: input.coverage === undefined ? coverage() : input.coverage,
    timezone: TZ,
    now: input.now ?? NOW,
    dayStart: "08:00",
    dayEnd: "20:00",
  });
}

const NOON: CandidateEvent = {
  startsAt: "2026-08-18T12:00:00.000Z",
  endsAt: "2026-08-18T13:00:00.000Z",
};

describe("an unverified calendar is never a clear one", () => {
  // The single most important property in this module. A confirmation gate fails safe when
  // it is wrong because a human reads the payload; this gate does not have that luxury.
  it("refuses to clear a slot when no read has ever succeeded", () => {
    const result = check({ candidate: NOON, coverage: null });
    expect(result.status).toBe("unverifiable");
    expect(result).toMatchObject({ reason: "no_coverage" });
  });

  it("refuses to clear a slot from a stale read", () => {
    const result = check({
      candidate: NOON,
      coverage: coverage({
        fetchedAt: new Date(Date.parse(NOW) - MAX_COVERAGE_AGE_MS - 1_000).toISOString(),
      }),
    });
    expect(result).toMatchObject({ status: "unverifiable", reason: "stale_coverage" });
  });

  it("refuses to clear a slot the read window never covered", () => {
    const result = check({
      candidate: {
        startsAt: "2026-12-01T12:00:00.000Z",
        endsAt: "2026-12-01T13:00:00.000Z",
      },
    });
    expect(result).toMatchObject({ status: "unverifiable", reason: "outside_coverage" });
  });

  it("clears an empty calendar only on the strength of a fresh covering read", () => {
    const result = check({ candidate: NOON });
    expect(result).toMatchObject({ status: "clear", consideredEvents: 0 });
  });

  it("refuses a candidate whose times do not parse or invert", () => {
    expect(check({ candidate: { startsAt: "not a date", endsAt: "also not" } })).toMatchObject({
      status: "unverifiable",
      reason: "unparsable_candidate",
    });
    expect(
      check({
        candidate: { startsAt: NOON.endsAt, endsAt: NOON.startsAt },
      }),
    ).toMatchObject({ status: "unverifiable", reason: "unparsable_candidate" });
  });
});

describe("what counts as a collision", () => {
  it("catches exact, partial, and containing overlaps", () => {
    const exact = event({ external_id: "a", starts_at: NOON.startsAt, ends_at: NOON.endsAt });
    const straddlesStart = event({
      external_id: "b",
      starts_at: "2026-08-18T11:30:00.000Z",
      ends_at: "2026-08-18T12:30:00.000Z",
    });
    const straddlesEnd = event({
      external_id: "c",
      starts_at: "2026-08-18T12:30:00.000Z",
      ends_at: "2026-08-18T13:30:00.000Z",
    });
    const contains = event({
      external_id: "d",
      starts_at: "2026-08-18T10:00:00.000Z",
      ends_at: "2026-08-18T15:00:00.000Z",
    });
    for (const existing of [exact, straddlesStart, straddlesEnd, contains]) {
      expect(findConflicts([existing], NOON)).toHaveLength(1);
    }
  });

  it("treats back-to-back events as adjacent, not colliding", () => {
    const before = event({
      external_id: "a",
      starts_at: "2026-08-18T11:00:00.000Z",
      ends_at: NOON.startsAt,
    });
    const after = event({ external_id: "b", starts_at: NOON.endsAt, ends_at: "2026-08-18T14:00:00.000Z" });
    expect(findConflicts([before, after], NOON)).toEqual([]);
  });

  it("gives an event with no stated end the same hour the detectors give it", () => {
    const openEnded = event({ external_id: "a", starts_at: "2026-08-18T12:30:00.000Z" });
    expect(findConflicts([openEnded], NOON)).toHaveLength(1);
    const wellBefore = event({ external_id: "b", starts_at: "2026-08-18T09:00:00.000Z" });
    expect(findConflicts([wellBefore], NOON)).toEqual([]);
  });

  it("does not let a reschedule conflict with itself", () => {
    const itself = event({ external_id: "self", starts_at: NOON.startsAt, ends_at: NOON.endsAt });
    expect(findConflicts([itself], NOON)).toHaveLength(1);
    expect(findConflicts([itself], { ...NOON, excludeExternalId: "self" })).toEqual([]);
  });

  it("reports collisions earliest first", () => {
    const later = event({
      external_id: "later",
      starts_at: "2026-08-18T12:45:00.000Z",
      ends_at: "2026-08-18T13:45:00.000Z",
    });
    const earlier = event({
      external_id: "earlier",
      starts_at: "2026-08-18T11:15:00.000Z",
      ends_at: "2026-08-18T12:15:00.000Z",
    });
    expect(findConflicts([later, earlier], NOON).map((entry) => entry.external_id)).toEqual([
      "earlier",
      "later",
    ]);
  });
});

describe("what it offers instead", () => {
  const booked = event({
    external_id: "taken",
    starts_at: NOON.startsAt,
    ends_at: NOON.endsAt,
    title: "Design review",
  });

  it("names the collision and offers the nearest openings", () => {
    const result = check({ events: [booked], candidate: NOON });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.conflicts.map((entry) => entry.title)).toEqual(["Design review"]);
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives.length).toBeLessThanOrEqual(3);
  });

  it("orders alternatives by closeness to what was actually asked for", () => {
    const result = check({ events: [booked], candidate: NOON });
    if (result.status !== "conflict") throw new Error("expected a conflict");
    const distances = result.alternatives.map((slot) =>
      Math.abs(Date.parse(slot.startsAt) - Date.parse(NOON.startsAt)),
    );
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it("spaces alternatives by the length of the event, so three options are three options", () => {
    const result = check({ events: [booked], candidate: NOON });
    if (result.status !== "conflict") throw new Error("expected a conflict");
    const starts = result.alternatives.map((slot) => Date.parse(slot.startsAt)).sort((a, b) => a - b);
    for (let index = 1; index < starts.length; index += 1) {
      expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(3_600_000);
    }
  });

  it("never offers a slot that is itself taken", () => {
    const wall = Array.from({ length: 12 }, (_, index) =>
      event({
        external_id: `busy-${index}`,
        starts_at: new Date(Date.parse("2026-08-18T08:00:00.000Z") + index * 3_600_000).toISOString(),
        ends_at: new Date(Date.parse("2026-08-18T09:00:00.000Z") + index * 3_600_000).toISOString(),
      }),
    );
    const result = check({ events: wall, candidate: NOON });
    if (result.status !== "conflict") throw new Error("expected a conflict");
    for (const slot of result.alternatives) {
      expect(findConflicts(wall, { startsAt: slot.startsAt, endsAt: slot.endsAt })).toEqual([]);
    }
  });

  it("offers nothing rather than inventing something when nothing is free", () => {
    const solid = Array.from({ length: 30 }, (_, index) =>
      event({
        external_id: `solid-${index}`,
        starts_at: new Date(Date.parse("2026-08-17T00:00:00.000Z") + index * 43_200_000).toISOString(),
        ends_at: new Date(Date.parse("2026-08-17T12:00:00.000Z") + index * 43_200_000).toISOString(),
      }),
    );
    const slots = findFreeSlots({
      events: solid,
      candidate: NOON,
      coverage: coverage(),
      timezone: TZ,
      now: NOW,
      dayStart: "08:00",
      dayEnd: "20:00",
    });
    expect(slots).toEqual([]);
  });

  it("never offers a slot in the past", () => {
    const result = check({ events: [booked], candidate: NOON });
    if (result.status !== "conflict") throw new Error("expected a conflict");
    for (const slot of result.alternatives) {
      expect(Date.parse(slot.startsAt)).toBeGreaterThanOrEqual(Date.parse(NOW));
    }
  });

  it("aligns the grid to the user's own clock, not to UTC", () => {
    // +05:30. Aligning in UTC would produce :00 and :30 slots that read as :30 and :00
    // locally — correct to a machine, visibly wrong to the person reading them.
    const slots = findFreeSlots({
      events: [booked],
      candidate: NOON,
      coverage: coverage(),
      timezone: "Asia/Kolkata",
      now: NOW,
      dayStart: "08:00",
      dayEnd: "23:00",
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const localMinute = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(slot.startsAt));
      expect([0, 15, 30, 45]).toContain(Number(localMinute));
    }
  });

  it("keeps a deliberately late booking near its own hour rather than exiling it to the morning", () => {
    const lateNight: CandidateEvent = {
      startsAt: "2026-08-18T22:00:00.000Z",
      endsAt: "2026-08-18T23:00:00.000Z",
    };
    const taken = event({
      external_id: "late",
      starts_at: lateNight.startsAt,
      ends_at: lateNight.endsAt,
    });
    const slots = findFreeSlots({
      events: [taken],
      candidate: lateNight,
      coverage: coverage(),
      timezone: TZ,
      now: NOW,
      dayStart: "08:00",
      dayEnd: "20:00",
    });
    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(Math.abs(Date.parse(first.startsAt) - Date.parse(lateNight.startsAt))).toBeLessThanOrEqual(
      4 * 3_600_000,
    );
  });
});

describe("resolving which event the user meant", () => {
  const standup = event({
    external_id: "standup",
    starts_at: "2026-08-18T09:00:00.000Z",
    ends_at: "2026-08-18T09:15:00.000Z",
    title: "Daily standup",
  });
  const dinner = event({
    external_id: "dinner",
    starts_at: "2026-08-18T19:00:00.000Z",
    ends_at: "2026-08-18T21:00:00.000Z",
    title: "Dinner with Priya",
  });
  const review = event({
    external_id: "review",
    starts_at: "2026-08-18T15:00:00.000Z",
    ends_at: "2026-08-18T16:00:00.000Z",
    title: "Design review",
  });
  const options = { timezone: TZ, now: NOW };

  it("resolves a unique title", () => {
    const result = resolveTargetEvent([standup, dinner, review], {
      titleText: "dinner with Priya",
      startsAt: null,
      dateLocal: null,
    }, options);
    expect(result).toMatchObject({ status: "resolved" });
    if (result.status === "resolved") expect(result.event.external_id).toBe("dinner");
  });

  it("resolves a unique time", () => {
    const result = resolveTargetEvent([standup, dinner, review], {
      titleText: null,
      startsAt: "2026-08-18T15:00:00.000Z",
      dateLocal: null,
    }, options);
    expect(result).toMatchObject({ status: "resolved" });
    if (result.status === "resolved") expect(result.event.external_id).toBe("review");
  });

  // The rule that matters most: with nothing downstream to catch a wrong guess, two
  // plausible targets must produce a question rather than a coin flip.
  it("refuses to choose between two events at the same time", () => {
    const other = event({
      external_id: "other",
      starts_at: "2026-08-18T15:00:00.000Z",
      ends_at: "2026-08-18T16:00:00.000Z",
      title: "Vendor call",
    });
    const result = resolveTargetEvent([review, other], {
      titleText: null,
      startsAt: "2026-08-18T15:00:00.000Z",
      dateLocal: null,
    }, options);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  it("refuses to choose between two events sharing a title", () => {
    const second = event({
      external_id: "review-2",
      starts_at: "2026-08-19T15:00:00.000Z",
      ends_at: "2026-08-19T16:00:00.000Z",
      title: "Design review",
    });
    const result = resolveTargetEvent([review, second], {
      titleText: "design review",
      startsAt: null,
      dateLocal: null,
    }, options);
    expect(result.status).toBe("ambiguous");
  });

  it("reports not_found rather than reaching for the nearest thing", () => {
    const result = resolveTargetEvent([standup, dinner], {
      titleText: "quarterly board meeting",
      startsAt: null,
      dateLocal: null,
    }, options);
    expect(result).toEqual({ status: "not_found" });
  });

  it("ignores events that have already finished but keeps one still running", () => {
    const finished = event({
      external_id: "finished",
      starts_at: "2026-08-17T06:00:00.000Z",
      ends_at: "2026-08-17T07:00:00.000Z",
      title: "Early call",
    });
    const running = event({
      external_id: "running",
      starts_at: "2026-08-17T08:45:00.000Z",
      ends_at: "2026-08-17T09:45:00.000Z",
      title: "Early call",
    });
    const result = resolveTargetEvent([finished, running], {
      titleText: "early call",
      startsAt: null,
      dateLocal: null,
    }, options);
    expect(result).toMatchObject({ status: "resolved" });
    if (result.status === "resolved") expect(result.event.external_id).toBe("running");
  });

  it("matches a local calendar day rather than a UTC one", () => {
    // 23:30 UTC on the 18th is 08:30 on the 19th in Tokyo. Someone in Tokyo asking about
    // "the 19th" means their 19th.
    const lateUtc = event({
      external_id: "tokyo-morning",
      starts_at: "2026-08-18T23:30:00.000Z",
      ends_at: "2026-08-19T00:30:00.000Z",
      title: "Morning sync",
    });
    const result = resolveTargetEvent([lateUtc], {
      titleText: null,
      startsAt: null,
      dateLocal: "2026-08-19",
    }, { timezone: "Asia/Tokyo", now: NOW });
    expect(result).toMatchObject({ status: "resolved" });
  });
});

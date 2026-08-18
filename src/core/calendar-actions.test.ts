import { describe, expect, it } from "vitest";

import {
  buildCalendarPayload,
  changeOf,
  previewFor,
  resolvedEnd,
} from "./calendar-actions";
import type { CalendarWriteRequest } from "./calendar-actions";
import type { CachedEvent } from "./calendar-time";

/**
 * The bytes a calendar change actually sends, and the sentence a person reads before
 * approving it.
 *
 * This file did not exist while `buildCalendarPayload` and `previewFor` were the two places
 * a move's real times were decided and shown. The end-to-end tests passed both times in as
 * their own input and asserted the payload echoed them, which cannot catch a derivation
 * being wrong — and it was: a move with no stated end became a flat hour, so an agreed
 * 10:00-10:30 went out as 10:30-11:30.
 */

const NOW = "2026-08-19T22:00:00.000Z";

function event(overrides: Partial<CachedEvent> = {}): CachedEvent {
  return {
    external_id: "evt-shower",
    starts_at: "2026-08-20T10:00:00.000Z",
    ends_at: "2026-08-20T11:00:00.000Z",
    location: null,
    title: "wake up and shower",
    ...overrides,
  };
}

function move(overrides: Partial<Extract<CalendarWriteRequest, { kind: "reschedule" }>> = {}) {
  return {
    kind: "reschedule" as const,
    reference: { titleText: "wake up and shower", startsAt: null, dateLocal: null },
    startsAt: "2026-08-20T10:30:00.000Z",
    endsAt: null,
    timezone: "UTC",
    detailsFrom: "user_message" as const,
    ...overrides,
  };
}

describe("a move keeps the length the event already has", () => {
  it("preserves a half-hour event rather than stretching it to an hour", () => {
    const target = event({
      starts_at: "2026-08-20T09:00:00.000Z",
      ends_at: "2026-08-20T09:30:00.000Z",
    });
    expect(buildCalendarPayload(move(), target)).toMatchObject({
      event_id: "evt-shower",
      start: "2026-08-20T10:30:00.000Z",
      end: "2026-08-20T11:00:00.000Z",
    });
  });

  it("preserves a two-hour event rather than shrinking it to an hour", () => {
    const target = event({
      starts_at: "2026-08-20T09:00:00.000Z",
      ends_at: "2026-08-20T11:00:00.000Z",
    });
    expect(buildCalendarPayload(move(), target)).toMatchObject({
      end: "2026-08-20T12:30:00.000Z",
    });
  });

  it("takes a stated end over the event's current length", () => {
    // The agreed change from the report. A shrink is a legitimate thing to ask for, and it
    // has to beat the event's own duration or "move it to 10-10:30" cannot be carried out.
    const payload = buildCalendarPayload(
      move({ startsAt: "2026-08-20T10:00:00.000Z", endsAt: "2026-08-20T10:30:00.000Z" }),
      event(),
    );
    expect(payload).toMatchObject({
      start: "2026-08-20T10:00:00.000Z",
      end: "2026-08-20T10:30:00.000Z",
    });
  });

  it("falls back to the shared missing-end rule when the service gave no end", () => {
    // `endOf` already treats an endless entry as an hour for the overlap check. Reusing it
    // here keeps one definition rather than letting the write acquire a quieter second one.
    expect(resolvedEnd(move(), event({ ends_at: null }))).toBe("2026-08-20T11:30:00.000Z");
  });
});

describe("the sentence shown before a change is sent", () => {
  it("is written in the user's clock, not as UTC instants", () => {
    // It used to read `to 2026-08-20T10:30:00.000Z–2026-08-20T11:30:00.000Z`, which is
    // unreadable at exactly the moment reading it is the last check left.
    const preview = previewFor(
      move({ startsAt: "2026-08-20T10:00:00.000Z", endsAt: "2026-08-20T10:30:00.000Z" }),
      event(),
      NOW,
    );
    expect(preview).toBe(
      "Move “wake up and shower” from tomorrow 10:00–11:00 AM to tomorrow 10:00–10:30 AM.",
    );
    expect(preview).not.toContain("Z");
  });

  it("says where the event is moving from, because that is the question being asked", () => {
    expect(previewFor(move(), event(), NOW)).toContain("from tomorrow 10:00–11:00 AM");
  });

  it("names the time a cancel is removing", () => {
    const request: CalendarWriteRequest = {
      kind: "cancel",
      reference: { titleText: "wake up and shower", startsAt: null, dateLocal: null },
      timezone: "UTC",
      detailsFrom: "user_message",
    };
    expect(previewFor(request, event(), NOW)).toBe(
      "Cancel “wake up and shower”, tomorrow 10:00–11:00 AM.",
    );
  });
});

describe("the change carried with the outcome", () => {
  it("records both sides of a move, with the length it will actually run", () => {
    expect(changeOf(move(), event())).toEqual({
      title: "wake up and shower",
      timezone: "UTC",
      from: { startsAt: "2026-08-20T10:00:00.000Z", endsAt: "2026-08-20T11:00:00.000Z" },
      to: { startsAt: "2026-08-20T10:30:00.000Z", endsAt: "2026-08-20T11:30:00.000Z" },
    });
  });

  it("leaves out the side that does not exist", () => {
    const create: CalendarWriteRequest = {
      kind: "create",
      title: "Lunch",
      startsAt: "2026-08-20T12:00:00.000Z",
      endsAt: "2026-08-20T13:00:00.000Z",
      location: null,
      timezone: "UTC",
      detailsFrom: "user_message",
    };
    expect(changeOf(create, null)).toMatchObject({ from: null });
    expect(
      changeOf(
        {
          kind: "cancel",
          reference: { titleText: "x", startsAt: null, dateLocal: null },
          timezone: "UTC",
          detailsFrom: "user_message",
        },
        event(),
      ),
    ).toMatchObject({ to: null });
  });
});

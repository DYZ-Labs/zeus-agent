import { describe, expect, it } from "vitest";

import {
  containsCalendarRefusalSignal,
  localToUtc,
  mayBeCalendarRequest,
  resolveCalendarRequest,
} from "./calendar-intent";
import type { CalendarIntent } from "./calendar-intent";
import type { EvaluationContext } from "./schema";

const CONTEXT: EvaluationContext = {
  trigger: "chat",
  evaluated_at: "2026-08-17T09:00:00.000Z",
  timezone: "UTC",
  local_weekday: "mon",
  local_time: "09:00",
  daypart: "morning",
  location_zone: null,
  location_observed_at: null,
};

function intent(overrides: Partial<CalendarIntent> = {}): CalendarIntent {
  return {
    intent: "create",
    confidence: "high",
    title: "Lunch with Sam",
    starts_at_local: "2026-08-18T12:00",
    ends_at_local: null,
    location: null,
    target: null,
    is_negated: false,
    is_hypothetical_or_quoted: false,
    is_about_another_person: false,
    ...overrides,
  };
}

describe("noticing that a message might be about a calendar", () => {
  // Each of these is a phrasing the regexes this module replaces would have dropped on the
  // floor, because they required the message to begin with a create verb.
  it.each([
    "can we get dinner on the calendar for friday",
    "I need to get dinner with Sam on the calendar",
    "block 2-3 for deep work",
    "pencil me in for thursday morning",
    "shift standup to 10",
    "kill my 4pm",
    "put me down for the 9am",
    "clear my afternoon on tuesday",
    "is my tuesday free",
    "move the design review to next week",
    "I should probably book a dentist appointment tomorrow",
    "set up a sync with Priya wednesday",
  ])("considers %j", (message) => {
    expect(mayBeCalendarRequest(message)).toBe(true);
  });

  it.each([
    "what did we decide about the pricing model",
    "can you summarise that document",
    "thanks, that's helpful",
    "",
  ])("skips %j without paying for a model call", (message) => {
    expect(mayBeCalendarRequest(message)).toBe(false);
  });
});

describe("the veto can only ever take away", () => {
  it("acts on a clear request", () => {
    expect(resolveCalendarRequest("add lunch with Sam tomorrow at noon", intent(), CONTEXT)).toMatchObject({
      kind: "create",
      title: "Lunch with Sam",
      startsAt: "2026-08-18T12:00:00.000Z",
      // No stated end becomes an hour, decided here rather than by the model.
      endsAt: "2026-08-18T13:00:00.000Z",
    });
  });

  it.each([
    ["negated", { is_negated: true }],
    ["hypothetical", { is_hypothetical_or_quoted: true }],
    ["someone else's", { is_about_another_person: true }],
    ["uncertain", { confidence: "low" as const }],
  ])("refuses a request the model flagged as %s", (_label, overrides) => {
    expect(resolveCalendarRequest("add lunch tomorrow", intent(overrides), CONTEXT)).toBeNull();
  });

  it("refuses when the message itself reads as a refusal, whatever the model said", () => {
    expect(
      resolveCalendarRequest("actually, don't put that on my calendar", intent(), CONTEXT),
    ).toBeNull();
    expect(
      resolveCalendarRequest("add Google Calendar integration support", intent(), CONTEXT),
    ).toBeNull();
  });

  it("catches a negation that is not at the start of the sentence", () => {
    expect(containsCalendarRefusalSignal("actually, don't add that to my calendar")).toBe(true);
    expect(containsCalendarRefusalSignal("add that to my calendar")).toBe(false);
  });

  it("refuses an event with no name, which nothing downstream could sanity-check", () => {
    expect(resolveCalendarRequest("add it", intent({ title: "  " }), CONTEXT)).toBeNull();
  });

  it("refuses times that do not parse, invert, or belong to this decade", () => {
    expect(
      resolveCalendarRequest("x", intent({ starts_at_local: "sometime next week" }), CONTEXT),
    ).toBeNull();
    expect(
      resolveCalendarRequest(
        "x",
        intent({ starts_at_local: "2026-08-18T12:00", ends_at_local: "2026-08-18T11:00" }),
        CONTEXT,
      ),
    ).toBeNull();
    expect(
      resolveCalendarRequest("x", intent({ starts_at_local: "2031-08-18T12:00" }), CONTEXT),
    ).toBeNull();
  });

  it("refuses an event longer than a day, which is a parse failure rather than a plan", () => {
    expect(
      resolveCalendarRequest(
        "x",
        intent({ starts_at_local: "2026-08-18T12:00", ends_at_local: "2026-08-25T12:00" }),
        CONTEXT,
      ),
    ).toBeNull();
  });

  it("never turns nothing into something", () => {
    expect(resolveCalendarRequest("add lunch tomorrow", intent({ intent: "none" }), CONTEXT)).toBeNull();
  });
});

describe("changing an existing event", () => {
  it("carries the user's own description of the target through, never an identifier", () => {
    const result = resolveCalendarRequest(
      "move my 3pm to 4",
      intent({
        intent: "reschedule",
        title: null,
        starts_at_local: "2026-08-17T16:00",
        target: { title_text: null, starts_at_local: "2026-08-17T15:00", date_local: null },
      }),
      CONTEXT,
    );
    expect(result).toMatchObject({
      kind: "reschedule",
      reference: { startsAt: "2026-08-17T15:00:00.000Z", titleText: null },
      startsAt: "2026-08-17T16:00:00.000Z",
    });
  });

  it("cancels by description", () => {
    expect(
      resolveCalendarRequest(
        "cancel dinner tomorrow",
        intent({
          intent: "cancel",
          title: null,
          starts_at_local: null,
          target: { title_text: "dinner", starts_at_local: null, date_local: "2026-08-18" },
        }),
        CONTEXT,
      ),
    ).toMatchObject({
      kind: "cancel",
      reference: { titleText: "dinner", dateLocal: "2026-08-18" },
    });
  });

  it("refuses a target with nothing to match on, rather than taking whatever is next", () => {
    expect(
      resolveCalendarRequest(
        "move my meeting",
        intent({
          intent: "reschedule",
          starts_at_local: "2026-08-17T16:00",
          target: { title_text: null, starts_at_local: null, date_local: null },
        }),
        CONTEXT,
      ),
    ).toBeNull();
    expect(
      resolveCalendarRequest(
        "cancel it",
        intent({ intent: "cancel", target: null }),
        CONTEXT,
      ),
    ).toBeNull();
  });
});

describe("wall-clock to instant", () => {
  it("resolves a plain zone", () => {
    expect(localToUtc("2026-08-18T12:00", "UTC")).toBe("2026-08-18T12:00:00.000Z");
  });

  it("resolves a half-hour zone", () => {
    // +05:30 — the case a fixed hourly offset gets wrong every time.
    expect(localToUtc("2026-08-18T12:00", "Asia/Kolkata")).toBe("2026-08-18T06:30:00.000Z");
  });

  it("resolves both sides of a daylight-saving change", () => {
    // London is +01:00 in August and +00:00 in January. Asking a model for the offset is
    // what this conversion exists to avoid.
    expect(localToUtc("2026-08-18T12:00", "Europe/London")).toBe("2026-08-18T11:00:00.000Z");
    expect(localToUtc("2026-01-18T12:00", "Europe/London")).toBe("2026-01-18T12:00:00.000Z");
  });

  it("resolves a zone behind UTC across a date boundary", () => {
    expect(localToUtc("2026-08-18T21:00", "America/New_York")).toBe("2026-08-19T01:00:00.000Z");
  });

  it("returns null rather than a guess for anything unparsable", () => {
    expect(localToUtc("next tuesday", "UTC")).toBeNull();
    expect(localToUtc("2026-08-18", "UTC")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  containsCalendarRefusalSignal,
  directCalendarReadRequest,
  isCalendarCapabilityQuestion,
  isExplicitCalendarActionRequest,
  localToUtc,
  mayBeCalendarRequest,
  refusalIsSpoken,
  resolveCalendarRequest,
  SPOKEN_REFUSAL_REASONS,
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
    details_from: "user_message",
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
  it.each([
    "What is on my calendar tomorrow?",
    "Show me my calendar for tomorrow.",
    "Please check my work schedule this week.",
    "Can you check my appointments?",
    "Can you access my calendar and tell me what I have tomorrow?",
  ])("resolves a direct contents request without conversational history: %j", (message) => {
    expect(directCalendarReadRequest(message, CONTEXT)).toEqual({
      kind: "read",
      from: "2026-08-17T09:00:00.000Z",
      to: "2026-09-16T09:00:00.000Z",
      timezone: "UTC",
    });
  });

  it.each([
    "is Google Calendar connected?",
    "do you have access to my calendar",
    "Can you tell me if my calendar is connected?",
    "don't read my calendar",
    "what if you read my calendar",
    "Alice can read my calendar",
    "add Google Calendar integration support",
    "cancel my meeting",
  ])("keeps a non-read or unsafe request out of the direct path: %j", (message) => {
    expect(directCalendarReadRequest(message, CONTEXT)).toBeNull();
  });

  it.each([
    "is Google Calendar connected?",
    "do you have access to my calendar",
    "is the calendar integration enabled",
  ])("treats %j as a capability question", (message) => {
    expect(isCalendarCapabilityQuestion(message)).toBe(true);
  });

  it("does not confuse a contents question with a connection question", () => {
    expect(isCalendarCapabilityQuestion("what is on my calendar tomorrow?")).toBe(false);
    expect(isCalendarCapabilityQuestion("what times are available on my calendar?")).toBe(false);
    expect(
      isCalendarCapabilityQuestion(
        "Can you access my calendar and tell me what I have tomorrow?",
      ),
    ).toBe(false);
  });

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
    // Answering a slot Zeus just offered. Requiring an action verb here meant Zeus
    // ignored people accepting its own suggestions.
    "yes, 1pm works",
    "make it thursday instead",
    "the 3pm one",
    "how about 10:30",
    // No time and no calendar noun, but unmistakably about an appointment.
    "cancel the design review",
    "reschedule the offsite",
    "postpone my one-on-one with Dana",
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

describe("the messages that used to reach nothing at all", () => {
  // Every message in the reported conversation failed this filter, so no calendar was ever
  // opened and no result block ever reached the model — which is why it answered from its own
  // earlier sentences and described a change that never happened. The filter is meant to be
  // over-inclusive: a false positive costs one cheap classifier call, a false negative costs
  // the whole feature.
  it.each([
    "so can i go out at 1030",
    "can i shower in 30 mins?",
    "but im going out at 1030",
    "free at 7?",
    "am i busy from 9.30",
  ])("notices %j", (message) => {
    expect(mayBeCalendarRequest(message)).toBe(true);
  });

  it("notices an acceptance only when what it accepts was a calendar request", () => {
    const proposal = "Your calendar blocks 10–11, so move “wake up and shower” to 10–10:30.";
    expect(mayBeCalendarRequest("ok do it", { previousAssistantText: proposal })).toBe(true);
    expect(mayBeCalendarRequest("go ahead", { previousAssistantText: proposal })).toBe(true);
    // The same words after anything else are just words. Judging them on their own is what
    // would turn every "ok" in every conversation into a classifier call.
    expect(
      mayBeCalendarRequest("ok do it", { previousAssistantText: "Here's a draft of the essay." }),
    ).toBe(false);
    expect(mayBeCalendarRequest("ok do it")).toBe(false);
  });

  it("does not read a year as a time of day", () => {
    expect(mayBeCalendarRequest("it happened in 2026 apparently")).toBe(false);
  });
});

describe("the veto can only ever take away", () => {
  it("acts on a clear request", () => {
    expect(
      resolveCalendarRequest("add lunch with Sam tomorrow at noon", intent(), CONTEXT),
    ).toMatchObject({
      status: "request",
      request: {
        kind: "create",
        title: "Lunch with Sam",
        startsAt: "2026-08-18T12:00:00.000Z",
        // No stated end becomes an hour, decided here rather than by the model.
        endsAt: "2026-08-18T13:00:00.000Z",
      },
    });
  });

  it.each([
    ["negated", { is_negated: true }, "negated"],
    ["hypothetical", { is_hypothetical_or_quoted: true }, "hypothetical_or_quoted"],
    ["someone else's", { is_about_another_person: true }, "another_person"],
    ["uncertain", { confidence: "low" as const }, "low_confidence_write"],
  ])("refuses a request the model flagged as %s", (_label, overrides, reason) => {
    expect(resolveCalendarRequest("add lunch tomorrow", intent(overrides), CONTEXT)).toMatchObject({
      status: "refused",
      reason,
    });
  });

  it("refuses when the message itself reads as a refusal, whatever the model said", () => {
    expect(
      resolveCalendarRequest("actually, don't put that on my calendar", intent(), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "refusal_signal_in_message" });
    expect(
      resolveCalendarRequest("add Google Calendar integration support", intent(), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "refusal_signal_in_message" });
  });

  it("catches a negation that is not at the start of the sentence", () => {
    expect(containsCalendarRefusalSignal("actually, don't add that to my calendar")).toBe(true);
    expect(containsCalendarRefusalSignal("add that to my calendar")).toBe(false);
  });

  it("refuses an event with no name, which nothing downstream could sanity-check", () => {
    expect(resolveCalendarRequest("add it", intent({ title: "  " }), CONTEXT)).toMatchObject({
      status: "refused",
      reason: "no_title",
    });
  });

  it("refuses times that do not parse, invert, or belong to this decade", () => {
    expect(
      resolveCalendarRequest("x", intent({ starts_at_local: "sometime next week" }), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "unparsable_start" });
    expect(
      resolveCalendarRequest(
        "x",
        intent({ starts_at_local: "2026-08-18T12:00", ends_at_local: "2026-08-18T11:00" }),
        CONTEXT,
      ),
    ).toMatchObject({ status: "refused", reason: "implausible_duration" });
    expect(
      resolveCalendarRequest("x", intent({ starts_at_local: "2031-08-18T12:00" }), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "implausible_date" });
  });

  it("refuses an event longer than a day, which is a parse failure rather than a plan", () => {
    expect(
      resolveCalendarRequest(
        "x",
        intent({ starts_at_local: "2026-08-18T12:00", ends_at_local: "2026-08-25T12:00" }),
        CONTEXT,
      ),
    ).toMatchObject({ status: "refused", reason: "implausible_duration" });
  });

  it("never turns nothing into something", () => {
    expect(
      resolveCalendarRequest("add lunch tomorrow", intent({ intent: "none" }), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "no_calendar_intent" });
  });

  it("separates refusals the user should hear from the ones that would be noise", () => {
    // `mayBeCalendarRequest` is over-inclusive on purpose, so speaking for
    // `no_calendar_intent` would put a calendar card under "dinner was great".
    expect(refusalIsSpoken("no_calendar_intent")).toBe(false);
    expect(refusalIsSpoken("negated")).toBe(false);
    expect(refusalIsSpoken("another_person")).toBe(false);
    expect(refusalIsSpoken("hypothetical_or_quoted")).toBe(false);
    expect(refusalIsSpoken("refusal_signal_in_message")).toBe(false);
    for (const reason of SPOKEN_REFUSAL_REASONS) expect(refusalIsSpoken(reason)).toBe(true);
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
      status: "request",
      request: {
        kind: "reschedule",
        reference: { startsAt: "2026-08-17T15:00:00.000Z", titleText: null },
        startsAt: "2026-08-17T16:00:00.000Z",
      },
      note: null,
    });
  });

  it("keeps the event's own length when a move states no new end", () => {
    // The bug this replaces, exactly: a move with no stated end took `start + 1 hour`, so an
    // agreed 10:00-10:30 was written as 10:30-11:30 — half an hour late and twice as long.
    // The length is not knowable here, because the target is not resolved until the calendar
    // has been read, so the honest answer is to say nothing rather than guess an hour.
    expect(
      resolveCalendarRequest(
        "push wake up and shower to 10:30",
        intent({
          intent: "reschedule",
          title: null,
          starts_at_local: "2026-08-17T10:30",
          ends_at_local: null,
          target: { title_text: "wake up and shower", starts_at_local: null, date_local: null },
        }),
        CONTEXT,
      ),
    ).toMatchObject({
      status: "request",
      request: {
        kind: "reschedule",
        startsAt: "2026-08-17T10:30:00.000Z",
        endsAt: null,
      },
    });
  });

  it("takes the stated end of a move over the event's current length", () => {
    // The turn from the report: Zeus proposed 10:00-10:30, the user said "ok do it". Both
    // ends of the agreed window have to survive to the request, or the change carried out is
    // not the one that was agreed.
    expect(
      resolveCalendarRequest(
        "ok do it",
        intent({
          intent: "reschedule",
          title: null,
          starts_at_local: "2026-08-17T10:00",
          ends_at_local: "2026-08-17T10:30",
          details_from: "earlier_proposal",
          target: { title_text: "wake up and shower", starts_at_local: null, date_local: null },
        }),
        CONTEXT,
      ),
    ).toMatchObject({
      status: "request",
      request: {
        kind: "reschedule",
        startsAt: "2026-08-17T10:00:00.000Z",
        endsAt: "2026-08-17T10:30:00.000Z",
        // Carried through so the standing setting can decline to act unattended on times the
        // user never typed.
        detailsFrom: "earlier_proposal",
      },
    });
  });

  it("still refuses a move whose stated end is before its start", () => {
    expect(
      resolveCalendarRequest(
        "move dinner to 7pm until 6pm",
        intent({
          intent: "reschedule",
          title: null,
          starts_at_local: "2026-08-17T19:00",
          ends_at_local: "2026-08-17T18:00",
          target: { title_text: "dinner", starts_at_local: null, date_local: null },
        }),
        CONTEXT,
      ),
    ).toMatchObject({ status: "refused", reason: "implausible_duration" });
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
      status: "request",
      request: { kind: "cancel", reference: { titleText: "dinner", dateLocal: "2026-08-18" } },
    });
  });

  it("refuses a target with nothing to match on, rather than taking whatever is next", () => {
    expect(
      resolveCalendarRequest(
        "move my meeting",
        intent({
          intent: "reschedule",
          title: null,
          starts_at_local: "2026-08-17T16:00",
          target: { title_text: null, starts_at_local: null, date_local: null },
        }),
        CONTEXT,
      ),
    ).toMatchObject({ status: "refused", reason: "no_target_reference" });
    expect(
      resolveCalendarRequest(
        "cancel it",
        intent({ intent: "cancel", title: null, target: null }),
        CONTEXT,
      ),
    ).toMatchObject({ status: "refused", reason: "no_target_reference" });
  });

  it("reads the words the user used even when the model put them in the wrong field", () => {
    // The schema offers both `title` and `target.title_text`; a model that fills the first
    // for a reschedule has still said plainly which event is meant.
    expect(
      resolveCalendarRequest(
        "move dinner to 7:30pm",
        intent({
          intent: "reschedule",
          title: "dinner",
          starts_at_local: "2026-08-17T19:30",
          target: null,
        }),
        CONTEXT,
      ),
    ).toMatchObject({
      status: "request",
      request: { kind: "reschedule", reference: { titleText: "dinner" } },
    });
  });

  it("refuses to identify an event by the time it is being moved to", () => {
    // "move dinner to 7:30pm" carries exactly one time, and it is the destination. Left in
    // the target it filters the real dinner out of the pool, and the run then reports that
    // nothing on the calendar matches — a denial about a calendar that was read correctly.
    const result = resolveCalendarRequest(
      "move dinner to 7:30pm",
      intent({
        intent: "reschedule",
        title: null,
        starts_at_local: "2026-08-17T19:30",
        target: { title_text: "dinner", starts_at_local: "2026-08-17T19:30", date_local: null },
      }),
      CONTEXT,
    );
    expect(result).toMatchObject({
      status: "request",
      request: {
        kind: "reschedule",
        reference: { titleText: "dinner", startsAt: null },
        startsAt: "2026-08-17T19:30:00.000Z",
      },
      note: "target_time_was_destination",
    });
  });

  it("refuses rather than widening when the destination time was the only discriminator", () => {
    expect(
      resolveCalendarRequest(
        "move it to 7:30pm",
        intent({
          intent: "reschedule",
          title: null,
          starts_at_local: "2026-08-17T19:30",
          target: { title_text: null, starts_at_local: "2026-08-17T19:35", date_local: null },
        }),
        CONTEXT,
      ),
    ).toMatchObject({ status: "refused", reason: "no_target_reference" });
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

/**
 * Emptying a stretch of time, which is the one calendar action that touches several events
 * at once — and therefore the one where a misread span is expensive.
 */
describe("clearing a window", () => {
  function clearIntent(overrides: Partial<CalendarIntent> = {}): CalendarIntent {
    return intent({
      intent: "clear",
      title: null,
      starts_at_local: "2026-08-20T12:00",
      ends_at_local: "2026-08-20T18:00",
      target: null,
      ...overrides,
    });
  }

  it("resolves a span the user described at both ends", () => {
    expect(
      resolveCalendarRequest("clear my Thursday afternoon", clearIntent(), CONTEXT),
    ).toEqual({
      status: "request",
      request: {
        kind: "clear",
        from: "2026-08-20T12:00:00.000Z",
        to: "2026-08-20T18:00:00.000Z",
        timezone: "UTC",
        detailsFrom: "user_message",
      },
      note: null,
    });
  });

  /**
   * Inferring the missing end would be deciding how much of someone's day disappears, which
   * is not a detail worth guessing to save one question.
   */
  it.each([
    ["no end", { ends_at_local: null }],
    ["no start", { starts_at_local: null }],
    ["an unreadable bound", { ends_at_local: "later on" }],
  ])("refuses a span missing %s", (_label, overrides) => {
    expect(
      resolveCalendarRequest("clear my afternoon", clearIntent(overrides), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "no_clear_window" });
  });

  it.each([
    ["inverted", { starts_at_local: "2026-08-20T18:00", ends_at_local: "2026-08-20T12:00" }],
    ["longer than a week", { starts_at_local: "2026-08-20T00:00", ends_at_local: "2026-09-20T00:00" }],
  ])("refuses a span that is %s", (_label, overrides) => {
    expect(
      resolveCalendarRequest("clear all of that", clearIntent(overrides), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "implausible_clear_window" });
  });

  it("refuses a guessed span, the same as any other write", () => {
    expect(
      resolveCalendarRequest("clear some of tomorrow", clearIntent({ confidence: "low" }), CONTEXT),
    ).toMatchObject({ status: "refused", reason: "low_confidence_write" });
  });

  it.each([
    ["negated", { is_negated: true }],
    ["hypothetical", { is_hypothetical_or_quoted: true }],
    ["about someone else", { is_about_another_person: true }],
  ])("never clears anything when the request is %s", (_label, overrides) => {
    expect(
      resolveCalendarRequest("clear my Thursday", clearIntent(overrides), CONTEXT),
    ).toMatchObject({ status: "refused" });
  });

  it("says both new refusals out loud, because the user did ask for something", () => {
    expect(refusalIsSpoken("no_clear_window")).toBe(true);
    expect(refusalIsSpoken("implausible_clear_window")).toBe(true);
    expect(SPOKEN_REFUSAL_REASONS).toContain("no_clear_window");
  });

  it("reaches the classifier from the words people actually use", () => {
    for (const message of [
      "clear my Thursday afternoon",
      "wipe Friday morning off my calendar",
      "get everything off my Monday",
    ]) {
      expect(mayBeCalendarRequest(message)).toBe(true);
      expect(directCalendarReadRequest(message, CONTEXT)).toBeNull();
    }
  });
});

/**
 * A conversation already about the calendar lowers the bar for what reaches the classifier.
 * Without it, "and after that?" was dropped before anything could recognize it.
 */
describe("following up on a calendar turn", () => {
  it.each(["and after that?", "did that go through?", "the second one", "move it later"])(
    "passes a short follow-up to the classifier: %j",
    (message) => {
      expect(mayBeCalendarRequest(message)).toBe(false);
      expect(mayBeCalendarRequest(message, { afterCalendarTurn: true })).toBe(true);
    },
  );

  it("does not widen to an essay, which is a change of subject rather than a follow-up", () => {
    const long = "I have been thinking about the pitch deck all week and ".repeat(3);
    expect(mayBeCalendarRequest(long, { afterCalendarTurn: true })).toBe(false);
  });
});

describe("which messages are owed an answer when recognition fails", () => {
  it("recognizes a message that named an action and something to do it to", () => {
    expect(isExplicitCalendarActionRequest("move dinner to 7:30pm tomorrow")).toBe(true);
    expect(isExplicitCalendarActionRequest("cancel the design review")).toBe(true);
    expect(isExplicitCalendarActionRequest("add lunch with Sam at 1pm")).toBe(true);
    expect(isExplicitCalendarActionRequest("clear my Thursday afternoon")).toBe(true);
    expect(isExplicitCalendarActionRequest("reschedule that")).toBe(true);
  });

  it("leaves the loose prefilter hits alone", () => {
    // Every one of these passes `mayBeCalendarRequest`, which is correct — each is worth a
    // classifier call. None of them asked for a change, so none is owed a report when that
    // call fails; saying "I couldn't work out what to do with your calendar" would invent a
    // request the user never made.
    for (const message of [
      "we should grab coffee sometime",
      "dinner with Priya was great tonight",
      "and after that?",
      "my standup is the worst part of the week",
    ]) {
      expect(mayBeCalendarRequest(message, { afterCalendarTurn: true })).toBe(true);
      expect(isExplicitCalendarActionRequest(message)).toBe(false);
    }
  });
});

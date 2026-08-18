import { describe, expect, it } from "vitest";

import { describeInterval } from "./calendar-time";

/**
 * One way to write a window.
 *
 * Before this existed the same interval was formatted three ways — UTC ISO instants in the
 * confirmation preview, a browser-locale range in the card, and whatever the model wrote in
 * prose — so there was no way to notice that two of them disagreed.
 */

const NOW = "2026-08-19T22:00:00.000Z";

describe("writing a time window", () => {
  it("says the meridiem once when it does not change", () => {
    expect(describeInterval("2026-08-20T10:00:00.000Z", "2026-08-20T10:30:00.000Z", "UTC", NOW))
      .toBe("tomorrow 10:00–10:30 AM");
  });

  it("says it twice when it does", () => {
    expect(describeInterval("2026-08-20T11:30:00.000Z", "2026-08-20T12:30:00.000Z", "UTC", NOW))
      .toBe("tomorrow 11:30 AM–12:30 PM");
  });

  it("reads the clock in the user's zone, not in UTC", () => {
    // The same instant is 22:30 in UTC and half past eight the next morning in Sydney. Both
    // the hour and the day come from the user's zone, so the sentence and the calendar agree
    // about which morning is meant.
    expect(
      describeInterval("2026-08-19T22:30:00.000Z", "2026-08-19T23:00:00.000Z", "Australia/Sydney", NOW),
    ).toBe("today 8:30–9:00 AM");
    expect(
      describeInterval("2026-08-19T22:30:00.000Z", "2026-08-19T23:00:00.000Z", "UTC", NOW),
    ).toBe("today 10:30–11:00 PM");
  });

  it("handles a half-hour zone", () => {
    // Offsets are taken from Intl rather than arithmetic, or Kolkata lands on :00 boundaries
    // it does not have.
    expect(
      describeInterval("2026-08-20T04:30:00.000Z", "2026-08-20T05:30:00.000Z", "Asia/Kolkata", NOW),
    ).toBe("today 10:00–11:00 AM");
  });

  it("names both ends when a window crosses midnight", () => {
    expect(describeInterval("2026-08-20T23:00:00.000Z", "2026-08-21T01:00:00.000Z", "UTC", NOW))
      .toBe("tomorrow 11:00 PM – Fri 21 Aug 1:00 AM");
  });

  it("names the day outright when it has no clock to be relative to", () => {
    // What a server render passes. A relative label resolved against two different clocks is
    // a hydration mismatch, and "tomorrow" is not worth one.
    expect(describeInterval("2026-08-20T10:00:00.000Z", "2026-08-20T10:30:00.000Z", "UTC", null))
      .toBe("Thu 20 Aug 10:00–10:30 AM");
  });

  it("says a start alone rather than inventing an end", () => {
    expect(describeInterval("2026-08-20T10:00:00.000Z", null, "UTC", NOW))
      .toBe("tomorrow from 10:00 AM");
  });
});

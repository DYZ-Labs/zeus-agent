import { describe, expect, it } from "vitest";

import { calendarListEventArguments } from "./calendar-sync";

const window = {
  from: "2026-08-16T00:00:00.000Z",
  to: "2026-09-15T00:00:00.000Z",
};

describe("calendar list arguments", () => {
  it("uses the hosted broker's reviewed window fields", () => {
    expect(calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    }), window)).toEqual({ from: window.from, to: window.to });
  });

  it("uses Google Calendar MCP's reviewed window fields", () => {
    expect(calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: {
        calendarId: { type: "string" },
        startTime: { type: "string" },
        endTime: { type: "string" },
      },
      required: ["calendarId"],
    }), window)).toEqual({
      calendarId: "primary",
      startTime: window.from,
      endTime: window.to,
    });
  });

  it("supports the earlier preview field names without widening the request", () => {
    expect(calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: { timeMin: { type: "string" }, timeMax: { type: "string" } },
    }), window)).toEqual({ timeMin: window.from, timeMax: window.to });
  });

  it("fails closed for an unbounded or newly-required contract", () => {
    expect(() => calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: { query: { type: "string" } },
    }), window)).toThrow(/no supported bounded time window/u);
    expect(() => calendarListEventArguments(JSON.stringify({
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        account: { type: "string" },
      },
      required: ["from", "to", "account"],
    }), window)).toThrow(/requires unsupported field account/u);
  });
});

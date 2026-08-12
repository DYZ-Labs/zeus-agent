import { describe, expect, it } from "vitest";

import { isExplicitBoundedWorkRequest } from "./chat";

describe("bounded work request authorization", () => {
  it("accepts narrow, direct multi-step requests", () => {
    expect(
      isExplicitBoundedWorkRequest("Research local backup options and draft a recommendation."),
    ).toBe(true);
    expect(
      isExplicitBoundedWorkRequest("Can you compare the vendors, then prepare a brief?"),
    ).toBe(true);
    expect(
      isExplicitBoundedWorkRequest("I need you to investigate this and write a report."),
    ).toBe(true);
  });

  it("does not treat negated, quoted, hypothetical, or third-person text as authorization", () => {
    expect(
      isExplicitBoundedWorkRequest("Don't research this or draft a report."),
    ).toBe(false);
    expect(
      isExplicitBoundedWorkRequest('Quote this: "research the options and draft a recommendation."'),
    ).toBe(false);
    expect(
      isExplicitBoundedWorkRequest("What if we research it and draft a report later?"),
    ).toBe(false);
    expect(
      isExplicitBoundedWorkRequest("My manager will research this and draft a report."),
    ).toBe(false);
  });

  it("keeps single-step or conversational mentions in ordinary chat", () => {
    expect(isExplicitBoundedWorkRequest("Research this topic.")).toBe(false);
    expect(isExplicitBoundedWorkRequest("I read a research report yesterday.")).toBe(false);
    expect(isExplicitBoundedWorkRequest("Draft a report about this.")).toBe(false);
  });
});

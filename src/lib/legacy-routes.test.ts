import { describe, expect, it } from "vitest";

import { memoryRedirect, understandingRedirect } from "./legacy-routes";

describe("links from before Memory and Understanding merged", () => {
  it("keeps the view a bookmark or saved login destination asked for", () => {
    expect(memoryRedirect({})).toBe("/about-you");
    expect(memoryRedirect({ view: "review" })).toBe("/about-you?view=review");
    expect(memoryRedirect({ view: "history" })).toBe("/about-you?view=history");
    expect(understandingRedirect({ view: "review" })).toBe("/about-you?view=review");
  });

  it("carries a search term and the older show= aliases across", () => {
    expect(memoryRedirect({ q: "aisle seats" })).toBe("/about-you?q=aisle+seats");
    expect(memoryRedirect({ show: "pending" })).toBe("/about-you?show=pending");
    expect(memoryRedirect({ show: "all" })).toBe("/about-you?show=all");
  });

  it("sends the reflection view to Today, where the question now lives", () => {
    expect(understandingRedirect({ view: "questions" })).toBe("/today");
  });

  it("takes the first value of a repeated parameter rather than encoding an array", () => {
    expect(memoryRedirect({ view: ["history", "review"] })).toBe("/about-you?view=history");
    expect(understandingRedirect({ view: ["questions"] })).toBe("/today");
  });

  it("drops parameters a stray link left empty", () => {
    expect(memoryRedirect({ view: undefined, q: undefined })).toBe("/about-you");
    expect(memoryRedirect({ view: [] })).toBe("/about-you");
  });
});

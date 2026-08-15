import { describe, expect, it } from "vitest";

import { splitParagraphs } from "@/components/assistant-prose";

describe("splitParagraphs", () => {
  it("splits on blank lines", () => {
    expect(splitParagraphs("First thought.\n\nSecond thought.")).toEqual([
      "First thought.",
      "Second thought.",
    ]);
  });

  it("keeps single newlines inside a paragraph", () => {
    // The paragraphs render pre-wrapped, so a soft break is still the author's break.
    expect(splitParagraphs("One line\nnext line")).toEqual(["One line\nnext line"]);
  });

  it("treats a whitespace-only line as blank", () => {
    expect(splitParagraphs("First.\n   \nSecond.")).toEqual(["First.", "Second."]);
    expect(splitParagraphs("First.\n\t\nSecond.")).toEqual(["First.", "Second."]);
  });

  it("collapses runs of blank lines rather than emitting empty paragraphs", () => {
    expect(splitParagraphs("First.\n\n\n\nSecond.")).toEqual(["First.", "Second."]);
  });

  it("survives the partial text that streaming produces", () => {
    // Called on every delta, so a reply mid-sentence must not throw or drop the tail.
    expect(splitParagraphs("First.\n\nSecond thou")).toEqual(["First.", "Second thou"]);
    expect(splitParagraphs("First.\n\n")).toEqual(["First."]);
    expect(splitParagraphs("A")).toEqual(["A"]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("   \n\n  ")).toEqual([]);
  });
});

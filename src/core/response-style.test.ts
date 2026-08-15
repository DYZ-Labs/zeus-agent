import { describe, expect, it } from "vitest";

import { countSentences, describeViolations, styleViolations } from "./response-style";

function kinds(text: string, maxSentences?: number): string[] {
  return styleViolations(text, maxSentences === undefined ? {} : { maxSentences }).map(
    (violation) => violation.kind,
  );
}

describe("third_person_self", () => {
  it("catches Zeus narrating itself", () => {
    expect(kinds("Zeus could not tell which event you meant.")).toContain("third_person_self");
    expect(kinds("Zeus has never successfully read this calendar.")).toContain("third_person_self");
    expect(kinds("That worked out to a length Zeus did not trust.")).toContain(
      "third_person_self",
    );
    expect(kinds("Zeus’s read is stale.")).toContain("third_person_self");
  });

  it("leaves the first person alone", () => {
    expect(kinds("I couldn't tell which event you meant.")).toEqual([]);
    expect(kinds("I haven't looked at your calendar yet.")).toEqual([]);
  });

  it("does not fire on the name used as a name", () => {
    expect(kinds("You can rename Zeus in Settings.")).toEqual([]);
    expect(kinds("What is Zeus?")).toEqual([]);
  });
});

describe("markdown_marker", () => {
  it("catches markers the chat renders literally", () => {
    expect(kinds("That meeting is **important**.")).toContain("markdown_marker");
    expect(kinds("Run `npm test` first.")).toContain("markdown_marker");
    expect(kinds("# Summary\nYou have three things due.")).toContain("markdown_marker");
    expect(kinds("| when | what |\n| 3pm | standup |")).toContain("markdown_marker");
  });

  it("allows ordinary punctuation", () => {
    expect(kinds("You're free after 4pm — I checked.")).toEqual([]);
  });
});

describe("list_bullet", () => {
  it("catches bulleted and numbered lines", () => {
    expect(kinds("Two things:\n- Renew the passport\n- Book the flight")).toContain("list_bullet");
    expect(kinds("Two things:\n1. Renew the passport\n2. Book the flight")).toContain(
      "list_bullet",
    );
    expect(kinds("Two things:\n  * Renew the passport")).toContain("list_bullet");
  });

  it("does not fire on a dash mid-sentence or a leading em dash", () => {
    expect(kinds("Thursday is free — Friday is not.")).toEqual([]);
    expect(kinds("— that was the only slot I found.")).toEqual([]);
  });
});

describe("assistant_closer", () => {
  it("catches support-ticket sign-offs", () => {
    expect(kinds("You're booked. Let me know if you'd like anything changed.")).toContain(
      "assistant_closer",
    );
    expect(kinds("Feel free to ask again later.")).toContain("assistant_closer");
    expect(kinds("Hope this helps!")).toContain("assistant_closer");
    expect(kinds("Is there anything else I can do?")).toContain("assistant_closer");
  });

  it("leaves a real question alone", () => {
    expect(kinds("Want me to move it to 4pm instead?")).toEqual([]);
  });
});

describe("hedge_opener", () => {
  it("catches preamble before the answer", () => {
    expect(kinds("Great question. You mentioned Acme in March.")).toContain("hedge_opener");
    expect(kinds("Of course, I can look at that.")).toContain("hedge_opener");
    expect(kinds("As an AI, I don't have access to that.")).toContain("hedge_opener");
  });

  it("only fires at the start", () => {
    expect(kinds("You asked me this in March. Of course, things change.")).not.toContain(
      "hedge_opener",
    );
  });
});

describe("over_length", () => {
  it("is off unless a ceiling is given", () => {
    const long = "One. Two. Three. Four. Five. Six.";
    expect(kinds(long)).toEqual([]);
    expect(kinds(long, 3)).toContain("over_length");
    expect(kinds(long, 6)).not.toContain("over_length");
  });

  it("counts an unterminated trailing fragment", () => {
    expect(countSentences("First one. And a trailing thought")).toBe(2);
    expect(countSentences("Just one.")).toBe(1);
    expect(countSentences("")).toBe(0);
  });
});

describe("styleViolations", () => {
  it("passes a reply written the way the prompt asks for", () => {
    const reply =
      "I haven't looked at your calendar — want me to check Thursday?\n\n" +
      "You mentioned back in March that Acme was the plan, so I'd want to confirm that's " +
      "still true before I hold anything.";
    expect(styleViolations(reply, { maxSentences: 8 })).toEqual([]);
  });

  it("reports every problem in one pass, ordered by position", () => {
    const reply =
      "Great question. Zeus could not read your calendar.\n- Try again\nLet me know if that helps.";
    const found = styleViolations(reply);
    expect(found.map((violation) => violation.kind)).toEqual([
      "hedge_opener",
      "third_person_self",
      "list_bullet",
      "assistant_closer",
    ]);
    expect(describeViolations(found)).toContain("third_person_self: Zeus could (at 16)");
  });

  it("does not carry regex state between calls", () => {
    const offender = "Zeus could not read it. Zeus did not act.";
    expect(styleViolations(offender)).toHaveLength(2);
    expect(styleViolations(offender)).toHaveLength(2);
  });
});

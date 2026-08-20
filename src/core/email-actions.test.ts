import { describe, expect, it } from "vitest";

import {
  addressInMessage,
  addressOf,
  buildEmailPayload,
  draftReplyRequest,
  emailActionObjective,
  emailActionWorkPlanProposal,
  emailPreviewFor,
  emailWriteVerb,
  encodeEmailRequest,
  parseEmailRequest,
  slotForEmailRequest,
  trashRequest,
} from "./email-actions";
import type { EmailRequest } from "./email-actions";
import type { EmailThread } from "./email-sync";

const THREAD: EmailThread = {
  id: "18f0a",
  subject: "Q3 planning",
  from: "Sarah Chen <sarah@acme.example>",
  last_activity_at: "2026-08-19T09:00:00.000Z",
  unread: true,
};

describe("recognizing an email write", () => {
  it("needs a mail noun and a write verb, and takes neither on its own", () => {
    expect(emailWriteVerb("draft a reply to Sarah's email")).toBe("draft");
    expect(emailWriteVerb("delete the email from Sarah")).toBe("trash");
    // A write verb with nothing to write on, and a mail noun with nothing being asked of it.
    expect(emailWriteVerb("delete the 3pm meeting")).toBeNull();
    expect(emailWriteVerb("how many emails are waiting")).toBeNull();
  });

  it("leaves the reading verbs to the reading path", () => {
    expect(emailWriteVerb("summarize the email from Sarah")).toBeNull();
    expect(emailWriteVerb("what did Sarah's message say")).toBeNull();
    expect(emailWriteVerb("read me the thread from Sarah")).toBeNull();
  });

  it("does not treat archiving as trashing", () => {
    // Different acts on the same object. Zeus has no archive capability, so this must fall
    // through to an ordinary turn rather than quietly bin mail somebody asked to be filed.
    expect(emailWriteVerb("archive the email from Sarah")).toBeNull();
    expect(emailWriteVerb("file that message away")).toBeNull();
  });

  it("reads a removal as a removal even when a draft verb is beside it", () => {
    expect(emailWriteVerb("delete the draft reply to Sarah")).toBe("trash");
  });
});

describe("resolving who a draft is for", () => {
  it("takes the bare address out of a From header", () => {
    expect(addressOf("Sarah Chen <sarah@acme.example>")).toBe("sarah@acme.example");
    expect(addressOf("sarah@acme.example")).toBe("sarah@acme.example");
    expect(addressOf("Sarah Chen")).toBeNull();
    expect(addressOf(null)).toBeNull();
  });

  it("finds an address the user typed themselves", () => {
    expect(addressInMessage("draft an email to bob@acme.example about the contract")).toBe(
      "bob@acme.example",
    );
    expect(addressInMessage("draft an email to Bob about the contract")).toBeNull();
  });

  it("refuses a reply to a thread whose sender will not parse", () => {
    // There is no second source for a recipient, so an unreadable sender is the end of it.
    expect(draftReplyRequest({ ...THREAD, from: "Sarah Chen" }, "say yes")).toBeNull();
    expect(draftReplyRequest({ ...THREAD, from: null }, "say yes")).toBeNull();
  });

});

describe("carrying the resolved action inside the plan", () => {
  it("round-trips through the objective, so the plan hash covers it", () => {
    const request = draftReplyRequest(THREAD, "tell her Tuesday does not work");
    expect(request).not.toBeNull();
    const objective = emailActionObjective("reply to Sarah", request!);
    expect(parseEmailRequest(objective)).toEqual(request);
    expect(objective.length).toBeLessThanOrEqual(2000);
  });

  it("reads nothing out of an objective that carries no email request", () => {
    expect(parseEmailRequest("Move the product review to Thursday")).toBeNull();
    expect(parseEmailRequest(`${encodeEmailRequest(trashRequest(THREAD))}`)?.kind).toBe("trash");
  });

  it("routes each request to its own slot", () => {
    expect(slotForEmailRequest(trashRequest(THREAD))).toBe("email.trash_thread");
    expect(slotForEmailRequest(draftReplyRequest(THREAD, "yes")!)).toBe("email.create_draft");
  });
});

describe("the exact bytes", () => {
  it("takes the recipient from the resolved request and only the body from the model", () => {
    const request = draftReplyRequest(THREAD, "tell her Tuesday does not work")!;
    // No subject: a reply's is the thread's, which is third-party text. The broker derives
    // it from the thread it is already reading, so it never enters the plan or the payload.
    expect(buildEmailPayload(request, "Tuesday is out for me.", null)).toEqual({
      threadId: "18f0a",
      to: ["sarah@acme.example"],
      body: "Tuesday is out for me.",
    });
  });

  it("sends a thread id and nothing else to move a thread to Trash", () => {
    expect(buildEmailPayload(trashRequest(THREAD), "", null)).toEqual({ threadId: "18f0a" });
  });
});

describe("what the confirmation says", () => {
  it("promises a draft is unsent", () => {
    const preview = emailPreviewFor(draftReplyRequest(THREAD, "yes")!, THREAD, null);
    expect(preview).toContain("sarah@acme.example");
    expect(preview).toContain("Q3 planning");
    expect(preview).toContain("Nothing is sent");
  });

  it("says what trashing takes, and how long the way back lasts", () => {
    const preview = emailPreviewFor(trashRequest(THREAD), THREAD, 4);
    expect(preview).toContain("Q3 planning");
    expect(preview).toContain("4 messages");
    expect(preview).toContain("30 days");
    // The draft's reassurance must not leak into the one act it does not apply to.
    expect(preview).not.toContain("Nothing is sent");
  });
});

describe("the code-owned plan", () => {
  it("never allows an effect kind beyond preparing locally and writing once", () => {
    for (const request of [
      trashRequest(THREAD),
      draftReplyRequest(THREAD, "yes")!,
    ] satisfies EmailRequest[]) {
      const proposal = emailActionWorkPlanProposal(request, "objective");
      expect(proposal.allowed_effects).toEqual(["prepare_local", "modify_external"]);
      expect(proposal.steps.map((step) => step.effect_kind)).toEqual([
        "prepare_local",
        "modify_external",
      ]);
    }
  });

  it("reads no mail while drafting, so no message body reaches a persisted artifact", () => {
    const proposal = emailActionWorkPlanProposal(draftReplyRequest(THREAD, "yes")!, "objective");
    expect(proposal.allowed_effects).not.toContain("external_read");
  });

  it("asks for no more budget than the runner's own floor for two steps", () => {
    // The ceiling is not a spend: the trash path makes no model call at all, which
    // `email-write-turn.test.ts` asserts against the real executor. What matters here is
    // that the plan cannot be born unrunnable, which is what lowballing this would do.
    const proposal = emailActionWorkPlanProposal(trashRequest(THREAD), "objective");
    expect(proposal.limits.max_model_tool_calls).toBe(4);
  });
});

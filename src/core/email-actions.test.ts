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
  replyRequest,
  sendCheckFor,
  sendRecipientsAllowed,
  parseEmailRequest,
  slotForEmailRequest,
  trashRequest,
  untrashRequest,
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

  it("only sends when the word is there, and drafts otherwise", () => {
    // The confirmation would catch a wrong guess either way. What it would not catch is a
    // user skimming a card they expected to say "draft".
    expect(emailWriteVerb("send Sarah an email saying yes")).toBe("send");
    expect(emailWriteVerb("draft a reply to Sarah and send it")).toBe("send");
    expect(emailWriteVerb("email Bob about the offsite")).toBe("draft");
    expect(emailWriteVerb("write Sarah a reply saying Tuesday is out")).toBe("draft");
  });

  it("does not read being asked to show an email as being asked to send one", () => {
    // Read as a send, this becomes a reply addressed to Sarah — which the confirmation would
    // catch, and which is an alarming card to be shown for having asked to read your mail.
    expect(emailWriteVerb("send me the email from Sarah")).toBeNull();
    expect(emailWriteVerb("forward me that message")).toBeNull();
  });

  it("reads undoing a removal as its own thing, not as another removal", () => {
    // Every one of these contains a removal word. What is being asked for is the opposite.
    expect(emailWriteVerb("undelete the email from Sarah")).toBe("untrash");
    expect(emailWriteVerb("put that email back")).toBe("untrash");
    expect(emailWriteVerb("restore the message I deleted")).toBe("untrash");
    expect(emailWriteVerb("get Sarah's email out of the trash")).toBe("untrash");
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
    expect(slotForEmailRequest(untrashRequest(THREAD))).toBe("email.untrash_thread");
    expect(slotForEmailRequest(draftReplyRequest(THREAD, "yes")!)).toBe("email.create_draft");
    expect(slotForEmailRequest(replyRequest(THREAD, "yes", "send")!)).toBe("email.send_message");
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

  it("sends a thread id and nothing else to move a thread either way", () => {
    expect(buildEmailPayload(trashRequest(THREAD), "", null)).toEqual({ threadId: "18f0a" });
    expect(buildEmailPayload(untrashRequest(THREAD), "", null)).toEqual({ threadId: "18f0a" });
  });
});

describe("the allowlist a send is checked against", () => {
  it("records where the recipient came from, and passes only that exact set", () => {
    const request = replyRequest(THREAD, "yes", "send")!;
    const check = sendCheckFor(request, new Date("2026-08-20T10:00:00.000Z"));
    expect(check).toMatchObject({
      kind: "send_recipients",
      source: "thread_sender",
      allowed: ["sarah@acme.example"],
    });
    expect(sendRecipientsAllowed(check, buildEmailPayload(request, "hi", null))).toBe(true);
  });

  it("refuses a payload addressed anywhere the allowlist does not name", () => {
    const request = replyRequest(THREAD, "yes", "send")!;
    const check = sendCheckFor(request, new Date("2026-08-20T10:00:00.000Z"));

    // Substituted, appended, emptied, and unrecorded — each of them a different way the
    // bytes could stop matching the decision that approved them.
    expect(sendRecipientsAllowed(check, { to: ["attacker@evil.example"], body: "hi" })).toBe(false);
    expect(sendRecipientsAllowed(check, {
      to: ["sarah@acme.example", "attacker@evil.example"],
      body: "hi",
    })).toBe(false);
    expect(sendRecipientsAllowed(check, { to: [], body: "hi" })).toBe(false);
    expect(sendRecipientsAllowed(check, { body: "hi" })).toBe(false);
    expect(sendRecipientsAllowed(null, { to: ["sarah@acme.example"] })).toBe(false);
    expect(sendRecipientsAllowed({ kind: "calendar_conflict", status: "clear" }, {
      to: ["sarah@acme.example"],
    })).toBe(false);
  });

  it("names the user's own message as the source when they typed the address", () => {
    const request: EmailRequest = {
      kind: "send_new",
      to: "bob@acme.example",
      subject: null,
      instruction: "about the contract",
    };
    expect(sendCheckFor(request, new Date()).source).toBe("user_message");
  });
});

describe("what the confirmation says", () => {
  it("promises a draft is unsent", () => {
    const preview = emailPreviewFor(draftReplyRequest(THREAD, "yes")!, THREAD, null);
    expect(preview).toContain("sarah@acme.example");
    expect(preview).toContain("Q3 planning");
    expect(preview).toContain("Nothing is sent");
  });

  it("says a send cannot be taken back, in words a draft never uses", () => {
    const draft = emailPreviewFor(draftReplyRequest(THREAD, "yes")!, THREAD, null);
    const send = emailPreviewFor(replyRequest(THREAD, "yes", "send")!, THREAD, null);

    expect(send).toContain("sarah@acme.example");
    expect(send).toContain("no unsend");
    expect(send).toContain("cannot take it back");
    // The reassurance that makes a draft a draft must not appear on the one card where it
    // would be false.
    expect(send).not.toContain("Nothing is sent");
    expect(send).not.toContain("waits in your Gmail Drafts");
    expect(draft).toContain("Nothing is sent");
  });

  it("says restoring puts something back, and warns of nothing", () => {
    const preview = emailPreviewFor(untrashRequest(THREAD), THREAD, 4);
    expect(preview).toContain("Q3 planning");
    expect(preview).toContain("back out of your Gmail Trash");
    expect(preview).not.toContain("30 days");
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
      untrashRequest(THREAD),
      draftReplyRequest(THREAD, "yes")!,
    ] satisfies EmailRequest[]) {
      const proposal = emailActionWorkPlanProposal(request, "objective");
      expect(proposal.allowed_effects).toEqual(["prepare_local", "modify_external"]);
      expect(proposal.steps.map((step) => step.effect_kind)).toEqual([
        "prepare_local",
        "modify_external",
      ]);
    }

    // A send plan asks for `send` and nothing wider, so authorizing one authorizes exactly
    // that — never a trash it could have reached through a shared effect kind.
    const sending = emailActionWorkPlanProposal(replyRequest(THREAD, "yes", "send")!, "objective");
    expect(sending.allowed_effects).toEqual(["prepare_local", "send"]);
    expect(sending.steps.map((step) => step.effect_kind)).toEqual(["prepare_local", "send"]);
    expect(sending.allowed_effects).not.toContain("modify_external");
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

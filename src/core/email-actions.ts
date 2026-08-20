import type { EmailThread } from "./email-sync";
import type { CapabilitySlot, WorkPlanProposal } from "./schema";

/**
 * One email write, fully resolved before any plan exists.
 *
 * `calendar-actions.ts` in shape and for the same reason: the fields a model would fill here
 * are the fields it could invent, and the cost of inventing one is mail sent to the wrong
 * person or somebody else's conversation in the bin. So the thread, the recipient, and the
 * subject are all decided by deterministic code against what Zeus already holds, and travel
 * inside the plan objective — which means the plan hash covers them, and the authorization is
 * bound to this exact action rather than to "some email work".
 *
 * The model's only contribution downstream is the prose of the message body.
 */
export type EmailRequest =
  | {
      kind: "draft_reply";
      threadId: string;
      /** The thread's sender, as a bare address. Never model output. */
      to: string;
      /** What the user said they wanted to say, in their own words. */
      instruction: string;
    }
  | {
      kind: "draft_new";
      /** An address the user typed themselves. Zeus has no contacts to look one up in. */
      to: string;
      subject: string | null;
      instruction: string;
    }
  | { kind: "trash"; threadId: string }
  | { kind: "untrash"; threadId: string };

export type EmailWriteKind = EmailRequest["kind"];

/** Bounded so the encoded request still fits a 2000-character plan objective. */
const MAX_INSTRUCTION_CHARS = 800;

const OPEN = "<email_request>";
const CLOSE = "</email_request>";

const BARE_ADDRESS = /^[^\s<>@",;:\\]+@[^\s<>@",;:\\]+\.[^\s<>@",;:\\]+$/u;
const ADDRESS_IN_TEXT = /[^\s<>@",;:\\]+@[^\s<>@",;:\\]+\.[a-z]{2,}/iu;

/**
 * A mail noun, required by both verbs.
 *
 * The calendar's prefilter is deliberately over-inclusive and this one deliberately is not:
 * "delete the email about Thursday's meeting" has to reach the email router rather than the
 * calendar one, and a bare "delete that" must reach neither.
 */
const MAIL_NOUN = /\b(?:e-?mails?|messages?|threads?|reply|replies|inbox)\b/iu;

/** Reading verbs, which own the same nouns and must keep them. */
const READ_VERB =
  /\b(?:summari[sz]e|what did|what does|read|open|show me|catch me up on)\b/iu;

const DRAFT_VERB = /\b(?:draft|compose|write|reply|respond|answer)\b/iu;

/**
 * Trash verbs — and `archive` is deliberately not one of them.
 *
 * Archiving drops the INBOX label and keeps the mail; trashing schedules it for deletion in
 * thirty days. They are different acts on the same object, and folding them together would
 * mean binning mail somebody asked to be filed. Zeus has no archive capability, so "archive
 * that" matches nothing and is answered as an ordinary turn.
 */
const TRASH_VERB = /\b(?:delete|trash|bin|junk|throw away|get rid of)\b/iu;

/**
 * Verbs for the way back.
 *
 * Checked before the trash verbs, because most of these phrases contain one: "undelete",
 * "put the deleted email back", "restore that from trash". The removal word is what is being
 * undone, not what is being asked for.
 */
const UNTRASH_VERB =
  /\b(?:untrash|undelete|restore|recover|undo)\b|\b(?:put|bring|take|pull)\b[^.?!]{0,40}?\bback\b|\bout of (?:the )?(?:trash|bin)\b/iu;

export function mayBeEmailWriteRequest(input: string): boolean {
  if (!MAIL_NOUN.test(input)) return false;
  if (READ_VERB.test(input)) return false;
  return DRAFT_VERB.test(input) || TRASH_VERB.test(input) || UNTRASH_VERB.test(input);
}

export function emailWriteVerb(input: string): "draft" | "trash" | "untrash" | null {
  if (!mayBeEmailWriteRequest(input)) return null;
  if (UNTRASH_VERB.test(input)) return "untrash";
  // Trash before draft: "delete the draft reply" is a removal, and a draft verb beside a
  // removal verb is describing what is being removed.
  if (TRASH_VERB.test(input)) return "trash";
  return DRAFT_VERB.test(input) ? "draft" : null;
}

/** The bare address inside a `From` header, or null if there is not exactly one. */
export function addressOf(header: string | null): string | null {
  if (!header) return null;
  const angled = /<([^<>\s]+@[^<>\s]+)>/u.exec(header);
  const candidate = (angled?.[1] ?? header).trim();
  return BARE_ADDRESS.test(candidate) ? candidate.toLowerCase() : null;
}

/** An address the user typed in this message, which is the only place one may come from. */
export function addressInMessage(content: string): string | null {
  const found = ADDRESS_IN_TEXT.exec(content);
  return found ? found[0].toLowerCase() : null;
}

export function draftReplyRequest(
  thread: EmailThread,
  instruction: string,
): EmailRequest | null {
  const to = addressOf(thread.from);
  // A cached thread whose sender will not parse is one Zeus cannot address. Refusing is the
  // only honest answer: there is no second source for the recipient.
  if (!to) return null;
  return {
    kind: "draft_reply",
    threadId: thread.id,
    to,
    instruction: instruction.trim().slice(0, MAX_INSTRUCTION_CHARS),
  };
}

export function trashRequest(thread: EmailThread): EmailRequest {
  return { kind: "trash", threadId: thread.id };
}

export function untrashRequest(thread: EmailThread): EmailRequest {
  return { kind: "untrash", threadId: thread.id };
}

/** The two requests that move a thread rather than compose one. */
export function isThreadMoveRequest(
  request: EmailRequest,
): request is Extract<EmailRequest, { kind: "trash" | "untrash" }> {
  return request.kind === "trash" || request.kind === "untrash";
}

export function isEmailDraftRequest(
  request: EmailRequest,
): request is Extract<EmailRequest, { kind: "draft_reply" | "draft_new" }> {
  return request.kind === "draft_reply" || request.kind === "draft_new";
}

export function slotForEmailRequest(request: EmailRequest): CapabilitySlot {
  if (request.kind === "trash") return "email.trash_thread";
  if (request.kind === "untrash") return "email.untrash_thread";
  return "email.create_draft";
}

/** Embed the resolved action so the plan hash covers it and the executor can recover it. */
export function encodeEmailRequest(request: EmailRequest): string {
  return `${OPEN}${JSON.stringify(request)}${CLOSE}`;
}

export function parseEmailRequest(objective: string): EmailRequest | null {
  const start = objective.indexOf(OPEN);
  const end = objective.indexOf(CLOSE, start + OPEN.length);
  if (start < 0 || end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(objective.slice(start + OPEN.length, end));
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.kind === "string" &&
      ["draft_reply", "draft_new", "trash", "untrash"].includes(record.kind)
      ? (parsed as EmailRequest)
      : null;
  } catch {
    return null;
  }
}

export function emailActionObjective(userText: string, request: EmailRequest): string {
  const verb = request.kind === "trash"
    ? "Move an email thread to Trash"
    : request.kind === "untrash"
      ? "Take an email thread back out of Trash"
      : "Save a Gmail draft";
  return `${verb} for: ${userText.trim().slice(0, 400)} ${encodeEmailRequest(request)}`.slice(
    0,
    2000,
  );
}

/**
 * The exact bytes, built from the resolved request and the drafted prose.
 *
 * The recipient and the thread come from the request — which is to say from the cache and
 * from the user's own words — and only `body` comes from the model. That split is the whole
 * injection story: a message telling Zeus to write to somebody else has nothing to write to.
 */
export function buildEmailPayload(
  request: EmailRequest,
  body: string,
  subject: string | null,
): Record<string, unknown> {
  if (isThreadMoveRequest(request)) return { threadId: request.threadId };
  // A reply carries no subject, because the only honest source for one is the thread — and
  // a thread's subject is somebody else's text. Sending it here would put third-party prose
  // in the plan objective, the plan hash, and the payload; the broker already reads the
  // thread for its reply headers, so it derives "Re: …" there and this never holds it.
  if (request.kind === "draft_reply") {
    return { threadId: request.threadId, to: [request.to], body };
  }
  return { to: [request.to], subject: subject ?? "", body };
}

export function emailPreviewFor(
  request: EmailRequest,
  thread: EmailThread | null,
  messageCount: number | null,
): string {
  if (request.kind === "untrash") {
    const named = thread?.subject?.trim()
      ? `the thread "${thread.subject.trim()}"`
      : "that thread";
    const from = thread?.from?.trim() ? ` from ${thread.from.trim()}` : "";
    return `Take ${named}${from} back out of your Gmail Trash and return it to your mail.`;
  }
  if (request.kind === "trash") {
    const named = thread?.subject?.trim()
      ? `the thread "${thread.subject.trim()}"`
      : "that thread";
    const from = thread?.from?.trim() ? ` from ${thread.from.trim()}` : "";
    const size = messageCount && messageCount > 1 ? ` — ${messageCount} messages` : "";
    // Three things the draft preview does not say, each because trash is the different act:
    // how much is going (a thread, not an email), that it leaves the inbox, and that the way
    // back exists and expires.
    return (
      `Move ${named}${from}${size} to your Gmail Trash. It leaves your inbox. ` +
      "Gmail keeps Trash for 30 days, and you can put it back from there until then."
    );
  }
  const about = request.kind === "draft_reply"
    ? thread?.subject?.trim()
      ? `replying to "${thread.subject.trim()}"`
      : "replying to that thread"
    : "a new message";
  return (
    `Save a draft to ${request.to}, ${about}. It waits in your Gmail Drafts. ` +
    "Nothing is sent — you send it yourself, or delete it."
  );
}

/**
 * The fixed, code-owned plan for one email write.
 *
 * Two steps for every one of them, and deliberately no `external_read`. A read step would have to put what it read
 * into a `work_artifact`, and a `work_artifact` is a row: `email-sync.ts` holds message bodies
 * for exactly one turn and there is no table one may reach. So the draft is written from the
 * user's own instruction rather than from the message being replied to — which is a real
 * limit on "reply saying whatever she asked about", and is also why no hostile message body
 * is anywhere near the model that writes the draft.
 */
export function emailActionWorkPlanProposal(
  request: EmailRequest,
  objective: string,
): WorkPlanProposal {
  if (isThreadMoveRequest(request)) {
    const toTrash = request.kind === "trash";
    return {
      objective,
      steps: [
        {
          title: "Name the thread",
          instruction: toTrash
            ? "Resolve the exact thread to be moved to Trash from the inbox Zeus has already " +
              "read, so the user can see which conversation this is. Do not change anything."
            : "Resolve the exact thread to be taken back out of Trash from what Zeus " +
              "recorded moving there, so the user can see which conversation this is. Do " +
              "not change anything.",
          effect_kind: "prepare_local",
          depends_on: [],
        },
        {
          title: toTrash ? "Move it to Trash" : "Take it back out of Trash",
          instruction: toTrash
            ? "Prepare the exact request to move that one thread to Trash and pause for one " +
              "explicit confirmation. Nothing is deleted permanently and nothing is sent."
            : "Prepare the exact request to restore that one thread from Trash and pause " +
              "for one explicit confirmation.",
          effect_kind: "modify_external",
          depends_on: [1],
        },
      ],
      allowed_effects: ["prepare_local", "modify_external"],
      completion_criteria: [
        toTrash
          ? "The thread was resolved from what Zeus had already read, and the move to Trash " +
            "was left pending as one exact request until the user confirmed it."
          : "The thread was resolved from what Zeus recorded moving to Trash, and the " +
            "restore was left pending as one exact request until the user confirmed it.",
      ],
      limits: { max_model_tool_calls: 4, max_retries_per_step: 2, max_duration_seconds: 300 },
    };
  }
  return {
    objective,
    steps: [
      {
        title: "Write the message",
        instruction:
          "Write only the message the user asked for, from their own words in this " +
          "objective. Do not address it, do not sign it, and do not quote anything.",
        effect_kind: "prepare_local",
        depends_on: [],
      },
      {
        title: "Save it as a draft",
        instruction:
          "Prepare the exact draft from the message just written, addressed as already " +
          "resolved, and pause for one explicit confirmation. A draft is never sent.",
        effect_kind: "modify_external",
        depends_on: [1],
      },
    ],
    allowed_effects: ["prepare_local", "modify_external"],
    completion_criteria: [
      "The message was written from the user's own instruction, and the draft was left " +
        "pending as one exact request until the user confirmed it. Nothing was sent.",
    ],
    limits: { max_model_tool_calls: 4, max_retries_per_step: 2, max_duration_seconds: 300 },
  };
}

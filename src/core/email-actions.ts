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
  | { kind: "untrash"; threadId: string }
  | {
      kind: "send_reply";
      threadId: string;
      /** The thread's sender, as a bare address. Never model output. */
      to: string;
      instruction: string;
    }
  | {
      kind: "send_new";
      /** An address the user typed themselves, in the message that authorized this. */
      to: string;
      subject: string | null;
      instruction: string;
    };

/**
 * Where a recipient came from, recorded with the payload and checked again before it leaves.
 *
 * A send is the one effect Zeus cannot walk back, so the address is not merely validated —
 * its provenance is. There are exactly two sources a recipient may have, and both are things
 * the user already put in front of Zeus:
 *
 * - `thread_sender`: the address that wrote the thread being replied to, taken from the
 *   inbox cache. Somebody who mailed the user.
 * - `user_message`: an address typed into the message that asked for the send.
 *
 * A name is not a source. Zeus has no contacts, and inferring "Sarah" from a cached sender
 * that merely looks right is how mail reaches the wrong Sarah — which for a draft is an
 * embarrassment and for a send is unrecoverable.
 */
export type RecipientSource = "thread_sender" | "user_message";

export type SendCheck = {
  kind: "send_recipients";
  source: RecipientSource;
  allowed: string[];
  checked_at: string;
};

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
 * "Email Bob about the offsite" — the noun used as a verb.
 *
 * Separate from `DRAFT_VERB` because a bare `\bemail\b` would match the noun in "archive the
 * email from Sarah" and turn filing into composing. What distinguishes the verb is position:
 * it opens the request or follows a connective, and what comes next is who it is for rather
 * than an article.
 */
const EMAIL_AS_VERB =
  /(?:^|[.;,]\s*|\band\s+|\bthen\s+|\bplease\s+)e-?mail\s+(?!me\b|us\b|the\b|that\b|this\b|it\b|them\b|about\b|from\b)\S/iu;

/**
 * Sending has to be asked for in the word.
 *
 * "Email Bob about the offsite" is not a send. It reads like one in a hurry, and reading it
 * that way is how a half-formed thought leaves the building — so anything short of the verb
 * itself resolves to a draft, which is the rung of the ladder a person can step back from.
 * The confirmation would catch a wrong guess either way; what it would not catch is the user
 * skimming a card they expected to say "draft".
 */
const SEND_VERB = /\b(?:send|sends|sending|sent)\b/iu;

/**
 * "Send me the email from Sarah" is a request to be shown one.
 *
 * Read as a send it becomes a reply addressed to Sarah, which the confirmation would catch
 * and the user would have to decline — an alarming thing to be shown for having asked to
 * read your own mail. Excluded rather than ranked, because there is no reading of these
 * phrases that asks Zeus to write to anyone.
 */
const SEND_TO_SELF =
  /\bsend\s+(?:me|us|it to me|them to me|that to me|over)\b|\bforward\s+(?:me|it to me)\b/iu;

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
  if (READ_VERB.test(input) || SEND_TO_SELF.test(input)) return false;
  return (
    DRAFT_VERB.test(input) ||
    EMAIL_AS_VERB.test(input) ||
    TRASH_VERB.test(input) ||
    UNTRASH_VERB.test(input) ||
    SEND_VERB.test(input)
  );
}

export function emailWriteVerb(
  input: string,
): "draft" | "trash" | "untrash" | "send" | null {
  if (!mayBeEmailWriteRequest(input)) return null;
  if (UNTRASH_VERB.test(input)) return "untrash";
  // Trash before the rest: "delete the draft reply" is a removal, and a compose verb beside a
  // removal verb is describing what is being removed.
  if (TRASH_VERB.test(input)) return "trash";
  // Send before draft, and only on the explicit word: "draft a reply and send it" is a send,
  // because that is what it says. "Draft a reply" alone never becomes one.
  if (SEND_VERB.test(input)) return "send";
  return DRAFT_VERB.test(input) || EMAIL_AS_VERB.test(input) ? "draft" : null;
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

export function replyRequest(
  thread: EmailThread,
  instruction: string,
  intent: "draft" | "send",
): EmailRequest | null {
  const to = addressOf(thread.from);
  // A cached thread whose sender will not parse is one Zeus cannot address. Refusing is the
  // only honest answer: there is no second source for the recipient.
  if (!to) return null;
  return {
    kind: intent === "send" ? "send_reply" : "draft_reply",
    threadId: thread.id,
    to,
    instruction: instruction.trim().slice(0, MAX_INSTRUCTION_CHARS),
  };
}

export function draftReplyRequest(
  thread: EmailThread,
  instruction: string,
): EmailRequest | null {
  return replyRequest(thread, instruction, "draft");
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

export function isEmailSendRequest(
  request: EmailRequest,
): request is Extract<EmailRequest, { kind: "send_reply" | "send_new" }> {
  return request.kind === "send_reply" || request.kind === "send_new";
}

/** Every request that composes prose, whether it will be held or sent. */
export function isEmailComposeRequest(
  request: EmailRequest,
): request is Extract<
  EmailRequest,
  { kind: "draft_reply" | "draft_new" | "send_reply" | "send_new" }
> {
  return request.kind !== "trash" && request.kind !== "untrash";
}

export function recipientsOf(request: EmailRequest): string[] {
  return isEmailComposeRequest(request) ? [request.to] : [];
}

export function recipientSourceOf(request: EmailRequest): RecipientSource {
  return request.kind === "send_reply" || request.kind === "draft_reply"
    ? "thread_sender"
    : "user_message";
}

/** The allowlist, built at payload time and stored beside the exact bytes it approves. */
export function sendCheckFor(request: EmailRequest, at: Date): SendCheck {
  return {
    kind: "send_recipients",
    source: recipientSourceOf(request),
    allowed: recipientsOf(request),
    checked_at: at.toISOString(),
  };
}

/**
 * Re-read that allowlist against the payload about to be dispatched.
 *
 * Deliberately not a second look at the inbox: the cache moves, and a send failing because a
 * thread aged out of a seven-day window would be a false alarm on the one path where a false
 * alarm costs the user their message. What is checked is that the bytes still name exactly
 * the recipients the allowlist approved — the same question the payload hash answers, asked
 * a second way, in the one place where being wrong cannot be undone.
 */
export function sendRecipientsAllowed(
  storedCheck: unknown,
  payload: Record<string, unknown>,
): boolean {
  const check = storedCheck as Partial<SendCheck> | null;
  if (!check || check.kind !== "send_recipients" || !Array.isArray(check.allowed)) return false;
  const allowed = check.allowed.filter((entry): entry is string => typeof entry === "string");
  if (allowed.length === 0) return false;
  const recipients = Array.isArray(payload.to)
    ? payload.to.filter((entry): entry is string => typeof entry === "string")
    : null;
  if (recipients === null || recipients.length !== allowed.length) return false;
  return recipients.every((entry) => allowed.includes(entry));
}

export function isEmailDraftRequest(
  request: EmailRequest,
): request is Extract<EmailRequest, { kind: "draft_reply" | "draft_new" }> {
  return request.kind === "draft_reply" || request.kind === "draft_new";
}

export function slotForEmailRequest(request: EmailRequest): CapabilitySlot {
  if (request.kind === "trash") return "email.trash_thread";
  if (request.kind === "untrash") return "email.untrash_thread";
  if (isEmailSendRequest(request)) return "email.send_message";
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
      ["draft_reply", "draft_new", "trash", "untrash", "send_reply", "send_new"].includes(
        record.kind,
      )
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
      : isEmailSendRequest(request)
        ? "Send an email"
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
  if (request.kind === "draft_reply" || request.kind === "send_reply") {
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
  const replying = request.kind === "draft_reply" || request.kind === "send_reply";
  const about = replying
    ? thread?.subject?.trim()
      ? `replying to "${thread.subject.trim()}"`
      : "replying to that thread"
    : "a new message";
  if (isEmailSendRequest(request)) {
    // Nothing about this preview may read like the draft one above it. A draft's whole
    // reassurance is that it has not gone anywhere; a send has no such comfort to offer, and
    // borrowing the phrasing would blur the only distinction that matters here.
    return (
      `Send this to ${request.to} now, ${about}. It leaves your account as soon as you ` +
      "confirm. There is no unsend, no edit, and no recall — Zeus cannot take it back, and " +
      "neither can you."
    );
  }
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
  const sending = isEmailSendRequest(request);
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
        title: sending ? "Send it" : "Save it as a draft",
        instruction: sending
          ? "Prepare the exact message from the prose just written, addressed as already " +
            "resolved, and pause for one explicit confirmation. Nothing goes until the user " +
            "confirms this exact payload, and nothing can bring it back afterwards."
          : "Prepare the exact draft from the message just written, addressed as already " +
            "resolved, and pause for one explicit confirmation. A draft is never sent.",
        effect_kind: sending ? "send" : "modify_external",
        depends_on: [1],
      },
    ],
    allowed_effects: ["prepare_local", sending ? "send" : "modify_external"],
    completion_criteria: [
      sending
        ? "The message was written from the user's own instruction, addressed from a source " +
          "the user themselves supplied, and left pending as one exact request until they " +
          "confirmed that exact payload."
        : "The message was written from the user's own instruction, and the draft was left " +
          "pending as one exact request until the user confirmed it. Nothing was sent.",
    ],
    limits: { max_model_tool_calls: 4, max_retries_per_step: 2, max_duration_seconds: 300 },
  };
}

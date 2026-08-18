import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { recordModelCall, responseUsage } from "./budget";
import type { CalendarRequest } from "./calendar-actions";
import { TARGET_START_TOLERANCE_MS } from "./calendar-conflicts";
import type { EventReference } from "./calendar-conflicts";
import type { Db } from "./db";
import { errorSignature, logEvent } from "./observability";
import { MODEL, assertResponseComplete, openai } from "./openai";
import type { EvaluationContext } from "./schema";

/**
 * Recognizing that the user asked for something to happen to their calendar.
 *
 * This replaces three hand-written regexes that required a message to *begin* with a create
 * verb. They were the right conservatism when the only consequence was drafting, but they
 * are also why "I need to get dinner with Sam on the calendar" produced a sentence instead
 * of an event — the failure this module exists to remove.
 *
 * The division of labour is the same one `extract` → `applyExtraction` uses. A model is
 * good at recognizing what someone meant and bad at being a policy; so it proposes an
 * intent, and deterministic code decides whether anything may be done with it. Layer 3 can
 * only ever *downgrade* what the model returned — it can turn a create into nothing, and
 * can never turn nothing into a create.
 *
 * Note what is deliberately absent: calendar text never reaches this call. Assistant replies
 * may be supplied only as labelled reference text for resolving an acceptance; an invitation
 * someone else wrote still cannot steer what Zeus decides to do.
 */

const INTENT_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 2_000;
const MAX_PRIOR_MESSAGES = 6;
const MAX_PRIOR_CHARS = 500;

/** Longest a single event may run before Zeus treats the parse as wrong rather than bold. */
const MAX_DURATION_MS = 24 * 3_600_000;
const DEFAULT_DURATION_MS = 60 * 60_000;
const MAX_FUTURE_MS = 400 * 86_400_000;
/**
 * Widest stretch a single request may empty.
 *
 * A week is already a lot to lose to one misread sentence, and every hour past it makes the
 * itemized list Zeus shows before asking longer than anyone reads.
 */
const MAX_CLEAR_WINDOW_MS = 7 * 86_400_000;
const MAX_PAST_MS = 24 * 3_600_000;

const SYSTEM_PROMPT = `You classify whether the user's latest message asks for something to happen to their own calendar, and extract the details needed to carry it out.

Return intent "create" to add a new event, "reschedule" to move an existing one, "cancel" to remove one, "clear" to empty a whole stretch of time of everything in it, "read" to look at the calendar, and "none" for everything else. "none" is the right answer far more often than not: ordinary conversation that merely mentions a time, a date, or a meeting is not a request to change anything.

The line between "cancel" and "clear" is how many events are meant. "cancel my 3pm" and "clear that dinner" both name one event, so both are "cancel". "clear my Thursday afternoon", "wipe Friday", "get everything off my Monday morning" name a span of time and everything inside it, so they are "clear". For "clear", put the start of the span in starts_at_local and its end in ends_at_local, and leave title and target null.

Spans have ordinary meanings and you should use them: a whole day is midnight to midnight, morning is 00:00 to 12:00, afternoon is 12:00 to 18:00, evening is 18:00 to 23:59, "the rest of today" runs from the supplied local time to midnight. "clear my Thursday afternoon" on Thursday 2026-03-05 is therefore starts_at_local "2026-03-05T12:00" and ends_at_local "2026-03-05T18:00". If the user asked to empty a stretch of time, answer "clear" — even when you are unsure of the exact bounds, in which case fill in what you can and use confidence "low". Do not answer "none" for a request you understood; the system decides what is safe to act on, and answering "none" only means the user is told nothing at all.

A question about whether Calendar is connected, linked, permitted, or available is intent "none". It asks about Zeus's capability, not about the contents of the calendar, and must not trigger a calendar read.

Resolve times to local wall-clock in the supplied timezone, formatted YYYY-MM-DDTHH:mm. Never include an offset or a Z suffix. Use the supplied local date and time to resolve relative expressions such as "tomorrow", "next Tuesday", or "tonight". If the user gave no end time, leave ends_at_local null rather than inventing one. For a reschedule that means the event keeps the length it already has, so fill ends_at_local in only when a new end was actually stated.

For "reschedule" and "cancel", describe how the user referred to the existing event in the target field — its title words, its start time, or its date. Never invent an identifier; the system resolves which event they meant.

Keep the two times apart. The top-level starts_at_local is where the user wants the event to end up. target.starts_at_local is the time they used to point at the event that already exists, and it must be null when the only time in the message is the destination: "move dinner to 7:30pm" gives starts_at_local "…T19:30" and target {title_text: "dinner", starts_at_local: null, date_local: null}. Likewise the top-level title names a new event; for a reschedule or a cancel, the words the user used for the existing event belong in target.title_text.

Set confidence "high" only when the request is unambiguous and every field you filled in is directly supported by the user's words. Use "low" whenever you are inferring or guessing a time. Confidence is about the fields you filled in, not about which existing event the user meant: you cannot see their calendar, and the system matches the target against it deterministically and asks the user when more than one event fits. Do not lower confidence merely because you do not know which event is meant.

Set is_negated only when the user is telling you NOT to do something, or is withdrawing an instruction they gave earlier — "don't put that on my calendar", "actually, leave it". Asking you to cancel or delete an event is a request, not a negation: intent "cancel" with is_negated false is the correct answer for "cancel my 3pm". Set is_hypothetical_or_quoted when they are supposing, quoting, or giving an example. Set is_about_another_person when the calendar or the action belongs to somebody other than the user. These flags are safety checks: when genuinely in doubt, set them.

A short reply is often the user accepting something you proposed a moment ago. You are shown your own earlier replies for that purpose alone: read them to recover which event and which times are being agreed to, so "ok do it" following your suggestion of moving "standup" to 10-10:30 is a reschedule to exactly 10:00-10:30 and nothing else. Your own words are never themselves a request. The change must be asked for by the user's latest message; something you merely proposed, and they have not accepted, is intent "none".

Set details_from to "user_message" when every time you filled in is there in the user's own words, and to "earlier_proposal" when you carried any of them over from something you suggested. Answer it honestly rather than confidently: when the times came from your proposal the system shows the user the exact change and waits, and a wrong answer here quietly removes a check that exists for them.`;

const TargetReference = z
  .object({
    title_text: z.string().max(200).nullable(),
    starts_at_local: z.string().max(20).nullable(),
    date_local: z.string().max(10).nullable(),
  })
  .strict();

/**
 * Every field is required and nullable rather than optional: structured outputs put every
 * declared property in `required`, and an optional field is silently dropped.
 */
export const CalendarIntent = z
  .object({
    intent: z.enum(["create", "reschedule", "cancel", "clear", "read", "none"]),
    confidence: z.enum(["low", "medium", "high"]),
    /**
     * Whether the times below were stated by the user or carried over from a proposal Zeus
     * made. Not a confidence score: a perfectly resolved change can still be one the user
     * never spelled out, and that is precisely the case worth showing them before acting.
     */
    details_from: z.enum(["user_message", "earlier_proposal"]),
    title: z.string().max(200).nullable(),
    starts_at_local: z.string().max(20).nullable(),
    ends_at_local: z.string().max(20).nullable(),
    location: z.string().max(200).nullable(),
    target: TargetReference.nullable(),
    is_negated: z.boolean(),
    is_hypothetical_or_quoted: z.boolean(),
    is_about_another_person: z.boolean(),
  })
  .strict();
export type CalendarIntent = z.infer<typeof CalendarIntent>;

/**
 * A cheap skip, deliberately over-inclusive.
 *
 * This is not a gate and must never become one — that is exactly the mistake the old
 * regexes made. A false positive costs one low-effort model call; a false negative is the
 * bug. So it only asks "could this conceivably be about a calendar?" and errs toward yes.
 *
 * `afterCalendarTurn` says a calendar request already happened in this conversation. A
 * follow-up to one carries almost none of the nouns below — "and after that?", "move it
 * later", "the second one", "did that go through?" — so a conversation already about the
 * calendar lowers the bar to any short message. The classifier sees the earlier user messages
 * and can tell an actual follow-up from a change of subject; the veto behind it is unchanged.
 */
export function mayBeCalendarRequest(
  input: string,
  options: {
    afterCalendarTurn?: boolean;
    previousAssistantText?: string | null;
  } = {},
): boolean {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > MAX_INPUT_CHARS) return false;
  const subject =
    /\b(?:calendar|schedule|scheduling|meeting|appointment|event|invite|booking|book|reschedule|rebook|standup|stand-up|call|lunch|dinner|breakfast|coffee|class|workout|gym|session|catch[- ]?up|sync|one[- ]?on[- ]?one|1:1|deadline|reminder|agenda)\b/iu;
  const action =
    /\b(?:add|create|put|set\s+up|pencil|slot|block|hold|move|shift|push|bump|change|cancel|kill|drop|clear|delete|remove|free|busy|availab|make\s+time|find\s+time)\b/iu;
  const temporal =
    /\b(?:today|tonight|tomorrow|tmr|yesterday|next\s+\w+|this\s+\w+|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|morning|afternoon|evening|noon|midday)\b/iu;
  // "block 2-3", "hold 10–11": a bare hour range is a time to a person and nothing to the
  // patterns above.
  const hourRange = /\b\d{1,2}\s*(?:-|–|—|to)\s*\d{1,2}\b/iu;
  // "out at 1030", "by 7", "from 9.30": a clock time written without a colon or a meridiem.
  // People type these constantly and `temporal` sees none of them, which is how "so can i go
  // out at 1030" reached nothing at all — in a conversation that was entirely about the
  // user's calendar. Anchored to a preposition so it cannot fire on every stray number.
  const bareClock =
    /\b(?:at|from|until|til|till|by|before|after|around|about)\s+\d{1,2}(?:[.:]?[0-5]\d)?\b/iu;
  // "in 30 mins", "in an hour": an offset from now is how people ask whether they are free
  // soon, and it names no clock time at all.
  const relativeOffset = /\bin\s+(?:a|an|\d{1,3})\s*(?:min(?:ute)?s?|hours?|hrs?)\b/iu;
  // A short reply that is mostly a time is almost always answering a question about one —
  // "yes, 1pm works", "make it Thursday", "the 3pm one". Requiring an action verb here is
  // what made Zeus ignore someone accepting a slot it had just offered them, which is the
  // exact false negative this filter exists to avoid. The classifier sees the preceding
  // user messages and can tell the difference; a needless call costs one low-effort model
  // request, and the veto and conflict gate still stand behind it.
  const shortReply = normalized.length <= 80;
  // Verbs that are about appointments and very little else. "cancel the design review"
  // carries no time and no calendar noun, so pairing a verb with a time would skip it —
  // and the thing named is exactly the thing the user wants gone.
  const schedulingVerb =
    /\b(?:reschedule|rebook|postpone|unbook|cancel|call\s+off|double[- ]?book|free\s+up|push\s+back)\b/iu;
  const carriesTime =
    temporal.test(normalized) ||
    hourRange.test(normalized) ||
    bareClock.test(normalized) ||
    relativeOffset.test(normalized);
  // A bare acceptance carries no time and no calendar word — that is exactly what makes it an
  // acceptance. So it is judged against the reply it answers rather than on its own: "ok do
  // it" is a calendar request when, and only when, the thing being accepted was one. Without
  // this the one flow where Zeus proposes a change and the user agrees to it never reached
  // the classifier, and the model answered as though it had acted.
  const accepting =
    ACCEPTANCE.test(normalized) &&
    typeof options.previousAssistantText === "string" &&
    mayBeCalendarRequest(options.previousAssistantText);
  return (
    subject.test(normalized) ||
    schedulingVerb.test(normalized) ||
    (action.test(normalized) && carriesTime) ||
    (shortReply && carriesTime) ||
    accepting ||
    (shortReply && options.afterCalendarTurn === true)
  );
}

/**
 * Agreeing to something, in the words people actually use for it.
 *
 * Deliberately anchored and short. It has to catch "ok do it" without treating every "sure"
 * in a long paragraph as consent to change someone's week — and it never decides anything on
 * its own, because the message it answers must itself look like a calendar request, and the
 * veto and the conflict gate both still stand behind it.
 */
const ACCEPTANCE =
  /^(?:ok(?:ay)?|sure|yes|yep|yeah|yup|fine|alright|right|perfect|great|please|sounds good|do it|go ahead|go for it|book it|make it so)\b[^?]{0,40}$/iu;

/** A capability question is answered from the live <capabilities> block, without opening Calendar. */
export function isCalendarCapabilityQuestion(input: string): boolean {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > MAX_INPUT_CHARS) return false;
  const namesCalendar = /\b(?:google\s+)?calendar\b/iu.test(normalized);
  const asksAboutAccess =
    /\b(?:connected|connection|connectivity|linked|linking|access|permission|permissions|integration|enabled)\b/iu.test(
      normalized,
    ) ||
    /\b(?:is|can\s+you\s+use)\s+(?:my\s+|google\s+)?calendar(?:\s+integration)?\s+(?:available|working)\b/iu.test(
      normalized,
    );
  // A first-turn request often starts by checking access and then asks for actual contents.
  // That second clause makes it a read request, not a capability-only question.
  const alsoAsksForContents =
    /\b(?:and|then)\s+(?:check|read|show(?:\s+me)?|view|open|list|look\s+(?:at|up)|tell\s+me\s+(?:what|which|when|where|how\s+many))\b/iu.test(
      normalized,
    );
  return namesCalendar && asksAboutAccess && !alsoAsksForContents;
}

/**
 * Resolve a narrow, explicit request to inspect the user's own calendar without a model.
 *
 * A direct read has no fields for a classifier to invent: the connected service is asked
 * for the same bounded window `resolveCalendarRequest` uses for a model-recognized read.
 * Keeping this small deterministic path matters most on the first turn of a conversation,
 * where there is no preceding chat to disambiguate the request and a classifier timeout
 * previously meant the calendar was never opened at all.
 *
 * Ambiguous language still goes through the classifier. Negated, quoted, hypothetical,
 * third-person, connection-only, and write requests stay out of this path entirely.
 */
export function directCalendarReadRequest(
  input: string,
  context: EvaluationContext,
): Extract<CalendarRequest, { kind: "read" }> | null {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > MAX_INPUT_CHARS) return null;
  if (
    /^(?:what if|suppose|imagine|hypothetically|for example|e\.g\.|quote|quoted|someone said)\b/iu.test(
      normalized,
    ) ||
    /^(?:he|she|they|the user|my (?:manager|colleague|client|friend))\b/iu.test(normalized) ||
    /\b(?:do not|don['’]t|dont|never|no need to|instead of|rather than|without)\s+(?:check|read|show|view|open|list|look)\b/iu.test(
      normalized,
    ) ||
    /\b(?:add|create|put|set\s+up|pencil|slot|block|hold|book|move|shift|push|bump|change|reschedule|rebook|cancel|kill|drop|clear|delete|remove|update|edit|invite|free\s+up)\b/iu.test(
      normalized,
    ) ||
    /\bschedule\s+(?:a|an|the|my|our|lunch|dinner|breakfast|meeting|call|appointment|event|sync|session|workout|gym)\b/iu.test(
      normalized,
    ) ||
    /\b(?:calendar|google calendar)\s+(?:support|integration|connection|feature|button|permission|api|oauth|scope)\b/iu.test(
      normalized,
    )
  ) {
    return null;
  }

  const ownCalendar =
    /\bmy\s+(?:(?:google|work|personal)\s+)?(?:calendar|schedule|meetings?|appointments?|events?)\b/iu;
  if (!ownCalendar.test(normalized)) return null;

  const imperative =
    /^(?:please\s+)?(?:check|read|show(?:\s+me)?|view|open|list|look\s+(?:at|up)|tell\s+me\s+(?:what|which|when|where|how\s+many))\b/iu;
  const addressed =
    /^(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?(?:(?:check|read|show(?:\s+me)?|view|open|list|look\s+(?:at|up)|tell\s+me\s+(?:what|which|when|where|how\s+many))\b|(?:access|use)\b.{0,200}\b(?:and|then)\s+(?:check|read|show(?:\s+me)?|view|open|list|look\s+(?:at|up)|tell\s+me\s+(?:what|which|when|where|how\s+many))\b)/iu;
  const contentsQuestion =
    /^(?:what(?:['’]s|\s+is)\s+(?:on|in)|what\s+do\s+i\s+have|which\s+(?:meetings?|appointments?|events?)|when\s+(?:is|are)\s+my|where\s+(?:is|are)\s+my|how\s+many\s+(?:meetings?|appointments?|events?)|am\s+i\s+(?:free|busy))\b/iu;
  if (!imperative.test(normalized) && !addressed.test(normalized) && !contentsQuestion.test(normalized)) {
    return null;
  }

  return calendarReadWindow(context);
}

/**
 * Signals that a message is not a request, whatever it otherwise looks like.
 *
 * Carried over from the regexes this module replaces, with one change: the negation set is
 * no longer anchored to the start of the message, so "actually, don't put that on my
 * calendar" is caught rather than only "don't put that on my calendar".
 */
export function containsCalendarRefusalSignal(input: string): boolean {
  const normalized = input.replace(/\s+/gu, " ").trim();
  return (
    /\b(?:do not|don['’]t|dont|never|no need to|instead of|rather than|without)\s+(?:add|create|put|schedule|book|move|cancel|delete|remove|change)\b/iu.test(
      normalized,
    ) ||
    /^(?:what if|suppose|imagine|hypothetically|for example|e\.g\.|quote|quoted|someone said)\b/iu.test(
      normalized,
    ) ||
    /\b(?:calendar|google calendar)\s+(?:support|integration|connection|feature|button|permission|api|oauth|scope)\b/iu.test(
      normalized,
    )
  );
}

export async function classifyCalendarIntent(
  db: Db,
  input: {
    message: string;
    /**
     * The conversation so far, oldest first, both roles.
     *
     * Assistant text is supplied for one purpose: resolving what a short reply refers to.
     * "ok do it" points at a proposal only Zeus made, and a classifier that cannot see it
     * has to reconstruct the change from whichever numbers happen to be in the user's own
     * words — which is how an agreed 10:00-10:30 became a written 10:30-11:30. It is
     * labelled as Zeus's own writing in the prompt and can never itself be a request; the
     * user's latest message still has to ask for the change, and `details_from` records
     * when the details came from here rather than from them.
     */
    priorTurns: readonly { role: "user" | "assistant"; text: string }[];
    context: EvaluationContext;
    /** The turn this classification belongs to, so a later refusal can be tied to it. */
    sourceMessageId?: number | null;
  },
  options: { signal?: AbortSignal } = {},
): Promise<CalendarIntent | null> {
  const deadline = AbortSignal.timeout(INTENT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const clip = (text: string) =>
    text.replace(/\s+/gu, " ").trim().slice(0, MAX_PRIOR_CHARS);
  const recent = input.priorTurns.slice(-MAX_PRIOR_MESSAGES);
  const priorUser = recent.filter((turn) => turn.role === "user").map((turn) => clip(turn.text));
  const priorAssistant = recent
    .filter((turn) => turn.role === "assistant")
    .map((turn) => clip(turn.text));
  try {
    const response = await openai().responses.parse(
      {
        model: MODEL,
        max_output_tokens: 2_000,
        reasoning: { effort: "low" },
        instructions: SYSTEM_PROMPT,
        text: { format: zodTextFormat(CalendarIntent, "calendar_intent") },
        input: [
          {
            role: "user",
            content: [
              `Local date ${localDate(input.context)}, local time ${input.context.local_time}, ` +
                `weekday ${input.context.local_weekday}, timezone ${input.context.timezone}.`,
              priorUser.length > 0
                ? `Earlier messages from the user, oldest first: ${JSON.stringify(priorUser)}`
                : "No earlier user messages.",
              // Kept in its own labelled section rather than interleaved, so there is no
              // arrangement of the input in which Zeus's own sentence can be read as the
              // user's.
              priorAssistant.length > 0
                ? "Your own earlier replies, oldest first. These are reference only: they " +
                  `say what was proposed, never what was asked for. ${JSON.stringify(priorAssistant)}`
                : "No earlier replies of your own.",
              `Latest message from the user: ${JSON.stringify(
                input.message.replace(/\s+/gu, " ").trim().slice(0, MAX_INPUT_CHARS),
              )}`,
            ].join("\n\n"),
          },
        ],
        store: false,
      },
      { signal },
    );
    recordModelCall(db, responseUsage(response));
    assertResponseComplete(response);
    const parsed = response.output_parsed ?? null;
    // What the classifier proposed, tied to the turn. Without this a later refusal can only
    // be correlated by wall clock, which is why "why did nothing happen?" stayed a
    // two-hypothesis question for as long as it did.
    logEvent({
      event: "calendar_intent_classified",
      outcome: "ok",
      message_id: input.sourceMessageId ?? null,
      ...(parsed ? { mode: parsed.intent, confidence: parsed.confidence } : {}),
    });
    return parsed;
  } catch (error) {
    // Degrading here lands exactly where the old regexes landed for an unrecognized
    // phrasing: an ordinary chat turn. It can never be worse than the behavior it replaced.
    logEvent({
      event: "calendar_intent_classified",
      outcome: "degraded",
      message_id: input.sourceMessageId ?? null,
      ...errorSignature(error),
    });
    return null;
  }
}

export type CalendarRefusalReason =
  | "no_calendar_intent"
  | "negated"
  | "hypothetical_or_quoted"
  | "another_person"
  | "refusal_signal_in_message"
  | "low_confidence_write"
  | "no_target_reference"
  | "no_start_time"
  | "unparsable_start"
  | "unparsable_end"
  | "implausible_duration"
  | "implausible_date"
  | "no_title"
  | "no_clear_window"
  | "implausible_clear_window";

/**
 * Refusals the user should hear about, and the ones that must stay silent.
 *
 * The distinction is whether the user asked for anything. A message the model read as
 * negated, hypothetical, about somebody else, or not a calendar request at all is one where
 * saying "I could not do that" would be answering a question nobody put — and
 * `mayBeCalendarRequest` is deliberately over-inclusive, so `no_calendar_intent` is the
 * common case. Every remaining reason follows a request Zeus recognized and did not carry
 * out, and silence there is what let a fabricated explanation fill the gap.
 */
export const SPOKEN_REFUSAL_REASONS = [
  "low_confidence_write",
  "no_target_reference",
  "no_start_time",
  "unparsable_start",
  "unparsable_end",
  "implausible_duration",
  "implausible_date",
  "no_title",
  "no_clear_window",
  "implausible_clear_window",
] as const satisfies readonly CalendarRefusalReason[];

export function refusalIsSpoken(reason: CalendarRefusalReason): boolean {
  return (SPOKEN_REFUSAL_REASONS as readonly CalendarRefusalReason[]).includes(reason);
}

export type CalendarResolution =
  | {
      status: "request";
      request: CalendarRequest;
      /** A field that was dropped as unusable, worth reporting rather than hiding. */
      note: "target_time_was_destination" | null;
    }
  | {
      status: "refused";
      reason: CalendarRefusalReason;
      /** What the model thought was being asked, so a spoken refusal can name the action. */
      intent: CalendarIntent["intent"];
    };

/**
 * Turn a proposed intent into an action Zeus may actually take — or into nothing.
 *
 * Downgrade-only, by construction: every branch either returns a request built from fields
 * the model supplied, or refuses. With no confirmation gate downstream, this is where a
 * misread has to be stopped, so the refusals are deliberately eager.
 *
 * A refusal now carries its reason out rather than collapsing to a bare null. That is not
 * cosmetic: when the caller could not tell a recognized-but-refused request from an ordinary
 * sentence, the chat model received no signal at all and answered anyway — which is how
 * "there is no existing dinner event to reschedule" was said about a calendar nothing had
 * read.
 */
export function resolveCalendarRequest(
  message: string,
  intent: CalendarIntent,
  context: EvaluationContext,
  options: { sourceMessageId?: number | null } = {},
): CalendarResolution {
  // Still logged, because classification is a model call and will vary between identical
  // requests; without this, "it worked yesterday" is unfalsifiable.
  const refuse = (reason: CalendarRefusalReason): CalendarResolution => {
    logEvent({
      event: "calendar_intent_refused",
      outcome: "degraded",
      reason,
      message_id: options.sourceMessageId ?? null,
      mode: intent.intent,
      confidence: intent.confidence,
    });
    return { status: "refused", reason, intent: intent.intent };
  };
  const act = (
    request: CalendarRequest,
    note: "target_time_was_destination" | null = null,
  ): CalendarResolution => ({ status: "request", request, note });

  if (intent.intent === "none") return refuse("no_calendar_intent");
  if (intent.is_negated) return refuse("negated");
  if (intent.is_hypothetical_or_quoted) return refuse("hypothetical_or_quoted");
  if (intent.is_about_another_person) return refuse("another_person");
  if (containsCalendarRefusalSignal(message)) return refuse("refusal_signal_in_message");

  const timezone = context.timezone;
  if (intent.intent === "read") {
    return act(calendarReadWindow(context));
  }

  // A low-confidence read costs nothing; a low-confidence write changes someone's week.
  if (intent.confidence === "low") return refuse("low_confidence_write");

  const detailsFrom = intent.details_from;

  if (intent.intent === "clear") {
    // A span with one end missing is not a span, and inferring the other end would decide how
    // much of someone's day disappears. Both bounds or nothing.
    if (!intent.starts_at_local || !intent.ends_at_local) return refuse("no_clear_window");
    const from = localToUtc(intent.starts_at_local, timezone);
    const to = localToUtc(intent.ends_at_local, timezone);
    if (!from || !to) return refuse("no_clear_window");
    const opens = Date.parse(from);
    const closes = Date.parse(to);
    const at = Date.parse(context.evaluated_at);
    if (closes <= opens || closes - opens > MAX_CLEAR_WINDOW_MS) {
      return refuse("implausible_clear_window");
    }
    if (opens > at + MAX_FUTURE_MS || closes < at - MAX_PAST_MS) return refuse("implausible_date");
    return act({ kind: "clear", from, to, timezone, detailsFrom });
  }
  if (intent.intent === "cancel") {
    const reference = resolveReference(intent, timezone);
    return reference
      ? act({ kind: "cancel", reference, timezone, detailsFrom })
      : refuse("no_target_reference");
  }

  if (!intent.starts_at_local) return refuse("no_start_time");
  const startsAt = localToUtc(intent.starts_at_local, timezone);
  if (!startsAt) return refuse("unparsable_start");
  // A stated end is honoured; a missing one is left missing. What "no end" means depends on
  // the action, and only the create branch is entitled to answer it: an event being moved
  // already has a length, and inventing an hour for it silently reshapes the user's day.
  const statedEnd = intent.ends_at_local ? localToUtc(intent.ends_at_local, timezone) : null;
  if (intent.ends_at_local && !statedEnd) return refuse("unparsable_end");

  const start = Date.parse(startsAt);
  const at = Date.parse(context.evaluated_at);
  if (statedEnd !== null) {
    const end = Date.parse(statedEnd);
    if (end <= start || end - start > MAX_DURATION_MS) return refuse("implausible_duration");
  }
  if (start > at + MAX_FUTURE_MS || start < at - MAX_PAST_MS) return refuse("implausible_date");

  if (intent.intent === "reschedule") {
    const reference = resolveReference(intent, timezone);
    if (!reference) return refuse("no_target_reference");
    const usable = withoutDestinationTime(reference, startsAt);
    // The time the user is moving the event *to* cannot also be how they pointed at it. Left
    // in, it filters the real event out of the pool and the run reports that nothing matches
    // — a denial about a calendar that was read correctly.
    if (!usable) return refuse("no_target_reference");
    return act(
      {
        kind: "reschedule",
        reference: usable.reference,
        startsAt,
        endsAt: statedEnd,
        timezone,
        detailsFrom,
      },
      usable.dropped ? "target_time_was_destination" : null,
    );
  }

  const title = (intent.title ?? "").trim();
  // An event with no name cannot be reviewed at a glance afterwards, which is the only
  // check left once it has already been created.
  if (title.length === 0) return refuse("no_title");
  return act({
    kind: "create",
    title,
    startsAt,
    // A new event has no length of its own to keep, so the house rule applies here alone.
    endsAt: statedEnd ?? new Date(start + DEFAULT_DURATION_MS).toISOString(),
    location: intent.location?.trim() || null,
    timezone,
    detailsFrom,
  });
}

function calendarReadWindow(
  context: EvaluationContext,
): Extract<CalendarRequest, { kind: "read" }> {
  const at = Date.parse(context.evaluated_at);
  return {
    kind: "read",
    from: new Date(at).toISOString(),
    to: new Date(at + 30 * 86_400_000).toISOString(),
    timezone: context.timezone,
  };
}

/**
 * How the user pointed at an event that already exists.
 *
 * The top-level `title` is a fallback rather than a second source of truth: the schema offers
 * both it and `target.title_text`, and a model that puts "dinner" in the wrong one has still
 * told us plainly which words the user used. Reading it here is cheaper than refusing a
 * request whose target is sitting in the next field.
 */
function resolveReference(
  intent: CalendarIntent,
  timezone: string,
): EventReference | null {
  const target = intent.target;
  const titleText = target?.title_text?.trim() || intent.title?.trim() || null;
  const startsAt = target?.starts_at_local
    ? localToUtc(target.starts_at_local, timezone)
    : null;
  const dateLocal = /^\d{4}-\d{2}-\d{2}$/u.test(target?.date_local ?? "")
    ? (target?.date_local ?? null)
    : null;
  // Nothing to match on is not a target. Resolving against an empty reference would pick
  // whatever happened to be next.
  if (!titleText && !startsAt && !dateLocal) return null;
  return { titleText, startsAt, dateLocal };
}

/**
 * Drop a target start time that is really the destination, and only when something else
 * still identifies the event.
 *
 * Deliberately not a repair that widens: if the coinciding time was the *only* thing
 * narrowing the pool, this returns null and the caller refuses, because falling back to
 * "any event Zeus can see" is exactly what `resolveReference` already refuses to do. The
 * prompt fixes this at source; this is the check that does not depend on the model obeying it.
 */
function withoutDestinationTime(
  reference: EventReference,
  destinationStartsAt: string,
): { reference: EventReference; dropped: boolean } | null {
  if (!reference.startsAt) return { reference, dropped: false };
  const target = Date.parse(reference.startsAt);
  const destination = Date.parse(destinationStartsAt);
  if (
    !Number.isFinite(target) ||
    !Number.isFinite(destination) ||
    Math.abs(target - destination) > TARGET_START_TOLERANCE_MS
  ) {
    return { reference, dropped: false };
  }
  if (!reference.titleText && !reference.dateLocal) return null;
  return { reference: { ...reference, startsAt: null }, dropped: true };
}

function localDate(context: EvaluationContext): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(context.evaluated_at));
}

/**
 * Local wall-clock to an instant.
 *
 * The model is asked for wall-clock precisely so this conversion happens here: asking a
 * model for a UTC offset gets DST wrong, and gets half-hour zones wrong more often. Two
 * passes settle the offset, which is enough for every zone including the hour that repeats
 * at a DST fall-back.
 */
export function localToUtc(local: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/u.exec(local.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const naive = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  if (!Number.isFinite(naive)) return null;
  let instant = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = naive - timezoneOffsetMs(instant, timezone);
  }
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

function timezoneOffsetMs(timestamp: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asIfUtc - timestamp;
}

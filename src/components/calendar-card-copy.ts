import type { CalendarOutcome } from "@/core/schema";

/**
 * Every fixed sentence the calendar and work cards show the user.
 *
 * A card is the record of something that did *not* happen, so almost everything here is
 * copy for a refusal, a collision, or a question. Once a change goes through there is no
 * card and no fixed sentence at all: the reply is the account of it.
 *
 * Lifted out of the components for two reasons. It is the densest concentration of
 * user-facing copy in the app, so a test can sweep it with `styleViolations` and keep the
 * first-person voice from eroding one edit at a time; and a plain module imports into a
 * test without pulling React in behind it.
 *
 * Zeus speaks as I here, the same as it does in chat. The `<capabilities>` block is the
 * deliberate exception — it rides inside a user-role message, where "I" would read as the
 * user — so it stays third person and the system prompt asks for it to be relayed as I.
 */

/** What I could not work out, said in the user's terms rather than the veto's. */
export const CLARIFICATION: Record<string, string> = {
  low_confidence_write: "I wasn't sure enough about that to act on it.",
  no_target_reference: "I couldn't tell which event you meant.",
  no_start_time: "I couldn't tell what time you meant.",
  unparsable_start: "I couldn't read that as a time.",
  unparsable_end: "I couldn't read that as an end time.",
  implausible_duration: "That worked out to a length I didn't trust.",
  implausible_date: "That worked out to a date I didn't trust.",
  no_title: "I couldn't tell what to call it.",
};

export const CLARIFICATION_FALLBACK = "I couldn't work out what you wanted changed.";

/**
 * The kinds a card can be about, which is every kind except a read.
 *
 * A read changed nothing, so it has no receipt to render and no card of its own; the reply
 * is the whole answer. Excluding it here rather than by convention means a card that tries
 * to headline a read is a build error, not a regression someone notices in conversation.
 */
export type CalendarCardKind = Exclude<CalendarOutcome["kind"], "read">;

/** The statuses a card can be about, which is every status except a change that went through. */
export type CalendarCardStatus = Exclude<CalendarOutcome["status"], "done">;

/**
 * Whether this outcome gets a card at all.
 *
 * A card is the record of a change that did not happen. A completed create, reschedule, or
 * cancel renders nothing — the reply names what changed, and the durable copy is the
 * receipt on `/today` and `/effects/<id>`. A read renders nothing either, because nothing
 * changed and there is no receipt to put under the answer.
 *
 * A function rather than two conditions inside the component, because nothing here can
 * render a component: the suite is node-only. This is the one form of the rule a test can
 * hold, and it is swept across the whole status enum so a status added later has to be
 * classified rather than falling silently into the null branch.
 *
 * A type predicate rather than a plain boolean, so the rule is structural as well as
 * behavioural: past this guard the card cannot index its copy by `read`, and cannot write a
 * branch for `done` at all. Both are build errors rather than regressions someone notices
 * in conversation.
 */
export function rendersCard<T extends Pick<CalendarOutcome, "kind" | "status">>(
  outcome: T,
): outcome is T & { kind: CalendarCardKind; status: CalendarCardStatus } {
  return outcome.kind !== "read" && outcome.status !== "done";
}

// No success verb lives here. Nothing renders a headline for a change that went through,
// so one would be copy the user could never see — the same reason there is no `read` entry.
export const NOT_DONE: Record<CalendarCardKind, string> = {
  create: "Not added",
  reschedule: "Not moved",
  cancel: "Not cancelled",
};

export const TARGET_NOT_FOUND = {
  emptyWindow: "Nothing changed — I found no events in the window I checked.",
  noMatch: "Nothing changed — I couldn't match that in the window I checked.",
  nearMisses: "I did see these. Did you mean one of them?",
} as const;

/** Why I could not promise the time was free, and therefore did not act. */
export const UNVERIFIABLE: Record<string, string> = {
  reconnect_required:
    "Nothing changed. Google Calendar needs reconnecting before I can check or act.",
  connector_unavailable:
    "Nothing changed. The connected calendar is unavailable, so I couldn't check or act. Review it in Settings under Connections.",
  provider_unavailable:
    "Nothing changed. Your calendar is still connected — it just didn't answer me. Nothing to fix; ask again in a moment.",
  connector_call_failed:
    "Nothing changed. I couldn't reach your calendar just now, so I didn't act. Your connection is fine; ask again in a moment.",
  no_read_capability:
    "Nothing changed. I can't read your calendar with the permissions I have, so I couldn't check and didn't act.",
  // No `stale_coverage`. Why the read was too old to act on is the errand, not the answer,
  // and dating it was the one card line that still told the user when Zeus last looked.
  // It falls through to the fallback below, which says the part they can act on.
  unsupported_calendar_schema:
    "Nothing changed. Your calendar service describes events in a form I can't safely read, so I stopped.",
  remote_reported_error:
    "Nothing changed. Your calendar answered with an error instead of events, so I couldn't check. Ask again in a moment.",
  invalid_calendar_response:
    "Nothing changed. Your calendar sent back something I couldn't read as events, so I couldn't check.",
  planning_failed:
    "Nothing changed. I couldn't set that request up safely, so I stopped before touching anything.",
};

export const UNVERIFIABLE_FALLBACK =
  "Nothing changed. I couldn't get a current read of your calendar, so I stopped without acting.";

export const CARD_COPY = {
  blockedByConflict: "that destination was occupied.",
  ambiguousTarget: "Nothing changed — more than one event matches.",
  needsClarificationSuffix: "Say it again with the detail I was missing and I'll try.",
  readOnly: "Your calendar is connected for reading only, so nothing was changed.",
  noConnector: "No calendar is connected, so nothing was changed.",
  awaitingOverlap: "the destination overlaps:",
  confirmDespiteOverlap: "Confirm to make this exact change despite the overlap. Nothing changed yet.",
  nothingSentYet: "Nothing has been sent yet.",
  freeNearby: "Free nearby:",
  stoppedShort: "Nothing changed. I stopped before making the change.",
  // The two answers a confirmation panel gives its own buttons, and the only place a card
  // reports that something happened. Deliberately the bare fact that the request went, with
  // no verb and no preview: the reply already names what changed, and repeating it here
  // would be the same status narrated twice.
  sent: "Sent.",
  nothingWasSent: "Nothing was sent.",
} as const;

export const WORK_CARD_COPY = {
  completed: "I finished the authorized research and local preparation steps.",
  awaitingConfirmation: "I prepared an external request and stopped. Nothing has been sent.",
} as const;

export const FOLLOW_THROUGH_DECISION = {
  accepted: "Ready in the composer — help is available without acting externally.",
  completed: "Marked complete.",
  snoozed: "Snoozed for seven days.",
  dismissed: "Dismissed. It will stay quiet unless the commitment changes.",
} as const;

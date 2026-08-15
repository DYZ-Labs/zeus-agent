import type { CalendarOutcome } from "@/core/schema";

/**
 * Every fixed sentence the calendar and work cards show the user.
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

export const VERB: Record<CalendarOutcome["kind"], string> = {
  create: "Added to your calendar",
  reschedule: "Moved",
  cancel: "Cancelled",
  read: "Read your calendar",
};

export const NOT_DONE: Record<CalendarOutcome["kind"], string> = {
  create: "Not added",
  reschedule: "Not moved",
  cancel: "Not cancelled",
  read: "Not read",
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
  stale_coverage:
    "Nothing changed. I last looked at your calendar too long ago to act on it. Ask again and I'll read it fresh.",
};

export const UNVERIFIABLE_FALLBACK =
  "Nothing changed. I couldn't read your calendar, so I can't promise that time is free and didn't act on it.";

export const CARD_COPY = {
  checkedFirst: "on your calendar first.",
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
  undone: "Undone.",
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

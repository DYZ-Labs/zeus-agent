import { directExecutionAllowance } from "./calendar-policy";
import { readCalendarCoverage } from "./calendar-sync";
import { readEmailCoverage } from "./email-sync";
import {
  CALENDAR_CAPABILITY_SLOTS,
  availableCapability,
  connectorStatusLabel,
  listConnectors,
  reachabilityFailureWithdrawsGrant,
} from "./connectors";
import type { Db } from "./db";
import type { ConnectorStatus, EvaluationContext } from "./schema";

/**
 * What Zeus can actually do right now, in words a model can quote.
 *
 * The chat system prompt is a cached prefix, so it can only ever say "when a calendar is
 * connected…" — a condition it has no way to resolve. Nothing else in the turn resolved it
 * either, which left the model guessing about its own capabilities and, worse, free to
 * describe a calendar no part of the turn had opened. This block is the resolution: one
 * sibling of `<memory>`, rebuilt every turn from the same readers the work engine consults,
 * so the prose and the gate cannot disagree.
 *
 * Deliberately not part of `<memory>`. Connection state is not something Zeus remembers about
 * the user, `lastReadAt` is derived from an external read, and diluting "the memory block is
 * the entirety of what you remember" would weaken the strongest anti-fabrication rule in the
 * prompt — in service of fixing a fabrication.
 */

export type CalendarCapabilityState = {
  /** A calendar connector exists, whether or not it is currently usable. */
  connected: boolean;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  connectorLabel: string | null;
  /** Set only when a connector exists but cannot serve a call, so Zeus can say which. */
  unusableStatus: ConnectorStatus | null;
  /** A code-owned reason such as reconnect_required; never remote or user-authored text. */
  unusableReason: string | null;
  /**
   * The connection is intact and the service simply did not answer.
   *
   * Worth its own field because it is the one unusable state that asks nothing of the user.
   * Collapsing it into the others is what produced a reply telling someone to reconnect a
   * calendar whose authorization was never in question.
   */
  temporarilyUnreachable: boolean;
  directExecution: boolean;
  remainingToday: number;
  lastReadAt: string | null;
};

export function calendarCapabilityState(db: Db): CalendarCapabilityState {
  const read = availableCapability(db, "calendar.list_events");
  const create = availableCapability(db, "calendar.create_event");
  const update = availableCapability(db, "calendar.update_event");
  const usable = read ?? create ?? update;

  // A connector that exists and cannot be called is a different answer from no connector at
  // all, and the user can act on the difference: one needs reconnecting, the other connecting.
  const bound = usable
    ? null
    : listConnectors(db).find((connector) =>
        connector.provider === "google_calendar" ||
        connector.capabilities.some((capability) =>
          (CALENDAR_CAPABILITY_SLOTS as readonly string[]).includes(capability.slot),
        ),
      ) ?? null;
  const connector = usable?.connector ?? bound;
  const unusableReason = usable || !bound
    ? null
    : bound.last_error_code ?? (
        bound.status === "ready"
          ? bound.enabled === 0
            ? "disabled"
            // A ready, enabled connector that still cannot serve a call is almost always a
            // credential name with no value in this process — an operator problem. Naming it
            // "no_enabled_capability" sent the user to Settings to grant an access they had
            // already granted.
            : bound.missingEnvVarNames.length > 0
              ? "missing_environment"
              : "no_enabled_capability"
          : bound.status
      );

  // Describe the standing setting for a change whose details the user supplied. Individual
  // requests may still narrow this allowance when their times came from an earlier proposal.
  const allowance = directExecutionAllowance(db, { detailsFrom: "user_message" });
  return {
    connected: usable !== null || bound !== null,
    canRead: read !== null,
    canCreate: create !== null,
    canUpdate: update !== null,
    connectorLabel: connector?.label ?? null,
    unusableStatus: usable ? null : (bound?.status ?? null),
    unusableReason,
    temporarilyUnreachable:
      !usable &&
      bound !== null &&
      bound.status === "unreachable" &&
      unusableReason !== null &&
      !reachabilityFailureWithdrawsGrant(unusableReason) &&
      // The grants are the evidence that this is a service outage rather than a connection
      // the user took apart. Without them there is nothing to put back into service, and
      // "nothing to fix" would be the wrong thing to tell them.
      bound.capabilities.some((entry) => entry.enabled === 1),
    directExecution: allowance.reason !== "disabled",
    remainingToday: Math.max(0, allowance.limit - allowance.usedToday),
    lastReadAt: readCalendarCoverage(db)?.fetchedAt ?? null,
  };
}

/**
 * What Zeus can do with the user's mail.
 *
 * Still smaller than its calendar counterpart, and still for a reason rather than by
 * omission: email's two writes are always one exact confirmation each, so there is no
 * execution allowance to describe and no daily ceiling to spend. The write flags are separate
 * booleans because they are separate bindings, and a binding can drift.
 */
export type EmailCapabilityState = {
  /** An inbox connector exists, whether or not it is currently usable. */
  connected: boolean;
  canRead: boolean;
  canDraft: boolean;
  canTrash: boolean;
  canUntrash: boolean;
  connectorLabel: string | null;
  unusableStatus: ConnectorStatus | null;
  unusableReason: string | null;
  /**
   * The connection is intact and the service simply did not answer.
   *
   * Same distinction as the calendar field: a transient outage is not a grant the user has
   * to repair, and collapsing the two is how a reply came to deny an inbox that was still
   * authorized.
   */
  temporarilyUnreachable: boolean;
  lastReadAt: string | null;
};

export function emailCapabilityState(db: Db): EmailCapabilityState {
  const read = availableCapability(db, "email.search_threads");
  const canDraft = availableCapability(db, "email.create_draft") !== null;
  const canTrash = availableCapability(db, "email.trash_thread") !== null;
  const canUntrash = availableCapability(db, "email.untrash_thread") !== null;
  // A connector that exists and cannot be called is a different answer from no connector at
  // all. `provider === "google_gmail"` covers the hosted row before any slot is bound, which
  // is the calendar's rule for `google_calendar` and the one this used to skip.
  const bound = read
    ? null
    : listConnectors(db).find((connector) =>
        connector.provider === "google_gmail" ||
        connector.capabilities.some(
          (capability) =>
            capability.slot === "email.search_threads" ||
            capability.slot === "email.get_thread",
        ),
      ) ?? null;
  const connector = read?.connector ?? bound;
  const unusableReason = read || !bound
    ? null
    : bound.last_error_code ?? (
        bound.status === "ready"
          ? bound.enabled === 0
            ? "disabled"
            : bound.missingEnvVarNames.length > 0
              ? "missing_environment"
              : "no_enabled_capability"
          : bound.status
      );
  return {
    connected: read !== null || bound !== null,
    canRead: read !== null,
    canDraft,
    canTrash,
    canUntrash,
    connectorLabel: connector?.label ?? null,
    unusableStatus: read ? null : (bound?.status ?? null),
    unusableReason,
    temporarilyUnreachable:
      !read &&
      bound !== null &&
      bound.status === "unreachable" &&
      unusableReason !== null &&
      !reachabilityFailureWithdrawsGrant(unusableReason) &&
      bound.capabilities.some((entry) => entry.enabled === 1),
    lastReadAt: readEmailCoverage(db)?.fetchedAt ?? null,
  };
}

/**
 * The block itself.
 *
 * Prose rather than JSON: every line is a sentence the model can repeat to the user without
 * translating a field name first, and the failure this fixes was a model inventing prose in
 * the absence of any. Calendar and inbox both belong here: the cached prompt names this
 * block as the only authority on what is connected, so a service omitted from it is a
 * service the model is free to deny.
 */
export function renderCapabilityBlock(
  calendar: CalendarCapabilityState,
  email: EmailCapabilityState,
  context: EvaluationContext,
): string {
  const lines = [
    `Today is ${localDate(context)} (${context.local_weekday}), local time ` +
      `${context.local_time}, timezone ${context.timezone}.`,
    ...calendarLines(calendar),
    ...emailLines(email),
  ];
  return `<capabilities>\n${escapeCapabilityData(lines.join("\n"))}\n</capabilities>`;
}

function calendarLines(state: CalendarCapabilityState): string[] {
  const name = state.connectorLabel ?? "A calendar";
  if (!state.connected) {
    return [
      "Calendar: not connected. Zeus cannot read or change any calendar, and knows nothing " +
        "about what is on one. The user connects a calendar in Settings, under Connections.",
    ];
  }
  if (!state.canRead && !state.canCreate && !state.canUpdate) {
    // A service that did not answer is not a connection the user has to repair, and saying
    // so sends them to Settings to fix something that was never broken. The grant is still
    // theirs, and Zeus retries on its own — but only turns that need the calendar actually
    // pay for the attempt, so this line must not claim one happened.
    if (state.temporarilyUnreachable) {
      return [
        `Calendar: ${name} is connected, and did not answer just now. The connection is ` +
          "intact and needs nothing from the user; Zeus retries on its own and will pick " +
          "it back up when the service answers. The schedule block, if present, is from " +
          "the last successful read.",
      ];
    }
    // Missing server-side configuration is the operator's to fix. Sending the user to
    // Settings over it is the exact misdirection the unreachable branch above exists to
    // prevent, one layer down.
    if (state.unusableReason === "missing_environment" && state.unusableStatus === "ready") {
      return [
        `Calendar: ${name} is connected but cannot be used right now (server configuration ` +
          "missing). This deployment is missing a server-side setting; the operator of this " +
          "Zeus has to restore it, and nothing in the user's Settings will change it.",
      ];
    }
    const reconnect = state.unusableReason === "reconnect_required";
    const disabled = state.unusableReason === "disabled";
    const status = reconnect
      ? "Reconnect required"
      : disabled
        ? "Disabled"
        : state.unusableStatus
          ? connectorStatusLabel(state.unusableStatus)
          : "unavailable";
    const action = reconnect
      ? "reconnected"
      : disabled
        ? "enabled"
        : state.unusableReason === "no_enabled_capability"
          ? "given Calendar access"
          : "reconnected or verified";
    return [
      `Calendar: ${name} is connected but cannot be used right now (${status}). Zeus cannot ` +
        `read or change it until it is ${action} in Settings, under Connections.`,
    ];
  }
  const lines: string[] = [];
  const canWrite = state.canCreate || state.canUpdate;
  const writes = [
    state.canCreate ? "add new events" : null,
    state.canUpdate ? "move or cancel existing events" : null,
    state.canUpdate ? "clear everything out of a stretch of time" : null,
  ].filter((entry): entry is string => entry !== null);
  lines.push(
    canWrite
      ? `Calendar: ${name} is connected. Zeus can ${state.canRead ? "read it, and " : ""}` +
          `${series(writes)} when the user asks.`
      : `Calendar: ${name} is connected for reading only. Zeus can read it, and cannot add, ` +
          "move, or cancel anything; that needs a further permission in Settings, under Connections.",
  );
  if (canWrite) {
    lines.push(
      state.directExecution
        ? "Calendar changes without asking each time: on, and " +
            `${state.remainingToday} more allowed today. Zeus still reads the calendar first ` +
            "and still stops to ask when the time is taken, the calendar cannot be read, " +
            "more than one event matches, or the times came from something Zeus suggested " +
            "rather than from the user. Clearing a stretch of time always stops to ask, and " +
            "lists everything it would cancel first."
        : "Calendar changes without asking each time: off. Every change stops for the user to " +
            "confirm the exact request.",
    );
  }
  // Whether a read has ever succeeded, never when it happened. This line is relayed as "I",
  // so a timestamp here becomes Zeus telling the user what time it went and looked — which
  // is an audit log talking, not someone who knows their schedule. The distinction that
  // earns its place is never-read versus read, and the schedule block's own `state`
  // attribute carries stale versus current.
  lines.push(
    state.lastReadAt === null
      ? "Zeus has never successfully read this calendar."
      : "Zeus has read this calendar; the schedule block in this " +
          "message is from that read and says whether it is current or stale. A read or " +
          "change performed this turn is shown only by a calendar result or work result " +
          "in this turn. What Zeus already did to the calendar in this conversation is " +
          "recorded separately in the calendar history block.",
  );
  return lines;
}

function emailLines(state: EmailCapabilityState): string[] {
  const name = state.connectorLabel ?? "An inbox";
  if (!state.connected) {
    return [
      "Inbox: not connected. Zeus cannot read any inbox, and knows nothing about what is " +
        "waiting in one. The user connects Gmail in Settings, under Connections.",
    ];
  }
  if (!state.canRead) {
    if (state.temporarilyUnreachable) {
      return [
        `Inbox: ${name} is connected, and did not answer just now. The connection is ` +
          "intact and needs nothing from the user; Zeus retries on its own and will pick " +
          "it back up when the service answers. The inbox block, if present, is from " +
          "the last successful read.",
      ];
    }
    if (state.unusableReason === "missing_environment" && state.unusableStatus === "ready") {
      return [
        `Inbox: ${name} is connected but cannot be used right now (server configuration ` +
          "missing). This deployment is missing a server-side setting; the operator of this " +
          "Zeus has to restore it, and nothing in the user's Settings will change it.",
      ];
    }
    const reconnect = state.unusableReason === "reconnect_required";
    const disabled = state.unusableReason === "disabled";
    const status = reconnect
      ? "Reconnect required"
      : disabled
        ? "Disabled"
        : state.unusableStatus
          ? connectorStatusLabel(state.unusableStatus)
          : "unavailable";
    const action = reconnect
      ? "reconnected"
      : disabled
        ? "enabled"
        : state.unusableReason === "no_enabled_capability"
          ? "given Gmail access"
          : "reconnected or verified";
    return [
      `Inbox: ${name} is connected but cannot be used right now (${status}). Zeus cannot ` +
        `read it until it is ${action} in Settings, under Connections.`,
    ];
  }
  const writes = [
    ...(state.canDraft ? ["save a draft in the user's Gmail Drafts"] : []),
    ...(state.canTrash ? ["move a whole thread to the user's Gmail Trash"] : []),
    ...(state.canUntrash ? ["take a thread it moved to Trash back out again"] : []),
  ];
  return [
    `Inbox: ${name} is connected for reading. Zeus can see recent subjects and senders in ` +
      "the inbox block in this message. Zeus does not hold message bodies until the user " +
      "asks to open a thread.",
    writes.length === 0
      ? "Zeus cannot send, draft, or change mail. This inbox was connected before Zeus " +
        "could do any of that; reconnecting Gmail in Settings, under Connections, grants " +
        "it in one step."
      : `Zeus can ${series(writes)}, each after the user confirms that exact request. Zeus ` +
        "cannot send email, and cannot delete anything permanently. A saved draft is unsent " +
        "and waiting in Gmail; a trashed thread is in Gmail's Trash and can be put back. " +
        "Never describe either as done unless the work result says it was completed.",
    state.lastReadAt === null
      ? "Zeus has never successfully read this inbox."
      : "Zeus has read this inbox; the inbox block in this message is from that read and " +
        "says whether it is current or stale.",
  ];
}

/** "a", "a and b", "a, b, and c" — so the sentence reads the way a person would say it. */
function series(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function localDate(context: EvaluationContext): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(context.evaluated_at));
}

/** A connector label is free user text, so it cannot be allowed to close the block. */
function escapeCapabilityData(value: string): string {
  return value.replaceAll("</capabilities>", "<\\/capabilities>");
}

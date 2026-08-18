import { directExecutionAllowance } from "./calendar-policy";
import { readCalendarCoverage } from "./calendar-sync";
import {
  CAPABILITY_SLOTS,
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
          (CAPABILITY_SLOTS as readonly string[]).includes(capability.slot),
        ),
      ) ?? null;
  const connector = usable?.connector ?? bound;
  const unusableReason = usable || !bound
    ? null
    : bound.last_error_code ?? (
        bound.status === "ready"
          ? bound.enabled === 0
            ? "disabled"
            : "no_enabled_capability"
          : bound.status
      );

  const allowance = directExecutionAllowance(db);
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
 * The block itself.
 *
 * Prose rather than JSON: every line is a sentence the model can repeat to the user without
 * translating a field name first, and the failure this fixes was a model inventing prose in
 * the absence of any.
 */
export function renderCapabilityBlock(
  state: CalendarCapabilityState,
  context: EvaluationContext,
): string {
  const lines = [
    `Today is ${localDate(context)} (${context.local_weekday}), local time ` +
      `${context.local_time}, timezone ${context.timezone}.`,
    ...calendarLines(state),
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
    // theirs; Zeus already tried again this turn and will try again on the next request.
    if (state.temporarilyUnreachable) {
      return [
        `Calendar: ${name} is connected, and did not answer just now. The connection is ` +
          "intact and needs nothing from the user; Zeus tried again this turn and will try " +
          "again on the next request. It cannot say what is on the calendar until one of " +
          "those succeeds.",
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
            "and still stops to ask when the time is taken, the calendar cannot be read, or " +
            "more than one event matches. Clearing a stretch of time always stops to ask, and " +
            "lists everything it would cancel first."
        : "Calendar changes without asking each time: off. Every change stops for the user to " +
            "confirm the exact request.",
    );
  }
  lines.push(
    state.lastReadAt === null
      ? "Zeus has never successfully read this calendar."
      : `Zeus last read this calendar at ${state.lastReadAt}, and anything it saw then may ` +
          "have changed since. Only a calendar result in this turn says what is on the " +
          "calendar now. What Zeus has already done to it in this conversation is a separate " +
          "question, answered by the calendar history block rather than by a fresh read.",
  );
  return lines;
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

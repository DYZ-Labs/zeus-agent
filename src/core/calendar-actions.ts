import type { EventReference } from "./calendar-conflicts";
import type { CachedEvent } from "./calendar-time";
import type { CapabilitySlot, WorkPlanProposal } from "./schema";

/**
 * One calendar change, fully resolved before any plan exists.
 *
 * Everything the write needs is decided here, by the intent router and by deterministic
 * target resolution: which action, which event, which minutes. Nothing downstream asks a
 * model to invent a payload, which is what makes the executor's branch testable offline and
 * what stops a cancel from being aimed by a guess.
 *
 * The request travels inside the plan objective, so it is covered by the plan hash: the
 * authorization is bound to this exact action rather than to "some calendar work".
 */

export type CalendarRequest =
  | {
      kind: "create";
      title: string;
      startsAt: string;
      endsAt: string;
      location: string | null;
      timezone: string;
    }
  | {
      kind: "reschedule";
      reference: EventReference;
      startsAt: string;
      endsAt: string;
      timezone: string;
    }
  | { kind: "cancel"; reference: EventReference; timezone: string }
  /**
   * Everything inside a span, rather than one event picked out of it.
   *
   * Its own kind rather than a cancel with a looser target, because the two want opposite
   * things from ambiguity: a cancel that matches four events must refuse, and a clear that
   * matches four events has found exactly what it was asked for. Collapsing them would mean
   * relaxing the rule that stops the wrong meeting being deleted.
   */
  | { kind: "clear"; from: string; to: string; timezone: string }
  | { kind: "read"; from: string; to: string; timezone: string };

export type CalendarWriteRequest = Extract<
  CalendarRequest,
  { kind: "create" | "reschedule" | "cancel" | "clear" }
>;

const OPEN = "<calendar_request>";
const CLOSE = "</calendar_request>";

export function isCalendarWriteRequest(
  request: CalendarRequest,
): request is CalendarWriteRequest {
  return request.kind !== "read";
}

export function slotForRequest(request: CalendarWriteRequest): CapabilitySlot {
  return request.kind === "create" ? "calendar.create_event" : "calendar.update_event";
}

/** Embed the resolved action so the plan hash covers it and the executor can recover it. */
export function encodeCalendarRequest(request: CalendarRequest): string {
  return `${OPEN}${JSON.stringify(request)}${CLOSE}`;
}

export function parseCalendarRequest(objective: string): CalendarRequest | null {
  const start = objective.indexOf(OPEN);
  const end = objective.indexOf(CLOSE, start + OPEN.length);
  if (start < 0 || end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(objective.slice(start + OPEN.length, end));
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.kind === "string" &&
      ["create", "reschedule", "cancel", "clear", "read"].includes(record.kind)
      ? (parsed as CalendarRequest)
      : null;
  } catch {
    return null;
  }
}

/**
 * The exact bytes, built from the resolved request and the resolved target.
 *
 * Cancelling is an update with `status: "cancelled"` rather than a delete, which is what the
 * connected service actually offers — so it needs no capability slot of its own, and the
 * event and its history stay where a delete would have removed them.
 */
export function buildCalendarPayload(
  request: CalendarWriteRequest,
  target: CachedEvent | null,
): Record<string, unknown> {
  if (request.kind === "create") {
    return {
      title: request.title,
      start: request.startsAt,
      end: request.endsAt,
      time_zone: request.timezone,
      ...(request.location ? { location: request.location } : {}),
    };
  }
  if (!target) throw new Error("A change needs a resolved event to change");
  // A clear cancels each of its events one at a time, so each payload is a cancel. The
  // caller supplies the target; nothing here decides which events are in scope.
  if (request.kind === "reschedule") {
    return {
      event_id: target.external_id,
      start: request.startsAt,
      end: request.endsAt,
      time_zone: request.timezone,
    };
  }
  return { event_id: target.external_id, status: "cancelled" };
}

/** What the cache knew about the target, so the receipt can say what it was before Zeus changed it. */
export function priorStateOf(target: CachedEvent | null): Record<string, unknown> | null {
  if (!target) return null;
  return {
    external_id: target.external_id,
    title: target.title,
    start: target.starts_at,
    end: target.ends_at,
    location: target.location,
    status: "confirmed",
  };
}

export function previewFor(
  request: CalendarWriteRequest,
  target: CachedEvent | null,
): string {
  const name = request.kind === "create"
    ? request.title
    : (target?.title ?? "that event");
  if (request.kind === "create") {
    return `Create “${name}” from ${request.startsAt} to ${request.endsAt}.`;
  }
  if (request.kind === "reschedule") {
    return `Move “${name}” to ${request.startsAt}–${request.endsAt}.`;
  }
  if (request.kind === "clear") {
    // Names the event, not the window: this is the sentence shown against one exact payload,
    // and "clear Thursday afternoon" repeated four times would say nothing about what each
    // request would actually remove.
    return `Cancel “${name}”, clearing ${request.from} to ${request.to}.`;
  }
  return `Cancel “${name}”.`;
}

/**
 * Read, decide, act — in that order, and the reading is not optional.
 *
 * The write step is authorized alongside `external_read` because a write gate that reports
 * "nothing conflicts" from a calendar it never opened is worse than no gate at all. One
 * consequence worth being explicit about: a connection granted write access but not read
 * access can no longer create anything, and should say so plainly rather than fail.
 */
export function calendarActionWorkPlanProposal(
  request: CalendarRequest,
  objective: string,
): WorkPlanProposal {
  if (request.kind === "read") {
    return {
      objective,
      steps: [
        {
          title: "Read the connected calendar",
          instruction:
            "Read the connected Google Calendar so the chat can answer this request. " +
            "Do not create, change, or delete events.",
          effect_kind: "external_read",
          depends_on: [],
        },
      ],
      allowed_effects: ["external_read"],
      completion_criteria: [
        "The connected calendar was read and its events were returned only as untrusted external data.",
      ],
      limits: {
        max_model_tool_calls: 4,
        max_retries_per_step: 2,
        max_duration_seconds: 300,
      },
    };
  }

  const writeEffect = request.kind === "create" ? "schedule" : "modify_external";
  const action = request.kind === "create"
    ? "Create the event"
    : request.kind === "reschedule"
      ? "Move the event"
      : request.kind === "clear"
        ? "Clear the window"
        : "Cancel the event";
  return {
    objective,
    steps: [
      {
        title: "Read the connected calendar",
        instruction:
          "Read the connected Google Calendar so the requested time can be checked against " +
          "what is already there. Do not create, change, or delete anything.",
        effect_kind: "external_read",
        depends_on: [],
      },
      {
        title: request.kind === "clear" ? "List what is in the window" : "Check the requested time",
        instruction: request.kind === "clear"
          ? "Resolve every event inside the requested window from the calendar that was just " +
            "read, so the user can see exactly what would be cancelled. Do not send anything."
          : "Resolve the exact change from the request and the calendar that was just read, " +
            "and check the requested time against existing events. Do not send anything.",
        effect_kind: "prepare_local",
        depends_on: [1],
      },
      {
        title: action,
        instruction: request.kind === "clear"
          ? "Prepare one exact cancellation for every event inside the window and pause. " +
            "Clearing a window is never carried out unattended, however the standing setting " +
            "is configured; it waits for one confirmation covering all of them."
          : `${action} exactly as resolved. A free destination may follow the user's standing ` +
            "setting. An occupied destination must prepare the exact change and pause for one " +
            "explicit confirmation. An ambiguous target or unverifiable read stops here.",
        effect_kind: writeEffect,
        depends_on: [2],
      },
    ],
    allowed_effects: ["external_read", "prepare_local", writeEffect],
    completion_criteria: [
      request.kind === "clear"
        ? "The calendar was read, every event inside the window was resolved from it, and each " +
          "cancellation was left pending as an exact request until the user confirmed the set."
        : "The calendar was read, the requested time was checked against it, and the change was " +
          "either made under the applicable authorization or left pending as one exact, " +
          "conflict-disclosing request for the user to confirm.",
    ],
    limits: {
      max_model_tool_calls: 10,
      max_retries_per_step: 2,
      max_duration_seconds: 900,
    },
  };
}

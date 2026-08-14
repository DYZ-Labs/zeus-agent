import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  GoogleCalendarApi,
  GoogleCalendarError,
  type CalendarEventInput,
  type CalendarEventUpdate,
} from "./google";
import type { CalendarBrokerStore, CalendarGrant } from "./store";

const DateOrDateTime = z.string().trim().min(1).max(80).refine((value) => {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return true;
  return Number.isFinite(Date.parse(value));
}, "Expected an ISO date or date-time");

const EventFields = {
  title: z.string().trim().min(1).max(500),
  start: DateOrDateTime,
  end: DateOrDateTime,
  description: z.string().max(10_000).optional(),
  location: z.string().max(1_000).optional(),
  attendees: z.array(z.string().email()).max(100).optional(),
  time_zone: z.string().trim().min(1).max(120).optional(),
};

export function createGoogleCalendarMcpServer(input: {
  grant: CalendarGrant;
  store: CalendarBrokerStore;
  api: GoogleCalendarApi;
  requestKey: string | null;
}): McpServer {
  const server = new McpServer({ name: "zeus-google-calendar", version: "0.1.0" });

  server.registerTool(
    "list_events",
    {
      title: "List Google Calendar events",
      description: "List events from the connected user's primary Google Calendar.",
      inputSchema: {
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ from, to }) => {
      if (Date.parse(from) >= Date.parse(to)) return failure("The calendar window is invalid");
      try {
        return success(await input.api.listEvents(input.grant, from, to));
      } catch (error) {
        return calendarFailure(input, error);
      }
    },
  );

  server.registerTool(
    "create_event",
    {
      title: "Create a Google Calendar event",
      description: "Create one event on the connected user's primary Google Calendar.",
      inputSchema: EventFields,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (event) => {
      if (!input.requestKey) return failure("A durable Zeus request key is required");
      if (Date.parse(event.start) >= Date.parse(event.end)) {
        return failure("The event must end after it starts");
      }
      try {
        return success(
          await input.api.createEvent(
            input.grant,
            event as CalendarEventInput,
            input.requestKey,
          ),
        );
      } catch (error) {
        return calendarFailure(input, error);
      }
    },
  );

  server.registerTool(
    "update_event",
    {
      title: "Update a Google Calendar event",
      description: "Change or cancel one event on the connected user's primary Google Calendar.",
      inputSchema: {
        event_id: z.string().trim().min(1).max(1_024),
        title: EventFields.title.optional(),
        start: EventFields.start.optional(),
        end: EventFields.end.optional(),
        description: EventFields.description,
        location: EventFields.location,
        attendees: EventFields.attendees,
        time_zone: EventFields.time_zone,
        status: z.enum(["confirmed", "cancelled"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (event) => {
      if (event.start && event.end && Date.parse(event.start) >= Date.parse(event.end)) {
        return failure("The event must end after it starts");
      }
      try {
        return success(
          await input.api.updateEvent(input.grant, event as CalendarEventUpdate),
        );
      } catch (error) {
        return calendarFailure(input, error);
      }
    },
  );

  return server;
}

function calendarFailure(
  input: Pick<Parameters<typeof createGoogleCalendarMcpServer>[0], "grant" | "store">,
  error: unknown,
) {
  if (error instanceof GoogleCalendarError && error.code === "refresh_failed") {
    input.store.markReconnectRequired(input.grant.id, input.grant.accountId);
  }
  return failure(
    error instanceof GoogleCalendarError
      ? `${error.code}: ${error.message}`
      : "Google Calendar did not complete the request",
  );
}

function success(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function failure(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

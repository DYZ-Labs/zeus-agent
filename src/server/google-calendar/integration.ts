import "server-only";

import { randomUUID } from "node:crypto";

import {
  envelopeTimes,
  signBrokerEnvelope,
  verifyOAuthResult,
  type GoogleCalendarOAuthResult,
} from "@/calendar-broker/protocol";
import {
  configureGoogleCalendarCapabilities,
  getGoogleCalendarConnector,
  upsertGoogleCalendarConnector,
} from "@/core/connectors";
import { appendMessage, createConversation } from "@/core/conversations";
import type { Db } from "@/core/db";
import { verifyConnector } from "@/core/mcp-client";
import { getAppOwner } from "@/core/owner";
import { getAuthConfiguration } from "@/server/auth/config";
import { getGoogleCalendarIntegrationConfiguration } from "./config";

export function googleCalendarAuthorizationUrl(
  accountId: string,
  permission: "read" | "write",
): URL {
  const integration = requireConfiguration();
  const auth = getAuthConfiguration();
  if (auth.mode !== "configured") {
    throw new Error("Google Calendar requires a hosted account-enabled Zeus deployment");
  }
  const returnUrl = new URL(
    "/api/integrations/google-calendar/callback",
    auth.siteUrl,
  ).toString();
  const request = signBrokerEnvelope({
    kind: "google_calendar_oauth_request",
    accountId,
    returnUrl,
    permission,
    nonce: randomUUID(),
    ...envelopeTimes(),
  }, integration.serviceKey);
  const url = new URL("/oauth/google/start", integration.brokerUrl);
  url.searchParams.set("request", request);
  return url;
}

export function verifiedGoogleCalendarResult(
  envelope: string,
  accountId: string,
): GoogleCalendarOAuthResult {
  const integration = requireConfiguration();
  const result = verifyOAuthResult(envelope, integration.serviceKey);
  if (result.accountId !== accountId) {
    throw new Error("That Google Calendar grant belongs to a different Zeus account");
  }
  return result;
}

export async function applyGoogleCalendarResult(
  db: Db,
  result: GoogleCalendarOAuthResult,
): Promise<void> {
  const integration = requireConfiguration();
  const owner = getAppOwner(db);
  if (!owner || owner.supabase_user_id !== result.accountId) {
    throw new Error("That Google Calendar grant does not belong to this memory store");
  }
  const source = recordConnectionAction(
    db,
    result.scopes.some((scope) => scope.endsWith("/auth/calendar.events"))
      ? "Connect Google Calendar with permission to read and change events."
      : "Connect Google Calendar with permission to read events.",
  );
  const existing = getGoogleCalendarConnector(db);
  const connector =
    existing?.provider_connection_id === result.connectionId
      ? existing
      : upsertGoogleCalendarConnector(db, {
          connectionId: result.connectionId,
          mcpUrl: `${integration.brokerUrl}/mcp/${result.connectionId}`,
          sourceMessageId: source.id,
        });
  const verified = await verifyConnector(db, connector.id);
  configureGoogleCalendarCapabilities(db, {
    connectorId: connector.id,
    tools: verified.tools,
    scopes: result.scopes,
    sourceMessageId: source.id,
  });
}

export async function disconnectGoogleCalendarGrant(
  accountId: string,
  connectionId: string,
): Promise<void> {
  const integration = requireConfiguration();
  const response = await fetch(new URL("/connections/disconnect", integration.brokerUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${integration.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ accountId, connectionId }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("The credential broker did not confirm Google Calendar revocation");
  }
}

export function recordConnectionAction(db: Db, content: string) {
  const conversation = createConversation(db, {
    title: "Connection settings",
    source: "web",
  });
  return appendMessage(db, conversation.id, "user", content, {
    origin: "user_action",
    recallState: "blocked",
  });
}

function requireConfiguration() {
  const configuration = getGoogleCalendarIntegrationConfiguration();
  if (configuration.state !== "ready") {
    throw new Error(
      configuration.state === "misconfigured"
        ? configuration.message
        : "Google Calendar is not configured on this deployment",
    );
  }
  return configuration;
}

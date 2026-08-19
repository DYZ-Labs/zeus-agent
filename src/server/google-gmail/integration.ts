import "server-only";

import { randomUUID } from "node:crypto";

import {
  envelopeTimes,
  signBrokerEnvelope,
  verifyGmailOAuthResult,
  type GoogleGmailOAuthResult,
} from "@/calendar-broker/protocol";
import {
  configureGoogleGmailCapabilities,
  getGoogleGmailConnector,
  upsertGoogleGmailConnector,
} from "@/core/connectors";
import type { Db } from "@/core/db";
import { syncEmail } from "@/core/email-sync";
import { verifyConnector } from "@/core/mcp-client";
import { getAppOwner } from "@/core/owner";
import { getAuthConfiguration } from "@/server/auth/config";
import { recordConnectionAction } from "@/server/google-calendar/integration";
import { getGoogleGmailIntegrationConfiguration } from "./config";

export function googleGmailAuthorizationUrl(accountId: string): URL {
  const integration = requireConfiguration();
  const auth = getAuthConfiguration();
  if (auth.mode !== "configured") {
    throw new Error("Gmail requires a hosted account-enabled Zeus deployment");
  }
  const returnUrl = new URL(
    "/api/integrations/google-gmail/callback",
    auth.siteUrl,
  ).toString();
  const request = signBrokerEnvelope({
    kind: "google_gmail_oauth_request",
    accountId,
    returnUrl,
    nonce: randomUUID(),
    ...envelopeTimes(),
  }, integration.serviceKey);
  const url = new URL("/oauth/gmail/start", integration.brokerUrl);
  url.searchParams.set("request", request);
  return url;
}

export function verifiedGoogleGmailResult(
  envelope: string,
  accountId: string,
): GoogleGmailOAuthResult {
  const integration = requireConfiguration();
  const result = verifyGmailOAuthResult(envelope, integration.serviceKey);
  if (result.accountId !== accountId) {
    throw new Error("That Gmail grant belongs to a different Zeus account");
  }
  return result;
}

export async function applyGoogleGmailResult(
  db: Db,
  result: GoogleGmailOAuthResult,
): Promise<void> {
  const integration = requireConfiguration();
  const owner = getAppOwner(db);
  if (!owner || owner.supabase_user_id !== result.accountId) {
    throw new Error("That Gmail grant does not belong to this memory store");
  }
  const source = recordConnectionAction(
    db,
    "Connect Gmail with permission to read email. Zeus cannot send, draft, label, or delete email.",
  );
  const existing = getGoogleGmailConnector(db);
  const connector =
    existing?.provider_connection_id === result.connectionId
      ? existing
      : upsertGoogleGmailConnector(db, {
          connectionId: result.connectionId,
          mcpUrl: `${integration.brokerUrl}/gmail/mcp/${result.connectionId}`,
          sourceMessageId: source.id,
        });
  const verified = await verifyConnector(db, connector.id);
  configureGoogleGmailCapabilities(db, {
    connectorId: connector.id,
    tools: verified.tools,
    scopes: result.scopes,
    sourceMessageId: source.id,
  });
  await syncEmail(db, { signal: AbortSignal.timeout(10_000) });
}

export async function disconnectGoogleGmailGrant(
  accountId: string,
  connectionId: string,
): Promise<void> {
  const integration = requireConfiguration();
  const response = await fetch(
    new URL("/connections/gmail/disconnect", integration.brokerUrl),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integration.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountId, connectionId }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error("The credential broker did not confirm Gmail revocation");
  }
}

function requireConfiguration() {
  const configuration = getGoogleGmailIntegrationConfiguration();
  if (configuration.state !== "ready") {
    throw new Error(
      configuration.state === "misconfigured"
        ? configuration.message
        : "Gmail is not configured on this deployment",
    );
  }
  return configuration;
}

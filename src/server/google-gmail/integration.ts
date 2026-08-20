import "server-only";

import { randomUUID } from "node:crypto";

import {
  envelopeTimes,
  signBrokerEnvelope,
  verifyGmailOAuthResult,
  type GoogleGmailOAuthResult,
} from "@/calendar-broker/protocol";
import {
  GOOGLE_GMAIL_WRITE_SCOPE,
  configureGoogleGmailCapabilities,
  getGoogleGmailConnector,
  upsertGoogleGmailConnector,
} from "@/core/connectors";
import type { Db } from "@/core/db";
import { CONNECT_SYNC_TIMEOUT_MS, syncEmail } from "@/core/email-sync";
import { verifyConnector } from "@/core/mcp-client";
import { getAppOwner } from "@/core/owner";
import { getAuthConfiguration } from "@/server/auth/config";
import { recordConnectionAction } from "@/server/google-calendar/integration";
import { getGoogleGmailIntegrationConfiguration } from "./config";

export function googleGmailAuthorizationUrl(
  accountId: string,
  permission: "read" | "write" = "read",
): URL {
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
    permission,
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
  // Written from the scopes Google actually returned, not from the ones Zeus asked for.
  // This message is the `source_message_id` behind every capability row the next few lines
  // bind, so a write slot recorded against a sentence saying Zeus cannot write would be an
  // audit trail that disagrees with itself.
  const source = recordConnectionAction(db, gmailConsentSentence(result.scopes));
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
  await syncEmail(db, { signal: AbortSignal.timeout(CONNECT_SYNC_TIMEOUT_MS) });
}

function gmailConsentSentence(scopes: readonly string[]): string {
  return scopes.includes(GOOGLE_GMAIL_WRITE_SCOPE)
    ? "Connect Gmail with permission to read email, save drafts, and move threads to Trash. " +
      "Zeus cannot send email and cannot delete it permanently."
    : "Connect Gmail with permission to read email. Zeus cannot send, draft, label, or " +
      "delete email.";
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

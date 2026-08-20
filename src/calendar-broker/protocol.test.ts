import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  envelopeTimes,
  signBrokerEnvelope,
  verifyGmailOAuthRequest,
  verifyGmailOAuthResult,
  verifyOAuthRequest,
  verifyOAuthResult,
} from "./protocol";

const KEY = "test-service-key-that-is-longer-than-thirty-two-bytes";
const AT = new Date();

describe("Google Calendar broker envelopes", () => {
  it("authenticates an account-bound OAuth request", () => {
    const request = {
      kind: "google_calendar_oauth_request" as const,
      accountId: randomUUID(),
      returnUrl: "https://www.zeusagent.dev/api/integrations/google-calendar/callback",
      permission: "read" as const,
      nonce: randomUUID(),
      ...envelopeTimes(AT),
    };
    expect(verifyOAuthRequest(signBrokerEnvelope(request, KEY), KEY, AT)).toEqual(request);
  });

  it("keeps OAuth results bound to one account and connection", () => {
    const result = {
      kind: "google_calendar_oauth_result" as const,
      accountId: randomUUID(),
      connectionId: randomUUID(),
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      ...envelopeTimes(AT, 5 * 60),
    };
    expect(verifyOAuthResult(signBrokerEnvelope(result, KEY), KEY, AT)).toEqual(result);
  });

  it("keeps Gmail envelopes distinct from Calendar envelopes", () => {
    const accountId = randomUUID();
    const request = {
      kind: "google_gmail_oauth_request" as const,
      accountId,
      returnUrl: "https://www.zeusagent.dev/api/integrations/google-gmail/callback",
      permission: "read" as const,
      nonce: randomUUID(),
      ...envelopeTimes(AT),
    };
    const result = {
      kind: "google_gmail_oauth_result" as const,
      accountId,
      connectionId: randomUUID(),
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      ...envelopeTimes(AT, 5 * 60),
    };

    const signedRequest = signBrokerEnvelope(request, KEY);
    const signedResult = signBrokerEnvelope(result, KEY);
    expect(verifyGmailOAuthRequest(signedRequest, KEY, AT)).toEqual(request);
    expect(verifyGmailOAuthResult(signedResult, KEY, AT)).toEqual(result);
    expect(() => verifyOAuthRequest(signedRequest, KEY, AT)).toThrow();
    expect(() => verifyOAuthResult(signedResult, KEY, AT)).toThrow();
  });

  it("rejects tampering, expiry, and short service keys", () => {
    const request = {
      kind: "google_calendar_oauth_request" as const,
      accountId: randomUUID(),
      returnUrl: "https://www.zeusagent.dev/api/integrations/google-calendar/callback",
      permission: "read" as const,
      nonce: randomUUID(),
      ...envelopeTimes(AT),
    };
    const signed = signBrokerEnvelope(request, KEY);
    const signatureStart = signed.indexOf(".") + 1;
    const replacement = signed[signatureStart] === "A" ? "B" : "A";
    const tampered =
      `${signed.slice(0, signatureStart)}${replacement}${signed.slice(signatureStart + 1)}`;
    expect(() => verifyOAuthRequest(tampered, KEY, AT)).toThrow(/signature/u);
    expect(() =>
      verifyOAuthRequest(signed, KEY, new Date(AT.getTime() + 20 * 60 * 1000)),
    ).toThrow(/expired/u);
    expect(() => signBrokerEnvelope(request, "too-short")).toThrow(/at least 32 bytes/u);
  });
});

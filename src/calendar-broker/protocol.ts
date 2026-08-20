import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

const MAX_ENVELOPE_LIFETIME_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 60;

const EnvelopeTimes = {
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
};

export const GoogleCalendarOAuthRequest = z
  .object({
    kind: z.literal("google_calendar_oauth_request"),
    accountId: z.string().uuid(),
    returnUrl: z.string().url(),
    permission: z.enum(["read", "write"]),
    nonce: z.string().uuid(),
    ...EnvelopeTimes,
  })
  .strict();
export type GoogleCalendarOAuthRequest = z.infer<typeof GoogleCalendarOAuthRequest>;

export const GoogleCalendarOAuthResult = z
  .object({
    kind: z.literal("google_calendar_oauth_result"),
    accountId: z.string().uuid(),
    connectionId: z.string().uuid(),
    scopes: z.array(z.string()).max(32),
    ...EnvelopeTimes,
  })
  .strict();
export type GoogleCalendarOAuthResult = z.infer<typeof GoogleCalendarOAuthResult>;

export const GoogleGmailOAuthRequest = z
  .object({
    kind: z.literal("google_gmail_oauth_request"),
    accountId: z.string().uuid(),
    returnUrl: z.string().url(),
    /**
     * Defaulted rather than required, so the broker can ship before the app that asks for
     * write access. The reverse order cannot be made safe — this envelope is `.strict()`, and
     * a broker that has never heard of the field rejects one carrying it — so the default is
     * what makes "broker first, then web" an ordering rather than an outage.
     */
    permission: z.enum(["read", "write"]).default("read"),
    nonce: z.string().uuid(),
    ...EnvelopeTimes,
  })
  .strict();
export type GoogleGmailOAuthRequest = z.infer<typeof GoogleGmailOAuthRequest>;

export const GoogleGmailOAuthResult = z
  .object({
    kind: z.literal("google_gmail_oauth_result"),
    accountId: z.string().uuid(),
    connectionId: z.string().uuid(),
    scopes: z.array(z.string()).max(32),
    ...EnvelopeTimes,
  })
  .strict();
export type GoogleGmailOAuthResult = z.infer<typeof GoogleGmailOAuthResult>;

type SignedPayload =
  | GoogleCalendarOAuthRequest
  | GoogleCalendarOAuthResult
  | GoogleGmailOAuthRequest
  | GoogleGmailOAuthResult;

export function signBrokerEnvelope(payload: SignedPayload, serviceKey: string): string {
  assertEnvelopeTimes(payload);
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", normalizedServiceKey(serviceKey))
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export function verifyOAuthRequest(
  envelope: string,
  serviceKey: string,
  at: Date = new Date(),
): GoogleCalendarOAuthRequest {
  return verifyBrokerEnvelope(envelope, serviceKey, GoogleCalendarOAuthRequest, at);
}

export function verifyOAuthResult(
  envelope: string,
  serviceKey: string,
  at: Date = new Date(),
): GoogleCalendarOAuthResult {
  return verifyBrokerEnvelope(envelope, serviceKey, GoogleCalendarOAuthResult, at);
}

export function verifyGmailOAuthRequest(
  envelope: string,
  serviceKey: string,
  at: Date = new Date(),
): GoogleGmailOAuthRequest {
  return verifyBrokerEnvelope(envelope, serviceKey, GoogleGmailOAuthRequest, at);
}

export function verifyGmailOAuthResult(
  envelope: string,
  serviceKey: string,
  at: Date = new Date(),
): GoogleGmailOAuthResult {
  return verifyBrokerEnvelope(envelope, serviceKey, GoogleGmailOAuthResult, at);
}

export function envelopeTimes(
  at: Date = new Date(),
  lifetimeSeconds = 10 * 60,
): { issuedAt: number; expiresAt: number } {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new Error("Envelope lifetime must be a positive number of seconds");
  }
  const issuedAt = Math.floor(at.getTime() / 1000);
  return { issuedAt, expiresAt: issuedAt + lifetimeSeconds };
}

export function assertServiceKey(serviceKey: string): void {
  normalizedServiceKey(serviceKey);
}

function verifyBrokerEnvelope<T extends SignedPayload>(
  envelope: string,
  serviceKey: string,
  schema: z.ZodType<T>,
  at: Date,
): T {
  const parts = envelope.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid broker envelope");
  }
  const [body, encodedSignature] = parts;
  const expected = createHmac("sha256", normalizedServiceKey(serviceKey)).update(body).digest();
  let received: Buffer;
  try {
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("Invalid broker envelope");
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Invalid broker envelope signature");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid broker envelope payload");
  }
  const payload = schema.parse(decoded);
  assertEnvelopeTimes(payload, at);
  return payload;
}

function assertEnvelopeTimes(
  payload: Pick<SignedPayload, "issuedAt" | "expiresAt">,
  at: Date = new Date(),
): void {
  const now = Math.floor(at.getTime() / 1000);
  if (payload.expiresAt <= payload.issuedAt) throw new Error("Invalid broker envelope lifetime");
  if (payload.expiresAt - payload.issuedAt > MAX_ENVELOPE_LIFETIME_SECONDS) {
    throw new Error("Broker envelope lifetime is too long");
  }
  if (payload.issuedAt > now + CLOCK_SKEW_SECONDS) {
    throw new Error("Broker envelope was issued in the future");
  }
  if (payload.expiresAt <= now - CLOCK_SKEW_SECONDS) {
    throw new Error("Broker envelope expired");
  }
}

function normalizedServiceKey(serviceKey: string): Buffer {
  const normalized = serviceKey.trim();
  if (Buffer.byteLength(normalized, "utf8") < 32) {
    throw new Error("The Google broker service key must be at least 32 bytes");
  }
  return Buffer.from(normalized, "utf8");
}

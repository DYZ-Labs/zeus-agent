import "server-only";

import { z } from "zod";

import { assertServiceKey } from "@/calendar-broker/protocol";

export type GoogleGmailIntegrationConfiguration =
  | { state: "unconfigured" }
  | { state: "misconfigured"; message: string }
  | { state: "ready"; brokerUrl: string; serviceKey: string };

export function getGoogleGmailIntegrationConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GoogleGmailIntegrationConfiguration {
  const brokerUrl = environment.GOOGLE_GMAIL_BROKER_URL?.trim() ?? "";
  const serviceKey = environment.GOOGLE_GMAIL_BROKER_SERVICE_KEY?.trim() ?? "";
  if (!brokerUrl && !serviceKey) return { state: "unconfigured" };
  try {
    const parsedUrl = z.string().url().parse(brokerUrl);
    const url = new URL(parsedUrl);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Expected an exact HTTPS origin");
    }
    assertServiceKey(serviceKey);
    return { state: "ready", brokerUrl: url.origin, serviceKey };
  } catch {
    return {
      state: "misconfigured",
      message: "Gmail needs an HTTPS broker URL and a service key of at least 32 bytes.",
    };
  }
}

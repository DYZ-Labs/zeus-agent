import { isAbsolute } from "node:path";

import { z } from "zod";

import { assertServiceKey } from "./protocol";

const ExactOrigin = z.string().url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.pathname === "/" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, "Expected an exact HTTPS origin");

const HttpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:");

export type CalendarBrokerConfiguration = {
  host: string;
  port: number;
  databasePath: string;
  encryptionKey: Buffer;
  serviceKey: string;
  zeusAppUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
};

export function calendarBrokerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): CalendarBrokerConfiguration {
  const databasePath = environment.GOOGLE_CALENDAR_BROKER_DB?.trim() ?? "";
  if (!databasePath || (environment.NODE_ENV === "production" && !isAbsolute(databasePath))) {
    throw new Error(
      "GOOGLE_CALENDAR_BROKER_DB must be an absolute path on the broker's persistent volume",
    );
  }

  const encryptionValue = environment.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  let encryptionKey: Buffer;
  try {
    encryptionKey = Buffer.from(encryptionValue, "base64");
  } catch {
    throw new Error("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY must be base64");
  }
  if (encryptionKey.length !== 32) {
    throw new Error("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }

  const serviceKey = environment.GOOGLE_CALENDAR_BROKER_SERVICE_KEY?.trim() ?? "";
  assertServiceKey(serviceKey);
  const zeusAppUrl = ExactOrigin.parse(environment.ZEUS_APP_URL?.trim() ?? "").replace(/\/$/u, "");
  const googleRedirectUri = HttpsUrl.parse(
    environment.GOOGLE_OAUTH_REDIRECT_URI?.trim() ?? "",
  );
  if (new URL(googleRedirectUri).pathname !== "/oauth/google/callback") {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must end at /oauth/google/callback");
  }

  return {
    host: environment.HOST?.trim() || "0.0.0.0",
    port: z.coerce.number().int().min(1).max(65_535).parse(environment.PORT ?? "8787"),
    databasePath,
    encryptionKey,
    serviceKey,
    zeusAppUrl,
    googleClientId: z.string().trim().min(1).parse(environment.GOOGLE_OAUTH_CLIENT_ID),
    googleClientSecret: z.string().trim().min(1).parse(environment.GOOGLE_OAUTH_CLIENT_SECRET),
    googleRedirectUri,
  };
}

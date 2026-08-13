import "server-only";

import { z } from "zod";

import type { AuthMode } from "@/lib/auth-types";

function isExactHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const AuthEnvironment = z
  .object({
    url: z.string().url().refine(isExactHttpOrigin),
    publishableKey: z.string().min(1),
    siteUrl: z.string().url().refine(isExactHttpOrigin),
    legacyOwnerEmail: z.string().trim().toLowerCase().email().optional(),
    allowedSignupEmails: z.array(z.string().trim().toLowerCase().email()),
  })
  .strict();

/**
 * Split the signup allowlist. A malformed entry fails the whole configuration rather
 * than silently narrowing the list, matching how a malformed legacy owner email is
 * treated: an operator typo should be loud, not quietly permissive or quietly strict.
 */
function parseEmailList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export type AuthConfiguration =
  | { mode: "local" }
  | { mode: "misconfigured"; message: string }
  | {
      mode: "configured";
      url: string;
      publishableKey: string;
      siteUrl: string;
      /** Optional bridge from the original single-store deployment to its owner. */
      legacyOwnerEmail: string | null;
      /**
       * Emails permitted to establish a *new* personal store. Empty means no new
       * account may be created; accounts that already have a store are unaffected.
       */
      allowedSignupEmails: readonly string[];
    };

/**
 * Auth is opt-in so Zeus keeps its existing loopback-only local mode. Once either
 * Supabase credential is present, however, the configuration must be complete and web
 * access fails closed rather than silently exposing private memory.
 */
export function getAuthConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfiguration {
  const values = {
    url: environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    publishableKey: environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "",
    siteUrl: environment.NEXT_PUBLIC_SITE_URL?.trim() ?? "",
    legacyOwnerEmail: environment.ZEUS_OWNER_EMAIL?.trim() || undefined,
    allowedSignupEmails: parseEmailList(environment.ZEUS_ALLOWED_SIGNUP_EMAILS),
  };

  if (!values.url && !values.publishableKey) {
    return { mode: "local" };
  }

  const parsed = AuthEnvironment.safeParse(values);
  if (!parsed.success) {
    return {
      mode: "misconfigured",
      message:
        "Supabase login needs a project URL, publishable key, and NEXT_PUBLIC_SITE_URL " +
        "set to the app origin.",
    };
  }

  return {
    mode: "configured",
    url: parsed.data.url.replace(/\/$/u, ""),
    publishableKey: parsed.data.publishableKey,
    siteUrl: parsed.data.siteUrl.replace(/\/$/u, ""),
    legacyOwnerEmail: parsed.data.legacyOwnerEmail ?? null,
    allowedSignupEmails: parsed.data.allowedSignupEmails,
  };
}

/**
 * Whether this verified email may establish a new personal store.
 *
 * Deliberately fail-closed: an unset allowlist admits nobody new. Open registration
 * on a hosted deployment allocates a database, a migration run, and a long-lived
 * connection per stranger, so account creation is an operator decision.
 */
export function signupAllowed(
  email: string,
  configuration: AuthConfiguration,
): boolean {
  if (configuration.mode !== "configured") return false;
  return configuration.allowedSignupEmails.includes(email.trim().toLowerCase());
}

export function authMode(configuration: AuthConfiguration = getAuthConfiguration()): AuthMode {
  return configuration.mode;
}

export class AuthConfigurationError extends Error {
  constructor(configuration: Exclude<AuthConfiguration, { mode: "configured" }>) {
    super(
      configuration.mode === "local"
        ? "Supabase login is not configured."
        : configuration.message,
    );
    this.name = "AuthConfigurationError";
  }
}

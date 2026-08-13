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
  })
  .strict();

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
  };
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

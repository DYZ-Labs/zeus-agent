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
    ownerEmail: z.string().trim().toLowerCase().email(),
    siteUrl: z.string().url().refine(isExactHttpOrigin),
  })
  .strict();

export type AuthConfiguration =
  | { mode: "local" }
  | { mode: "misconfigured"; message: string }
  | {
      mode: "configured";
      url: string;
      publishableKey: string;
      ownerEmail: string;
      siteUrl: string;
    };

/**
 * Auth is opt-in so Zeus keeps its existing loopback-only local mode. Once any auth
 * variable is present, however, the configuration must be complete and web access
 * fails closed rather than silently exposing the one shared memory store.
 */
export function getAuthConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfiguration {
  const values = {
    url: environment.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    publishableKey: environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "",
    ownerEmail: environment.ZEUS_OWNER_EMAIL?.trim() ?? "",
    siteUrl: environment.NEXT_PUBLIC_SITE_URL?.trim() ?? "",
  };

  if (!values.url && !values.publishableKey && !values.ownerEmail) {
    return { mode: "local" };
  }

  const parsed = AuthEnvironment.safeParse(values);
  if (!parsed.success) {
    return {
      mode: "misconfigured",
      message: "Account access is temporarily unavailable.",
    };
  }

  return {
    mode: "configured",
    url: parsed.data.url.replace(/\/$/u, ""),
    publishableKey: parsed.data.publishableKey,
    ownerEmail: parsed.data.ownerEmail,
    siteUrl: parsed.data.siteUrl.replace(/\/$/u, ""),
  };
}

export function authMode(configuration: AuthConfiguration = getAuthConfiguration()): AuthMode {
  return configuration.mode;
}

export class AuthConfigurationError extends Error {
  constructor(configuration: Exclude<AuthConfiguration, { mode: "configured" }>) {
    super(
      configuration.mode === "local"
        ? "Account access is not configured."
        : configuration.message,
    );
    this.name = "AuthConfigurationError";
  }
}

import "server-only";

import { z } from "zod";

import type { AuthConfiguration } from "@/server/auth/config";

const PublicAuthSettings = z
  .object({
    external: z
      .object({
        google: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AuthCapabilities = {
  googleEnabled: boolean | null;
};

export async function getAuthCapabilities(
  configuration: AuthConfiguration,
): Promise<AuthCapabilities> {
  if (configuration.mode !== "configured") return { googleEnabled: null };

  try {
    const response = await fetch(`${configuration.url}/auth/v1/settings`, {
      cache: "no-store",
      headers: { apikey: configuration.publishableKey },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { googleEnabled: null };

    const parsed = PublicAuthSettings.safeParse(await response.json());
    return {
      googleEnabled: parsed.success ? (parsed.data.external?.google ?? false) : null,
    };
  } catch {
    return { googleEnabled: null };
  }
}

import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import {
  AuthConfigurationError,
  getAuthConfiguration,
  type AuthConfiguration,
} from "@/server/auth/config";

export async function createSupabaseServerClient(
  configuration: AuthConfiguration = getAuthConfiguration(),
  options: { cookieWrites?: "best-effort" | "required" } = {},
) {
  if (configuration.mode !== "configured") {
    throw new AuthConfigurationError(configuration);
  }

  const cookieStore = await cookies();

  return createServerClient(configuration.url, configuration.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, _headers) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch (error) {
          if (options.cookieWrites === "required") throw error;
          // Server Components cannot write cookies. The request Proxy refreshes and
          // persists the session before those components render.
        }
      },
    },
  });
}

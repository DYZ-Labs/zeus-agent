import { NextResponse, type NextRequest } from "next/server";

import { authorizeSupabaseUser } from "@/server/auth/access";
import { getAuthConfiguration } from "@/server/auth/config";
import {
  authDestinationFromRequest,
  clearAuthDestination,
} from "@/server/auth/destination";
import { createSupabaseServerClient } from "@/server/auth/supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const next = authDestinationFromRequest(request);
  const configuration = getAuthConfiguration();
  if (configuration.mode !== "configured") {
    return authRedirect(request.nextUrl.origin, "Account access is not configured.", next);
  }
  if (!code) {
    return authRedirect(configuration.siteUrl, "Google did not return a login code.", next);
  }

  const supabase = await createSupabaseServerClient(configuration, {
    cookieWrites: "required",
  });
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return authRedirect(configuration.siteUrl, oauthCallbackErrorMessage(error), next);
  }

  const access = authorizeSupabaseUser(data.user);
  if (!access.canAccessPrivateData) {
    await supabase.auth.signOut({ scope: "local" });
    return authRedirect(configuration.siteUrl, access.message, next);
  }

  return noStoreRedirect(new URL(next, configuration.siteUrl));
}

function authRedirect(origin: string, error: string, next: string): NextResponse {
  const url = new URL("/auth/login", origin);
  url.searchParams.set("error", error);
  if (next !== "/") url.searchParams.set("next", next);
  return noStoreRedirect(url);
}

function noStoreRedirect(url: URL): NextResponse {
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "private, no-store");
  clearAuthDestination(response);
  return response;
}

function oauthCallbackErrorMessage(error: { code?: string } | null): string {
  if (error?.code === "pkce_code_verifier_not_found") {
    return "Finish Google login in the same browser where you started it.";
  }
  if (error?.code === "bad_code_verifier") {
    return "That Google login belongs to an older attempt. Start again and finish the newest one.";
  }
  return "Google login could not be verified. Start a new login attempt.";
}

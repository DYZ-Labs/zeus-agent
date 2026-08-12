import { NextResponse, type NextRequest } from "next/server";
import type { AuthError, User } from "@supabase/supabase-js";
import { z } from "zod";

import { authorizeSupabaseUser } from "@/server/auth/access";
import { getAuthConfiguration } from "@/server/auth/config";
import {
  authDestinationFromRequest,
  clearAuthDestination,
} from "@/server/auth/destination";
import { createSupabaseServerClient } from "@/server/auth/supabase";

export const dynamic = "force-dynamic";

const EmailLinkType = z.enum(["signup", "magiclink", "email"]);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = EmailLinkType.safeParse(request.nextUrl.searchParams.get("type"));
  const next = authDestinationFromRequest(request);
  const configuration = getAuthConfiguration();
  if (configuration.mode !== "configured") {
    return authRedirect(request.nextUrl.origin, "Account access is not configured.", next);
  }

  const supabase = await createSupabaseServerClient(configuration, {
    cookieWrites: "required",
  });
  let user: User | null = null;
  let authError: AuthError | null = null;

  if (code) {
    // Supabase's default hosted email template uses ConfirmationURL. With the
    // @supabase/ssr PKCE flow, it returns an auth code to this redirect URL, so
    // local testing does not require custom SMTP or an editable email template.
    const result = await supabase.auth.exchangeCodeForSession(code);
    if (!result.error) user = result.data.user;
    else authError = result.error;
  } else if (tokenHash && type.success) {
    // Custom templates can send TokenHash directly to this route instead.
    const result = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type.data,
    });
    if (!result.error) user = result.data.user;
    else authError = result.error;
  } else {
    return authRedirect(
      configuration.siteUrl,
      "That email login link is invalid or incomplete.",
      next,
    );
  }

  if (!user) {
    return authRedirect(configuration.siteUrl, emailCallbackErrorMessage(authError), next);
  }

  const access = authorizeSupabaseUser(user);
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

function emailCallbackErrorMessage(error: AuthError | null): string {
  if (error?.code === "pkce_code_verifier_not_found") {
    return "Open the newest email link in the same browser where you requested it.";
  }
  if (error?.code === "bad_code_verifier") {
    return "That link belongs to an older login attempt. Request a new link and use the newest one.";
  }
  if (error?.code === "otp_expired") {
    return "That email link expired or was already used. Request a new one.";
  }
  return "That email login link could not be verified. Request a new link and use it in this browser.";
}

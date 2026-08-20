import { NextResponse, type NextRequest } from "next/server";

import { getOwnerAccess } from "@/server/auth/access";
import { getAuthConfiguration } from "@/server/auth/config";
import { googleGmailAuthorizationUrl } from "@/server/google-gmail/integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await getOwnerAccess();
  if (!access.canAccessPrivateData || access.state !== "authorized" || !access.account) {
    return settingsError(request, access.message ?? "Sign in before connecting Gmail.");
  }
  try {
    const response = NextResponse.redirect(
      googleGmailAuthorizationUrl(access.account.id),
      303,
    );
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    return settingsError(
      request,
      error instanceof Error ? error.message : "Gmail is unavailable.",
    );
  }
}

function settingsError(request: NextRequest, message: string): NextResponse {
  const configuration = getAuthConfiguration();
  const origin = configuration.mode === "configured"
    ? configuration.siteUrl
    : request.nextUrl.origin;
  const url = new URL("/settings", origin);
  url.searchParams.set("connector_error", message);
  url.hash = "connections";
  return NextResponse.redirect(url, 303);
}

import { NextResponse, type NextRequest } from "next/server";

import { getOwnerAccess } from "@/server/auth/access";
import { getAuthConfiguration } from "@/server/auth/config";
import {
  applyGoogleCalendarResult,
  verifiedGoogleCalendarResult,
} from "@/server/google-calendar/integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await getOwnerAccess();
  if (!access.canAccessPrivateData || access.state !== "authorized" || !access.account) {
    return settingsRedirect(request, access.message ?? "Sign in to finish connecting Google Calendar.");
  }
  const envelope = request.nextUrl.searchParams.get("result");
  if (!envelope) return settingsRedirect(request, "Google Calendar returned no connection result.");
  try {
    const result = verifiedGoogleCalendarResult(envelope, access.account.id);
    await applyGoogleCalendarResult(access.db, result);
    const url = new URL("/settings", publicOrigin(request));
    url.searchParams.set("connector_success", "Google Calendar connected.");
    url.hash = "connections";
    const response = NextResponse.redirect(url, 303);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return settingsRedirect(
      request,
      error instanceof Error ? error.message : "Google Calendar could not be connected.",
    );
  }
}

function settingsRedirect(request: NextRequest, message: string): NextResponse {
  const url = new URL("/settings", publicOrigin(request));
  url.searchParams.set("connector_error", message);
  url.hash = "connections";
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function publicOrigin(request: NextRequest): string {
  const configuration = getAuthConfiguration();
  return configuration.mode === "configured" ? configuration.siteUrl : request.nextUrl.origin;
}

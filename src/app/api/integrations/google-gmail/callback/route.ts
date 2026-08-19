import { NextResponse, type NextRequest } from "next/server";

import { getOwnerAccess } from "@/server/auth/access";
import { getAuthConfiguration } from "@/server/auth/config";
import {
  applyGoogleGmailResult,
  verifiedGoogleGmailResult,
} from "@/server/google-gmail/integration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await getOwnerAccess();
  if (!access.canAccessPrivateData || access.state !== "authorized" || !access.account) {
    return settingsRedirect(request, access.message ?? "Sign in to finish connecting Gmail.");
  }
  const envelope = request.nextUrl.searchParams.get("result");
  if (!envelope) return settingsRedirect(request, "Google returned no Gmail connection result.");
  try {
    const result = verifiedGoogleGmailResult(envelope, access.account.id);
    await applyGoogleGmailResult(access.db, result);
    const url = new URL("/settings", publicOrigin(request));
    url.searchParams.set("connector_success", "Gmail connected.");
    url.hash = "connections";
    const response = NextResponse.redirect(url, 303);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return settingsRedirect(
      request,
      error instanceof Error ? error.message : "Gmail could not be connected.",
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
  return configuration.mode === "configured"
    ? configuration.siteUrl
    : request.nextUrl.origin;
}

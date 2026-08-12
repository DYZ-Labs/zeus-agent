import type { NextRequest, NextResponse } from "next/server";

import { safeNextPath } from "@/server/auth/paths";

export const AUTH_DESTINATION_COOKIE = "zeus-auth-next";

export function authDestinationCookie(value: string, siteUrl: string) {
  return {
    name: AUTH_DESTINATION_COOKIE,
    value: safeNextPath(value),
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/auth",
    sameSite: "lax" as const,
    secure: siteUrl.startsWith("https://"),
  };
}

export function authDestinationFromRequest(request: NextRequest): string {
  return safeNextPath(
    request.cookies.get(AUTH_DESTINATION_COOKIE)?.value ??
      request.nextUrl.searchParams.get("next"),
  );
}

export function clearAuthDestination(response: NextResponse): void {
  response.cookies.set({
    name: AUTH_DESTINATION_COOKIE,
    value: "",
    httpOnly: true,
    maxAge: 0,
    path: "/auth",
    sameSite: "lax",
  });
}

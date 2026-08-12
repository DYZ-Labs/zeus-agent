import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getAuthConfiguration } from "@/server/auth/config";

const PUBLIC_PATHS = new Set(["/", "/settings"]);

/**
 * Refresh Supabase cookies and provide a coarse signed-in gate. The data-access layer
 * still verifies the immutable local owner on every DB boundary; Proxy is only the
 * fast outer door and is never the sole authorization check.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const configuration = getAuthConfiguration();
  if (configuration.mode === "local") return NextResponse.next({ request });

  const isAuthPath = request.nextUrl.pathname.startsWith("/auth/");
  const isPublicPage = PUBLIC_PATHS.has(request.nextUrl.pathname) || isAuthPath;
  const isApi = request.nextUrl.pathname.startsWith("/api/");
  const isGuestChatApi = request.nextUrl.pathname === "/api/chat";

  if (configuration.mode === "misconfigured") {
    if (isApi) {
      return NextResponse.json({ error: configuration.message }, { status: 503 });
    }
    if (isPublicPage) return NextResponse.next({ request });
    return loginRedirect(request, configuration.message);
  }

  let sessionResponse = NextResponse.next({ request });
  const supabase = createServerClient(configuration.url, configuration.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        sessionResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          sessionResponse.cookies.set(name, value, options);
        });
        Object.entries(headers).forEach(([key, value]) => {
          sessionResponse.headers.set(key, value);
        });
      },
    },
  });

  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) {
      if (isApi && !isGuestChatApi) {
        return copySession(
          Response.json({ error: "Authentication required." }, { status: 401 }),
          sessionResponse,
        );
      }
      if (!isPublicPage && !isGuestChatApi) {
        return copySession(loginRedirect(request), sessionResponse);
      }
    }
  } catch {
    if (isApi) {
      return copySession(
        Response.json({ error: "Account verification is temporarily unavailable." }, { status: 503 }),
        sessionResponse,
      );
    }
    if (!isPublicPage) {
      return copySession(
        loginRedirect(request, "Account verification is temporarily unavailable."),
        sessionResponse,
      );
    }
  }

  return sessionResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

function loginRedirect(request: NextRequest, error?: string): NextResponse {
  const url = new URL("/auth/login", request.url);
  const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (requestedPath !== "/") url.searchParams.set("next", requestedPath);
  if (error) url.searchParams.set("error", error);
  const response = NextResponse.redirect(url);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function copySession(response: Response, sessionResponse: NextResponse): NextResponse {
  const result = new NextResponse(response.body, response);
  sessionResponse.cookies.getAll().forEach((cookie) => result.cookies.set(cookie));
  for (const key of ["cache-control", "expires", "pragma"]) {
    const value = sessionResponse.headers.get(key);
    if (value) result.headers.set(key, value);
  }
  result.headers.set("Cache-Control", "private, no-store");
  return result;
}

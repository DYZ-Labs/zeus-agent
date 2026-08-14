import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { logEvent } from "@/core/observability";
import { getAuthConfiguration, type AuthConfiguration } from "@/server/auth/config";
import {
  applyBrowserSecurityHeaders,
  checkBrowserBoundary,
} from "@/server/auth/browser-origin";

const PUBLIC_PATHS = new Set(["/", "/settings"]);
/**
 * The health check answers before authentication, because the states worth reporting
 * include the ones where authentication itself is broken. It returns no user data.
 */
const HEALTH_PATH = "/api/health";

/**
 * Refresh Supabase cookies and provide a coarse signed-in gate. The data-access layer
 * still verifies the immutable local owner on every DB boundary; Proxy is only the
 * fast outer door and is never the sole authorization check.
 *
 * Every response leaves through one hardening step. Routing decides *what* to return;
 * it never decides whether the response is hardened.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const configuration = getAuthConfiguration();
  return applyBrowserSecurityHeaders(
    await routeRequest(request, configuration),
    configuration,
  ) as NextResponse;
}

async function routeRequest(
  request: NextRequest,
  configuration: AuthConfiguration,
): Promise<NextResponse> {
  // Readiness must not depend on Supabase. Railway calls this endpoint before it
  // routes traffic to a new deployment; waiting on external auth here can reject an
  // otherwise healthy process during an auth outage. The route returns operational
  // state only, and the outer proxy still applies the normal security headers.
  const isHealth = request.nextUrl.pathname === HEALTH_PATH;
  if (isHealth) return NextResponse.next({ request });

  if (configuration.mode === "local") {
    const capability = isSafeMethod(request.method) ? "private-read" : "private-mutation";
    const boundary = checkBrowserBoundary(request, capability, configuration);
    if (!boundary.allowed) {
      return boundaryDenied(request, boundary.message);
    }
    return NextResponse.next({ request });
  }

  if (configuration.mode === "configured" && !isSafeMethod(request.method)) {
    const boundary = checkBrowserBoundary(request, "private-mutation", configuration);
    if (!boundary.allowed) return boundaryDenied(request, boundary.message);
  }

  const isAuthPath = request.nextUrl.pathname.startsWith("/auth/");
  const isPublicPage = PUBLIC_PATHS.has(request.nextUrl.pathname) || isAuthPath;
  const isApi = request.nextUrl.pathname.startsWith("/api/");

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
      if (isApi) {
        return copySession(
          Response.json({ error: "Authentication required." }, { status: 401 }),
          sessionResponse,
        );
      }
      if (!isPublicPage) {
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

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/**
 * Denials are logged; successful pass-through is not. An operator needs to see the
 * door being rattled without paying for a line per page view, and a 403 here is the
 * one outcome that is always worth explaining after the fact.
 */
function logDenial(request: NextRequest, reason: string, status: number): void {
  logEvent({
    event: "http_denied",
    outcome: "error",
    reason,
    status,
    method: request.method,
    route: request.nextUrl.pathname,
  });
}

function boundaryDenied(request: NextRequest, message: string): NextResponse {
  logDenial(request, "forbidden_origin", 403);
  return request.nextUrl.pathname.startsWith("/api/")
    ? NextResponse.json({ error: message }, { status: 403 })
    : new NextResponse("Forbidden", { status: 403 });
}

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

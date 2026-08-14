import { createServerClient, type CookieOptions } from "@supabase/ssr";
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
 * Zeus has no browser Supabase client — every auth call happens on the server — so
 * nothing in this application needs to read the session from JavaScript. @supabase/ssr
 * defaults to `httpOnly: false` for the sake of the browser client it also ships, and
 * never sets `secure` at all. Accepting those defaults means one XSS is a full account
 * takeover, and the stolen cookie stays valid for the library's 400-day lifetime.
 *
 * Thirty days is the ceiling: long enough that ordinary use never meets a login screen,
 * short enough that a cookie lifted today stops working within the month even if the
 * theft is never noticed.
 */
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Every other outbound dependency in Zeus is bounded; this one gates *every* request,
 * so leaving it unbounded is the worst place to make an exception. Undici waits roughly
 * five minutes by default, and one process serves every account, so a Supabase slowdown
 * accumulates in-flight requests with nothing to stop them. Eight seconds is above any
 * healthy round trip to the auth service and far below the point where the browser has
 * already given up on the page.
 */
const AUTH_REQUEST_TIMEOUT_MS = 8_000;

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
  const secure = secureSessionCookies(configuration.siteUrl);
  const supabase = createServerClient(configuration.url, configuration.publishableKey, {
    global: { fetch: boundedAuthFetch },
    cookieOptions: {
      httpOnly: true,
      secure,
      // The provider redirect that finishes an OAuth login is a cross-site navigation
      // back into Zeus; `strict` would withhold the session on exactly that hop.
      sameSite: "lax",
      path: "/",
    },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        sessionResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          sessionResponse.cookies.set(name, value, hardenSessionCookie(options, secure));
        });
        Object.entries(headers).forEach(([key, value]) => {
          sessionResponse.headers.set(key, value);
        });
      },
    },
  });

  const verificationUnavailable = (): NextResponse => {
    if (isApi) {
      return copySession(
        Response.json({ error: "Account verification is temporarily unavailable." }, { status: 503 }),
        sessionResponse,
      );
    }
    if (isPublicPage) return sessionResponse;
    return copySession(
      loginRedirect(request, "Account verification is temporarily unavailable."),
      sessionResponse,
    );
  };

  try {
    const { data, error } = await supabase.auth.getClaims();
    // A transport failure never reaches the catch below: auth-js converts it into a
    // returned error, where it is indistinguishable from "no session". Reported that
    // way, a Supabase slowdown would look like every account signing itself out.
    if (error && isTransportFailure(error)) return verificationUnavailable();
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
    return verificationUnavailable();
  }

  return sessionResponse;
}

/**
 * Follow the configured public origin rather than NODE_ENV, the same signal that
 * decides HSTS. `next dev -H 127.0.0.1` serves plain http, where a Secure cookie is
 * silently dropped and login simply stops working; the site URL is the honest
 * statement of how browsers actually reach this deployment.
 */
function secureSessionCookies(siteUrl: string): boolean {
  return siteUrl.startsWith("https://");
}

/**
 * @supabase/ssr merges the client-level `cookieOptions` into every write but then
 * reapplies its own 400-day `maxAge` on top, so the lifetime can only be capped here,
 * on the way out. Clamping rather than assigning leaves the library's `maxAge: 0`
 * deletions deleting.
 */
function hardenSessionCookie(options: CookieOptions, secure: boolean): CookieOptions {
  return {
    ...options,
    httpOnly: true,
    secure,
    maxAge: Math.min(
      options.maxAge ?? SESSION_COOKIE_MAX_AGE_SECONDS,
      SESSION_COOKIE_MAX_AGE_SECONDS,
    ),
  };
}

/** Bound the one outbound call that stands between a visitor and every page. */
function boundedAuthFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const deadline = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    // Compose rather than replace: the caller's own signal still has to be able to
    // cancel the request, and auth-js does not always supply one.
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

/**
 * Whether Supabase failed to answer at all — a timeout, a refused connection, a 5xx.
 * auth-js reports all of them as `AuthRetryableFetchError`, and its own
 * `isAuthRetryableFetchError` is this exact name check; the class is not re-exported
 * by `@supabase/supabase-js`, so match the name rather than take a direct dependency
 * on `@supabase/auth-js`. An unrecognised name falls through to the signed-out branch,
 * which is where this code already was.
 */
function isTransportFailure(error: { name?: string }): boolean {
  return error.name === "AuthRetryableFetchError";
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

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { errorSignature, logEvent } from "@/core/observability";
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

  const verificationUnavailable = (
    reason: AuthUnavailableReason,
    error: unknown,
  ): NextResponse => {
    // A public page is still served during the outage; the other two exits refuse the
    // request, and the status records which of the three the visitor actually met.
    const status = isApi ? 503 : isPublicPage ? 200 : 307;
    logAuthUnavailable(request, reason, error, status);
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

  // The handler covers the outbound call and nothing else. Reporting the outage from
  // inside it would put the log call under its own catch: one throw there would run the
  // failure path a second time, and that second throw has no handler left above it, so an
  // outage Zeus otherwise degrades gracefully would become a middleware 500 on every
  // request for as long as it lasted.
  let answer: Awaited<ReturnType<typeof supabase.auth.getClaims>> | undefined;
  let fault: unknown;
  try {
    answer = await supabase.auth.getClaims();
  } catch (error) {
    fault = error;
  }
  if (!answer) return verificationUnavailable("unexpected_error", fault);

  const { data, error } = answer;
  // A transport failure never reaches the catch above: auth-js converts it into a
  // returned error, where it is indistinguishable from "no session". Reported that
  // way, a Supabase slowdown would look like every account signing itself out.
  if (error && isTransportFailure(error)) {
    return verificationUnavailable(transportReason(error), error);
  }
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

type AuthUnavailableReason = "transport_failure" | "upstream_5xx" | "unexpected_error";

/**
 * Which transport failure it was. Not a detail: "Supabase never answered" and "Supabase
 * answered 503" are repaired by different people, and the class alone cannot tell them
 * apart — auth-js builds the same `AuthRetryableFetchError`, carrying no code, for both.
 * The one discriminator it does carry is the status it attached: 0 when nothing answered
 * at all, and the upstream status when the service answered with a server error. That
 * cannot go in `status`, which is already the status Zeus returned to the visitor, so it
 * survives as a reason Zeus itself names.
 */
function transportReason(error: unknown): "transport_failure" | "upstream_5xx" {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 500 ? "upstream_5xx" : "transport_failure";
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
    route: routeTemplate(request.nextUrl.pathname),
    // No account: this boundary is deliberately checked before any identity exists. The
    // session cookie is not one — a subject Zeus has not verified would let a caller
    // choose whose name a security event is filed under — and verifying one here would
    // make every rejected request pay for an outbound auth call. The owner boundary
    // reports the refusals that do have a verified identity behind them.
  });
}

/**
 * An auth service that stops answering locks every account out of its own memory, and
 * until now the only place that said so was the visitor's screen. This is the line to
 * alert on, and the one that separates "Supabase is down" from every account genuinely
 * signing out at once.
 *
 * A public page is still served during the outage — anonymously, which is a degradation
 * rather than a failure — so it is reported as one, while a refused API call and a
 * redirect away from a private page are outright failures. The reason then separates the
 * three incidents behind that one visitor-facing sentence: nothing answered, Supabase
 * answered badly, or this code path is itself broken. The error's signature is carried
 * alongside rather than instead — for a returned transport failure it is the same class
 * every time, constructed inside a dependency, so on its own it names no incident.
 */
function logAuthUnavailable(
  request: NextRequest,
  reason: AuthUnavailableReason,
  error: unknown,
  status: number,
): void {
  logEvent({
    event: "auth_unavailable",
    outcome: status === 200 ? "degraded" : "error",
    reason,
    status,
    method: request.method,
    route: routeTemplate(request.nextUrl.pathname),
    ...errorSignature(error),
  });
}

/**
 * Every route shape this deployment serves, written the way Next.js names them and the way
 * the rest of Zeus already reports them — `logBudgetDenial("/api/work-plans/[id]/run", …)`.
 * A route added to `src/app/` belongs here too; until it is, it reports as unmatched.
 */
const ROUTE_TEMPLATES = [
  "/",
  "/auth/callback",
  "/auth/confirm",
  "/auth/login",
  "/auth/signup",
  "/conversations",
  "/effects/[id]",
  "/entity/[slug]",
  "/memory",
  "/open-loops",
  "/response/[id]",
  "/settings",
  "/source/[id]",
  "/timeline",
  "/today",
  "/understanding",
  "/understanding/backfill",
  "/work-artifacts/[id]",
  "/api/chat",
  "/api/follow-through",
  "/api/health",
  "/api/integrations/google-calendar/callback",
  "/api/integrations/google-calendar/start",
  "/api/location",
  "/api/opportunities/[id]/delivery",
  "/api/work-artifacts/[id]",
  "/api/work-plans",
  "/api/work-plans/[id]",
  "/api/work-plans/[id]/authorize",
  "/api/work-plans/[id]/run",
  "/api/work-runs/[id]",
] as const;

/** One token for everything this deployment does not serve, so a stray path cannot describe itself. */
const UNMATCHED_ROUTE = "/unmatched";

/**
 * Name the route a request asked for without quoting the request.
 *
 * A resolved path is not a safe value here. `/entity/[slug]` resolves to
 * `slugify(entity.name)` — a person out of the user's own memory — and `/source/[id]`
 * numbers one of their stored conversations; both satisfy the `route` pattern perfectly,
 * because a pattern can only say what a value looks like, never where it came from. So the
 * path is matched against the closed vocabulary above and the *template* is what is
 * reported. That makes the guarantee structural rather than careful: every value that can
 * leave here is one of those literals or the single unmatched token, which is also what a
 * route nobody listed reports. Stripping the dynamic segment with a regex would instead be
 * a denylist, and would leak the first time a route did not fit its shape.
 *
 * The query is not represented at all, in any form. It carries the destination the caller
 * asked for and whatever else a link put there.
 */
function routeTemplate(pathname: string): string {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const segments = path.split("/");
  const match = ROUTE_TEMPLATES.find((template) => {
    const parts = template.split("/");
    return (
      parts.length === segments.length &&
      parts.every((part, index) => part === segments[index] || part.startsWith("["))
    );
  });
  return match ?? UNMATCHED_ROUTE;
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

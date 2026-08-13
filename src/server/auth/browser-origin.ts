import type { AuthConfiguration } from "./config";

export type BrowserCapability = "private-read" | "private-mutation";

export type BrowserBoundaryResult =
  | { allowed: true; origin: string }
  | { allowed: false; message: string };

const FORBIDDEN_MESSAGE =
  "This private Zeus browser request did not come from the configured app origin.";

/**
 * Keep the unauthenticated local web UI on its literal loopback authority. A hostname
 * that merely resolves to loopback is not equivalent: accepting it would let DNS
 * rebinding turn an attacker's origin into a front door to the private store.
 */
export function checkBrowserBoundary(
  request: Pick<Request, "headers" | "method" | "url">,
  capability: BrowserCapability,
  configuration: AuthConfiguration,
): BrowserBoundaryResult {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return forbidden();
  }

  if (configuration.mode === "misconfigured") return forbidden();

  const origin = headerOrigin(request.headers.get("origin"));
  const referer = headerOrigin(request.headers.get("referer"));
  let expectedOrigin: string;
  if (configuration.mode === "local") {
    const host = request.headers.get("host");
    if (
      target.protocol !== "http:" ||
      !literalLoopbackAuthority(host) ||
      (target.hostname === "127.0.0.1" && target.host !== host) ||
      (target.hostname !== "127.0.0.1" && target.hostname !== "localhost")
    ) {
      return forbidden();
    }
    // NextRequest may internally spell the URL hostname as `localhost`; the HTTP Host
    // authority is the browser-controlled value relevant to DNS rebinding.
    expectedOrigin = `http://${host}`;
  } else {
    expectedOrigin = new URL(configuration.siteUrl).origin;
    // Behind Railway (and similar reverse proxies), NextRequest.url can contain the
    // service's internal authority even though the browser reached the configured
    // public origin. An exact browser Origin/Referer still proves the public boundary;
    // requiring the internal request URL to match would reject every legitimate
    // production Server Action before it reaches Supabase.
    if (
      target.origin !== expectedOrigin &&
      origin !== expectedOrigin &&
      referer !== expectedOrigin
    ) {
      return forbidden();
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase() ?? null;
  if (fetchSite === "cross-site" || fetchSite === "same-site") return forbidden();

  if (origin !== null && origin !== expectedOrigin) return forbidden();
  if (referer !== null && referer !== expectedOrigin) return forbidden();

  if (capability === "private-mutation") {
    // Browser fetch sends Origin for unsafe methods. Requiring it turns possession of
    // the exact local browser origin into the capability to mutate the private store.
    if (origin !== expectedOrigin || fetchSite === "none") return forbidden();
  }

  return { allowed: true, origin: expectedOrigin };
}

/**
 * Harden every browser-facing response so it is not framable, sniffable, cacheable by
 * an intermediary, or reusable from another origin.
 *
 * Local and configured mode deliberately share one set. The publicly reachable
 * deployment must never be weaker than the loopback one, and applying this at a single
 * exit point is what keeps a newly added branch from silently shipping bare responses.
 */
export function applyBrowserSecurityHeaders(
  response: Response,
  configuration: AuthConfiguration,
): Response {
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Paths carry entity slugs and source/response ids. Same-origin keeps the full
  // referer for Zeus's own boundary check while sending none to a third party.
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Cache-Control", "private, no-store");
  if (configuration.mode === "configured" && configuration.siteUrl.startsWith("https://")) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  return response;
}

function literalLoopbackAuthority(host: string | null): host is string {
  return host !== null && /^127\.0\.0\.1(?::\d{1,5})?$/u.test(host);
}

function headerOrigin(value: string | null): string | null | "invalid" {
  if (value === null) return null;
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function forbidden(): BrowserBoundaryResult {
  return { allowed: false, message: FORBIDDEN_MESSAGE };
}

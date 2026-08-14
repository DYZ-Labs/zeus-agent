import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

import {
  AuthConfigurationError,
  getAuthConfiguration,
  type AuthConfiguration,
} from "@/server/auth/config";

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
 * Every other outbound dependency in Zeus is bounded, and these calls gate the private
 * store. Undici waits roughly five minutes by default, and one process serves every
 * account, so a Supabase slowdown accumulates in-flight requests with nothing to stop
 * them. Eight seconds leaves room for the slowest call here — requesting a magic link
 * waits on Supabase dispatching the email — while still releasing the connection long
 * before the visitor's browser has any patience left.
 */
const AUTH_REQUEST_TIMEOUT_MS = 8_000;

export async function createSupabaseServerClient(
  configuration: AuthConfiguration = getAuthConfiguration(),
  options: { cookieWrites?: "best-effort" | "required" } = {},
) {
  if (configuration.mode !== "configured") {
    throw new AuthConfigurationError(configuration);
  }

  const cookieStore = await cookies();
  const secure = secureSessionCookies(configuration.siteUrl);

  const client = createServerClient(configuration.url, configuration.publishableKey, {
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
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, _headers) {
        try {
          cookiesToSet.forEach(({ name, value, options: cookieOptions }) => {
            cookieStore.set(name, value, hardenSessionCookie(cookieOptions, secure));
          });
        } catch (error) {
          if (options.cookieWrites === "required") throw error;
          // Server Components cannot write cookies. The request Proxy refreshes and
          // persists the session before those components render.
        }
      },
    },
  });

  // Callers tell "signed out" apart from "could not verify" by whether the call threw,
  // but auth-js reports a transport failure — this client's timeout, a refused
  // connection, a Supabase 5xx — as a returned error next to a null user. Left that
  // way, a Supabase slowdown reads as a logout and sends a signed-in owner to the login
  // screen with no explanation. Rethrow that one class so an outage stays an outage.
  const getUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = async (jwt?: string) => {
    const result = await getUser(jwt);
    if (result.error && isTransportFailure(result.error)) throw result.error;
    return result;
  };

  return client;
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

/** Bound every call this client makes to Supabase. */
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

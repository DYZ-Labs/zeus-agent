import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getAuthConfiguration: vi.fn(),
  getClaims: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: mocks.getAuthConfiguration,
}));

import { proxy } from "./proxy";

const CONFIGURED = {
  mode: "configured" as const,
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  legacyOwnerEmail: "owner@example.com",
  siteUrl: "https://zeus.example",
  allowedSignupEmails: [],
};

const SESSION_COOKIE = "sb-project-auth-token";

/**
 * @supabase/ssr 0.12.4 hands `setAll` these defaults with the client-level
 * `cookieOptions` merged over them — and then puts its own 400-day `maxAge` back on
 * top, which is why the lifetime has to be capped in the callback rather than declared
 * once on the client.
 */
const LIBRARY_COOKIE_DEFAULTS = {
  path: "/",
  sameSite: "lax",
  httpOnly: false,
  maxAge: 400 * 24 * 60 * 60,
};

type CookieAttributes = {
  path?: string;
  sameSite?: string;
  httpOnly?: boolean;
  secure?: boolean;
  maxAge?: number;
};

type ServerClientOptions = {
  cookieOptions?: CookieAttributes;
  global?: { fetch?: typeof fetch };
  cookies: {
    getAll: () => { name: string; value: string }[];
    setAll: (
      cookies: { name: string; value: string; options: CookieAttributes }[],
      headers: Record<string, string>,
    ) => void;
  };
};

let clientOptions: ServerClientOptions | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  clientOptions = null;
  mocks.getAuthConfiguration.mockReturnValue(CONFIGURED);
  mocks.getClaims.mockResolvedValue({
    data: { claims: null },
    error: new Error("signed out"),
  });
  mocks.createServerClient.mockImplementation(
    (_url: string, _key: string, options: ServerClientOptions) => {
      clientOptions = options;
      return { auth: { getClaims: mocks.getClaims } };
    },
  );
});

describe("health check reachability", () => {
  it("reaches the route while signed out, unlike every other API path", async () => {
    const health = await proxy(
      new NextRequest("https://zeus.example/api/health", {
        headers: { host: "zeus.example" },
      }),
    );
    const other = await proxy(
      new NextRequest("https://zeus.example/api/work-plans", {
        headers: { host: "zeus.example" },
      }),
    );

    expect(health.headers.get("x-middleware-next")).toBe("1");
    expect(other.status).toBe(401);
    // Only the private API request consults Supabase. Deployment readiness must not
    // inherit the latency or availability of an external authentication service.
    expect(mocks.createServerClient).toHaveBeenCalledTimes(1);
    expect(mocks.getClaims).toHaveBeenCalledTimes(1);
  });

  it("reaches the route while auth itself is misconfigured", async () => {
    mocks.getAuthConfiguration.mockReturnValue({
      mode: "misconfigured",
      message: "Supabase login needs a project URL",
    });

    const health = await proxy(
      new NextRequest("https://zeus.example/api/health", {
        headers: { host: "zeus.example" },
      }),
    );
    const other = await proxy(
      new NextRequest("https://zeus.example/api/work-plans", {
        headers: { host: "zeus.example" },
      }),
    );

    // The state most worth reporting is the one where the door is broken.
    expect(health.headers.get("x-middleware-next")).toBe("1");
    expect(other.status).toBe(503);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });
});

describe("browser response hardening", () => {
  it("hardens a successful configured-mode response, not just the local one", async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: "owner" } }, error: null });

    const response = await proxy(
      new NextRequest("https://zeus.example/today", {
        headers: { host: "zeus.example", "sec-fetch-site": "none" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("hardens a signed-out redirect and an unauthenticated API rejection", async () => {
    const redirect = await proxy(
      new NextRequest("https://zeus.example/today", {
        headers: { host: "zeus.example", "sec-fetch-site": "none" },
      }),
    );
    const api = await proxy(
      new NextRequest("https://zeus.example/api/work-plans", {
        headers: { host: "zeus.example", "sec-fetch-site": "none" },
      }),
    );

    expect(redirect.status).toBe(307);
    expect(api.status).toBe(401);
    for (const response of [redirect, api]) {
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("omits HSTS for a plaintext local origin", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });

    const response = await proxy(
      new NextRequest("http://127.0.0.1:3000/today", {
        headers: { host: "127.0.0.1:3000", "sec-fetch-site": "none" },
      }),
    );

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("local proxy boundary", () => {
  it("rejects DNS-rebinding hosts before a private page is rendered", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });
    const response = await proxy(
      new NextRequest("http://attacker.example/today", {
        headers: { host: "attacker.example", "sec-fetch-site": "none" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("allows direct loopback navigation with private response hardening", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });
    const response = await proxy(
      new NextRequest("http://127.0.0.1:3000/today", {
        headers: {
          host: "127.0.0.1:3000",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("requires exact Origin before an unsafe local request proceeds", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });
    const missing = await proxy(localPost());
    const crossOrigin = await proxy(localPost("https://attacker.example"));
    const sameOrigin = await proxy(localPost("http://127.0.0.1:3000"));

    expect(missing.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("configured proxy mutation boundary", () => {
  it("rejects a cross-origin server action before session handling", async () => {
    const response = await proxy(
      new NextRequest("https://zeus.example/settings", {
        method: "POST",
        headers: {
          host: "zeus.example",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("allows an exact public-origin Server Action behind Railway's internal URL", async () => {
    const response = await proxy(
      new NextRequest("http://zeus.railway.internal/auth/signup", {
        method: "POST",
        headers: {
          origin: "https://zeus.example",
          referer: "https://zeus.example/auth/signup",
          "sec-fetch-site": "same-origin",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("configured proxy API boundary", () => {
  it("keeps signed-out chat behind the account boundary", async () => {
    const response = await proxy(request("/api/chat"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
  });

  it("keeps other signed-out APIs private", async () => {
    const response = await proxy(request("/api/follow-through"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Authentication required." });
  });

  it("fails every API closed under an incomplete auth configuration", async () => {
    mocks.getAuthConfiguration.mockReturnValue({
      mode: "misconfigured",
      message: "Supabase login configuration is incomplete.",
    });

    const chatResponse = await proxy(request("/api/chat"));
    const privateResponse = await proxy(request("/api/follow-through"));

    expect(chatResponse.status).toBe(503);
    expect(privateResponse.status).toBe(503);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it("fails chat closed when account verification is unavailable", async () => {
    mocks.getClaims.mockRejectedValue(new Error("network unavailable"));

    const response = await proxy(request("/api/chat"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Account verification is temporarily unavailable.",
    });
  });
});

describe("session cookie hardening", () => {
  it("writes the refreshed session as HttpOnly, Secure, and short-lived", async () => {
    refreshSessionCookieOnClaims();

    const response = await proxy(
      new NextRequest("https://zeus.example/today", {
        headers: { host: "zeus.example", "sec-fetch-site": "none" },
      }),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain(`${SESSION_COOKIE}=refreshed`);
    // Nothing in Zeus reads the session from JavaScript, so an XSS must not be able to
    // either, and a cookie lifted from the wire must not outlive the month.
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(clientOptions?.cookieOptions).toMatchObject({ httpOnly: true, secure: true });
  });

  it("omits Secure for a plaintext loopback origin so local login still works", async () => {
    mocks.getAuthConfiguration.mockReturnValue({
      ...CONFIGURED,
      siteUrl: "http://127.0.0.1:3000",
    });
    refreshSessionCookieOnClaims();

    const response = await proxy(
      new NextRequest("http://127.0.0.1:3000/today", {
        headers: { host: "127.0.0.1:3000", "sec-fetch-site": "none" },
      }),
    );
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Secure");
    expect(clientOptions?.cookieOptions).toMatchObject({ httpOnly: true, secure: false });
  });
});

describe("account verification deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aborts a hanging Supabase call and reports it as unavailable, not signed out", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let reached = () => {};
    const fetchReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        reached();
      });
    });
    mocks.getClaims.mockImplementation(async () => {
      const bounded = clientOptions?.global?.fetch;
      // Without a bounded fetch there is nothing to abort, and the hang is the bug.
      if (!bounded) return { data: { claims: { sub: "owner" } }, error: null };
      try {
        await bounded("https://project.supabase.co/auth/v1/user");
        return { data: { claims: { sub: "owner" } }, error: null };
      } catch {
        // auth-js converts every transport failure into this returned error rather
        // than a rejection.
        return {
          data: null,
          error: Object.assign(new Error("Failed to fetch"), {
            name: "AuthRetryableFetchError",
          }),
        };
      }
    });

    const pending = proxy(request("/api/chat"));
    await fetchReached;
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Account verification is temporarily unavailable.",
    });
    const deadlineMs = timeout.mock.calls[0]?.[0] ?? 0;
    expect(deadlineMs).toBeGreaterThan(0);
    expect(deadlineMs).toBeLessThanOrEqual(15_000);
  });
});

describe("auth outage visibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an unreachable auth service rather than only telling the visitor", async () => {
    const events = captureEvents();
    mocks.getClaims.mockResolvedValue({ data: null, error: transportFailure() });

    const response = await proxy(request("/api/chat"));

    expect(response.status).toBe(503);
    // The visitor-facing 503 reaches nobody who can fix it; this line is the one an
    // operator can alert on, and it names the failing dependency's own error class.
    expect(events().find((line) => line.event === "auth_unavailable")).toMatchObject({
      event: "auth_unavailable",
      outcome: "error",
      reason: "transport_failure",
      status: 503,
      method: "POST",
      route: "/api/chat",
      error_name: "AuthRetryableFetchError",
    });
  });

  it("separates a fault in the auth path from the auth service being down", async () => {
    const events = captureEvents();
    mocks.getClaims.mockRejectedValue(new TypeError("cannot read properties of undefined"));

    const response = await proxy(request("/api/chat"));

    expect(response.status).toBe(503);
    expect(events().find((line) => line.event === "auth_unavailable")).toMatchObject({
      reason: "unexpected_error",
      error_name: "TypeError",
    });
  });

  it("reports a still-served public page as degraded, not as a failure", async () => {
    const events = captureEvents();
    mocks.getClaims.mockResolvedValue({ data: null, error: transportFailure() });

    const response = await proxy(
      new NextRequest("https://zeus.example/", {
        headers: { host: "zeus.example", "sec-fetch-site": "none" },
      }),
    );

    // The visitor still gets the page, anonymously. Calling that an error next to a
    // refused API call would report one rate for two different experiences.
    expect(response.status).toBe(200);
    expect(events().find((line) => line.event === "auth_unavailable")).toMatchObject({
      outcome: "degraded",
      status: 200,
      route: "/",
    });
  });

  it("names the route template, never the path that resolved it", async () => {
    const events = captureEvents();
    mocks.getClaims.mockResolvedValue({ data: null, error: transportFailure() });

    const response = await proxy(
      new NextRequest("https://zeus.example/entity/jane-okafor?view=history", {
        headers: { host: "zeus.example", "sec-fetch-site": "none" },
      }),
    );

    expect(response.status).toBe(307);
    // An entity slug is `slugify(entity.name)` — a person out of the user's own memory,
    // in the path rather than the query, and a value the `route` pattern accepts without
    // complaint. The redirect still carries it, because the visitor asked for it; the log
    // must carry only the shape.
    expect(response.headers.get("location")).toContain("jane-okafor");
    const serialized = JSON.stringify(events());
    expect(serialized).not.toContain("jane");
    expect(serialized).not.toContain("okafor");
    expect(serialized).not.toContain("history");
    expect(events().find((line) => line.event === "auth_unavailable")).toMatchObject({
      outcome: "error",
      status: 307,
      route: "/entity/[slug]",
    });
  });

  it("separates a Supabase server error from never having reached it", async () => {
    const events = captureEvents();
    mocks.getClaims.mockResolvedValue({ data: null, error: transportFailure(503) });

    expect((await proxy(request("/api/chat"))).status).toBe(503);
    // One class, no code, and a stack inside a dependency: without this the two are the
    // same line, and they are repaired by different people.
    expect(events().find((line) => line.event === "auth_unavailable")).toMatchObject({
      reason: "upstream_5xx",
      error_name: "AuthRetryableFetchError",
    });
  });

  it("reports the outage once even when the write to stderr fails", async () => {
    mocks.getClaims.mockResolvedValue({ data: null, error: transportFailure() });
    let attempts = 0;
    vi.spyOn(console, "error").mockImplementation(() => {
      attempts += 1;
      throw new Error("stderr is gone");
    });

    await expect(proxy(request("/api/chat"))).rejects.toThrow("stderr is gone");
    // The reporting sits outside the handler it reports on. Inside it, a failed write
    // would be caught by that handler, which would run the failure path a second time
    // and file the outage under the logger's own error instead of Supabase's.
    expect(attempts).toBe(1);
  });

  it("stays silent for an ordinary signed-out request", async () => {
    const events = captureEvents();

    for (const path of ["/api/chat", "/api/follow-through"]) {
      expect((await proxy(request(path))).status).toBe(401);
    }

    // A logged-out caller is the ordinary state of a working deployment. One line per
    // request here would be the loudest thing in the log and the least actionable.
    expect(events()).toEqual([]);
  });

  it("attributes no account to an origin refusal, having verified none", async () => {
    const events = captureEvents();

    const response = await proxy(
      new NextRequest("https://zeus.example/settings", {
        method: "POST",
        headers: {
          host: "zeus.example",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(events()).toEqual([
      {
        event: "http_denied",
        outcome: "error",
        reason: "forbidden_origin",
        status: 403,
        method: "POST",
        route: "/settings",
      },
    ]);
  });

  it("keeps a private page's path out of a 403 as well as out of an outage", async () => {
    const events = captureEvents();

    const response = await proxy(hostilePost("/entity/jane-okafor"));

    expect(response.status).toBe(403);
    // The older of the two call sites, and the same exposure: a denial names the route
    // shape, and the name in the path it was asked for stays out of the file.
    expect(events()).toEqual([
      {
        event: "http_denied",
        outcome: "error",
        reason: "forbidden_origin",
        status: 403,
        method: "POST",
        route: "/entity/[slug]",
      },
    ]);
  });

  it("collapses a path this deployment does not serve into one fixed token", async () => {
    const events = captureEvents();

    const response = await proxy(hostilePost("/jane-okafor/notes"));

    expect(response.status).toBe(403);
    // The vocabulary is closed, so an unrecognised path reports its absence rather than
    // itself. A route added to `src/app/` without being listed lands here too — the
    // failure mode is a less specific line, never a leaked one.
    expect(events()[0]).toMatchObject({ route: "/unmatched" });
    expect(JSON.stringify(events())).not.toContain("okafor");
  });
});

/**
 * What auth-js returns for a timeout, a refused connection, or a Supabase 5xx: one class
 * for all three, with the status it attached the only thing telling them apart.
 */
function transportFailure(status = 0): Error {
  return Object.assign(new Error("Failed to fetch"), {
    name: "AuthRetryableFetchError",
    status,
  });
}

/** A cross-site POST, which the mutation boundary refuses before any identity exists. */
function hostilePost(path: string): NextRequest {
  return new NextRequest(`https://zeus.example${path}`, {
    method: "POST",
    headers: {
      host: "zeus.example",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
}

/**
 * Read back the lines the proxy actually wrote. Asserting on the serialized JSON rather
 * than on the call arguments is the point: the allowlist runs during serialization, so
 * only the written line proves what an operator would receive.
 */
function captureEvents(): () => Record<string, unknown>[] {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  return () =>
    stderr.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

/**
 * Stand in for a token refresh: the library writes cookies through `setAll` in the
 * middle of the auth call, while the proxy still owns the response.
 */
function refreshSessionCookieOnClaims(): void {
  mocks.getClaims.mockImplementation(async () => {
    clientOptions?.cookies.setAll(
      [
        {
          name: SESSION_COOKIE,
          value: "refreshed",
          options: {
            ...LIBRARY_COOKIE_DEFAULTS,
            ...clientOptions.cookieOptions,
            maxAge: LIBRARY_COOKIE_DEFAULTS.maxAge,
          },
        },
      ],
      {},
    );
    return { data: { claims: { sub: "owner" } }, error: null };
  });
}

function localPost(origin?: string): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/chat", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
      ...(origin ? { origin } : {}),
    },
  });
}

function request(path: string): NextRequest {
  return new NextRequest(`https://zeus.example${path}`, {
    method: "POST",
    headers: {
      host: "zeus.example",
      origin: "https://zeus.example",
      "sec-fetch-site": "same-origin",
    },
  });
}

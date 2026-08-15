import type { User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openTestDb, type Db } from "@/core/db";
import { getAppOwner } from "@/core/owner";

const mocks = vi.hoisted(() => ({
  accountDbExists: vi.fn(),
  getAccountDb: vi.fn(),
  getDb: vi.fn(),
  cookies: vi.fn(),
  createServerClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("@/server/db", () => ({
  accountDbExists: mocks.accountDbExists,
  getAccountDb: mocks.getAccountDb,
  getDb: mocks.getDb,
}));
vi.mock("@/server/auth/supabase", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import {
  authorizeSupabaseUser,
  getBrowserOwnerAccess,
  getOwnerAccess,
} from "./access";
import { getAuthConfiguration } from "./config";
import { safeNextPath } from "./paths";

const OWNER_ID = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const OTHER_ID = "12f81434-e99b-4208-a1a2-0a216579e393";
const THIRD_ID = "4bd0a8a6-1c47-4a2e-9a3f-6f2f1f0c5e77";
/**
 * A clock the rate-limited refusals can be walked across rather than waited out. It starts
 * beyond real time so that no window an earlier test opened is still open.
 */
let clock = Date.now() + 24 * 60 * 60 * 1000;
const AUTH_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "ZEUS_OWNER_EMAIL",
  "ZEUS_ALLOWED_SIGNUP_EMAILS",
] as const;

let db: Db;
let otherDb: Db;
const savedEnvironment = Object.fromEntries(
  AUTH_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof AUTH_KEYS)[number], string | undefined>;

beforeEach(() => {
  AUTH_KEYS.forEach((key) => delete process.env[key]);
  db = openTestDb();
  otherDb = openTestDb();
  mocks.getDb.mockReturnValue(db);
  // Existing tests describe accounts that already have a store; the signup allowlist
  // gates only first-time store creation and is exercised separately below.
  mocks.accountDbExists.mockReturnValue(true);
  mocks.getAccountDb.mockImplementation(
    ({ supabaseUserId }: { supabaseUserId: string }) =>
      supabaseUserId === OWNER_ID ? db : otherDb,
  );
});

afterEach(() => {
  AUTH_KEYS.forEach((key) => {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  vi.clearAllMocks();
});

describe("auth configuration", () => {
  it("keeps the original local mode only when the whole auth group is absent", () => {
    expect(getAuthConfiguration()).toEqual({ mode: "local" });

    process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:3000";
    expect(getAuthConfiguration()).toEqual({ mode: "local" });

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    expect(getAuthConfiguration()).toMatchObject({ mode: "misconfigured" });
  });

  it("accepts a complete publishable-key configuration", () => {
    configureAuth();

    expect(getAuthConfiguration()).toEqual({
      mode: "configured",
      url: "https://project.supabase.co",
      publishableKey: "sb_publishable_test",
      siteUrl: "http://127.0.0.1:3000",
      legacyOwnerEmail: "owner@example.com",
      allowedSignupEmails: [],
    });
  });

  it("does not require a legacy owner email for a new multi-account install", () => {
    configureAuth();
    delete process.env.ZEUS_OWNER_EMAIL;

    expect(getAuthConfiguration()).toMatchObject({
      mode: "configured",
      legacyOwnerEmail: null,
    });
  });

  it.each([
    "https://user:password@zeus.example/",
    "https://zeus.example/?tenant=owner",
    "https://zeus.example/#account",
    "https://zeus.example/app",
  ])("rejects a site URL that is not an exact HTTP origin: %s", (siteUrl) => {
    configureAuth();
    process.env.NEXT_PUBLIC_SITE_URL = siteUrl;

    expect(getAuthConfiguration()).toMatchObject({ mode: "misconfigured" });
  });
});

describe("owner authorization", () => {
  beforeEach(configureAuth);

  it("binds every verified account to its selected isolated store", () => {
    const unverified = authorizeSupabaseUser(user(OWNER_ID, "owner@example.com", false));
    expect(unverified).toMatchObject({ state: "wrong_account", canAccessPrivateData: false });
    expect(getAppOwner(db)).toBeNull();
    expect(mocks.getAccountDb).not.toHaveBeenCalled();

    const owner = authorizeSupabaseUser(user(OWNER_ID, "owner@example.com"));
    const other = authorizeSupabaseUser(user(OTHER_ID, "other@example.com"));
    expect(owner).toMatchObject({ state: "authorized", canAccessPrivateData: true });
    expect(other).toMatchObject({ state: "authorized", canAccessPrivateData: true });
    expect(getAppOwner(db)?.supabase_user_id).toBe(OWNER_ID);
    expect(getAppOwner(otherDb)?.supabase_user_id).toBe(OTHER_ID);
  });

  it("uses the immutable UUID within each account store even if email changes", () => {
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe("authorized");

    expect(authorizeSupabaseUser(user(OWNER_ID, "changed@example.com")).state).toBe("authorized");
    expect(authorizeSupabaseUser(user(OTHER_ID, "owner@example.com")).state).toBe("authorized");
    expect(getAppOwner(db)?.supabase_user_id).toBe(OWNER_ID);
    expect(getAppOwner(otherDb)?.supabase_user_id).toBe(OTHER_ID);
  });
});

describe("signup allowlist", () => {
  beforeEach(configureAuth);

  it("refuses to allocate a new store for an uninvited email", () => {
    mocks.accountDbExists.mockReturnValue(false);

    const access = authorizeSupabaseUser(user(OTHER_ID, "stranger@example.com"));

    expect(access).toMatchObject({ state: "wrong_account", canAccessPrivateData: false });
    // The allocation itself must not happen: no database, no migration, no connection.
    expect(mocks.getAccountDb).not.toHaveBeenCalled();
    expect(getAppOwner(otherDb)).toBeNull();
  });

  it("allocates a new store for an allowlisted email, ignoring case and spacing", () => {
    mocks.accountDbExists.mockReturnValue(false);
    process.env.ZEUS_ALLOWED_SIGNUP_EMAILS = " Other@Example.com , spare@example.com ";

    expect(authorizeSupabaseUser(user(OTHER_ID, "other@example.com")).state).toBe(
      "authorized",
    );
    expect(getAppOwner(otherDb)?.supabase_user_id).toBe(OTHER_ID);
  });

  it("never locks out an account that already has a store", () => {
    mocks.accountDbExists.mockReturnValue(true);

    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe(
      "authorized",
    );
  });

  it("fails the configuration rather than silently narrowing a mistyped allowlist", () => {
    process.env.ZEUS_ALLOWED_SIGNUP_EMAILS = "good@example.com,not-an-email";

    expect(getAuthConfiguration()).toMatchObject({ mode: "misconfigured" });
  });
});

describe("auth downgrade protection", () => {
  it("keeps an unbound store available in intentional local mode", async () => {
    const access = await getOwnerAccess();

    expect(access).toMatchObject({ state: "local", canAccessPrivateData: true, db });
  });

  it("fails closed when auth configuration disappears after owner binding", async () => {
    configureAuth();
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe("authorized");
    expect(getAppOwner(db)?.supabase_user_id).toBe(OWNER_ID);

    AUTH_KEYS.forEach((key) => delete process.env[key]);
    const access = await getOwnerAccess();

    expect(access.canAccessPrivateData).toBe(false);
    expect(access.db).toBeNull();
  });
});

describe("browser access boundary", () => {
  it("rejects a hostile local browser origin before opening the owner store", async () => {
    const request = new Request("http://attacker.example/api/chat", {
      method: "POST",
      headers: {
        host: "attacker.example",
        origin: "http://attacker.example",
        "sec-fetch-site": "same-origin",
      },
    });

    const access = await getBrowserOwnerAccess(request, "private-mutation");

    expect(access).toMatchObject({
      state: "forbidden_origin",
      canAccessPrivateData: false,
      db: null,
    });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getAccountDb).not.toHaveBeenCalled();
  });

  it("preserves a fail-closed configuration error ahead of origin details", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SITE_URL = "not-an-origin";
    const access = await getBrowserOwnerAccess(
      new Request("http://attacker.example/api/chat", { method: "POST" }),
      "private-mutation",
    );

    expect(access).toMatchObject({
      state: "misconfigured",
      canAccessPrivateData: false,
      db: null,
    });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

describe("session client hardening", () => {
  const SESSION_COOKIE = "sb-project-auth-token";
  /**
   * @supabase/ssr 0.12.4 hands `setAll` these defaults with the client-level
   * `cookieOptions` merged over them — and then puts its own 400-day `maxAge` back on
   * top, which is why the lifetime has to be capped in the callback rather than
   * declared once on the client.
   */
  const LIBRARY_COOKIE_DEFAULTS = {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    maxAge: 400 * 24 * 60 * 60,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes an HttpOnly, Secure, month-long session cookie for an https origin", async () => {
    configureAuth();
    process.env.NEXT_PUBLIC_SITE_URL = "https://zeus.example";

    const { options, written } = await buildSessionClient();
    expect(options.cookieOptions).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });

    writeSessionCookie(options);

    // Nothing on the server needs a JavaScript-readable session, and a cookie lifted
    // from the wire must not outlive the month.
    expect(written[0]?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
    expect(written[0]?.options.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("leaves Secure off for a plaintext loopback origin so local login still works", async () => {
    configureAuth();

    const { options, written } = await buildSessionClient();
    writeSessionCookie(options);

    expect(options.cookieOptions).toMatchObject({ httpOnly: true, secure: false });
    expect(written[0]?.options).toMatchObject({ httpOnly: true, secure: false });
  });

  it("aborts a hanging Supabase call instead of holding the connection open", async () => {
    configureAuth();
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

    const { options } = await buildSessionClient();
    const bounded = options.global?.fetch;
    expect(bounded).toBeTypeOf("function");

    const pending = bounded?.("https://project.supabase.co/auth/v1/user");
    await fetchReached;
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    const deadlineMs = timeout.mock.calls[0]?.[0] ?? 0;
    expect(deadlineMs).toBeGreaterThan(0);
    expect(deadlineMs).toBeLessThanOrEqual(15_000);
  });

  it("reports a Supabase outage as unavailable, not as a signed-out account", async () => {
    configureAuth();
    const { client } = await buildSessionClient({
      getUser: async () => ({
        data: { user: null },
        // What auth-js returns for a timeout, a refused connection, or a 5xx.
        error: Object.assign(new Error("Failed to fetch"), {
          name: "AuthRetryableFetchError",
        }),
      }),
    });
    mocks.createSupabaseServerClient.mockResolvedValue(client);

    const access = await getOwnerAccess();

    expect(access).toMatchObject({
      state: "unavailable",
      canAccessPrivateData: false,
      db: null,
    });
  });

  it("still reports a genuinely missing session as signed out", async () => {
    configureAuth();
    const { client } = await buildSessionClient({
      getUser: async () => ({
        data: { user: null },
        error: Object.assign(new Error("Auth session missing!"), {
          name: "AuthSessionMissingError",
        }),
      }),
    });
    mocks.createSupabaseServerClient.mockResolvedValue(client);

    const access = await getOwnerAccess();

    expect(access).toMatchObject({ state: "signed_out", canAccessPrivateData: false });
  });

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

  /** Build the real client against a stubbed @supabase/ssr and cookie store. */
  async function buildSessionClient(auth: Record<string, unknown> = {}) {
    const written: { name: string; value: string; options: CookieAttributes }[] = [];
    mocks.cookies.mockResolvedValue({
      getAll: () => [],
      set: (name: string, value: string, options: CookieAttributes) => {
        written.push({ name, value, options });
      },
    });
    mocks.createServerClient.mockImplementation(() => ({
      auth: { getUser: async () => ({ data: { user: null }, error: null }), ...auth },
    }));

    const { createSupabaseServerClient } =
      await vi.importActual<typeof import("./supabase")>("./supabase");
    const client = await createSupabaseServerClient();
    const options = mocks.createServerClient.mock.calls.at(-1)?.[2] as ServerClientOptions;

    return { client, options, written };
  }

  /** Replay one library cookie write through the client's own `setAll`. */
  function writeSessionCookie(options: ServerClientOptions): void {
    options.cookies.setAll(
      [
        {
          name: SESSION_COOKIE,
          value: "session",
          options: {
            ...LIBRARY_COOKIE_DEFAULTS,
            ...options.cookieOptions,
            maxAge: LIBRARY_COOKIE_DEFAULTS.maxAge,
          },
        },
      ],
      {},
    );
  }
});

describe("auth boundary visibility", () => {
  beforeEach(() => {
    // The windows that bound a repeating refusal live in module state, which outlives a
    // single test. Starting each one an hour on leaves no window open behind it.
    clock += 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an unreachable auth service so an operator can alert on it", async () => {
    configureAuth();
    const events = captureEvents();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        // What `createSupabaseServerClient` rethrows for a timeout, a refused
        // connection, or a Supabase 5xx.
        getUser: async () => {
          throw Object.assign(new Error("Failed to fetch"), {
            name: "AuthRetryableFetchError",
          });
        },
      },
    });

    const access = await getOwnerAccess();

    expect(access.state).toBe("unavailable");
    // Every account is locked out of its own memory, and the sentence explaining that
    // reaches only the person who cannot fix it.
    expect(events()).toEqual([
      { event: "owner_access_denied", outcome: "error", reason: "unavailable", count: 1 },
    ]);
  });

  it("states a persisting condition once a window, with the refusals it stands for", async () => {
    configureAuth();
    const events = captureEvents();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: async () => {
          throw Object.assign(new Error("Failed to fetch"), {
            name: "AuthRetryableFetchError",
          });
        },
      },
    });

    // Two page renders' worth: the dynamic root layout asks, then the page asks again.
    for (let render = 0; render < 8; render += 1) {
      expect((await getOwnerAccess()).state).toBe("unavailable");
    }
    expect(events()).toHaveLength(1);

    clock += 6 * 60 * 1000;
    expect((await getOwnerAccess()).state).toBe("unavailable");

    // An outage is a condition, not an event. The operator needs to know it started and
    // roughly how hard it is being hit — not to receive it once per render until it ends.
    expect(events()).toEqual([
      { event: "owner_access_denied", outcome: "error", reason: "unavailable", count: 1 },
      { event: "owner_access_denied", outcome: "error", reason: "unavailable", count: 8 },
    ]);
  });

  it("separates a boundary being tested from a confirmation link nobody clicked", () => {
    configureAuth();
    const events = captureEvents();

    // The visitor is told to confirm their address, and nothing reached a store it was
    // not entitled to.
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com", false)).state).toBe(
      "wrong_account",
    );
    expect(events()).toEqual([]);

    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe("authorized");
    mocks.getAccountDb.mockReturnValue(db);

    // A store bound to one identity, reached by another. Recorded with the account that
    // reached it, because "somebody" is not a thing an operator can investigate.
    expect(authorizeSupabaseUser(user(OTHER_ID, "stranger@example.com")).state).toBe(
      "wrong_account",
    );
    expect(events()).toEqual([
      {
        event: "owner_access_denied",
        outcome: "error",
        reason: "wrong_account",
        account: OTHER_ID,
      },
    ]);
  });

  it("reports every store reached by an identity it is not bound to, not one a window", () => {
    configureAuth();
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe("authorized");
    const events = captureEvents();
    mocks.getAccountDb.mockReturnValue(db);

    expect(authorizeSupabaseUser(user(OTHER_ID, "stranger@example.com")).state).toBe(
      "wrong_account",
    );
    expect(authorizeSupabaseUser(user(THIRD_ID, "other-stranger@example.com")).state).toBe(
      "wrong_account",
    );

    // A window keeps the first caller and drops the rest. For the one refusal here that
    // means a boundary was tested, the account is what the line is for.
    expect(events().map((line) => line.account)).toEqual([OTHER_ID, THIRD_ID]);
  });

  it("records a stranger asking an invite-only deployment for a store", () => {
    configureAuth();
    const events = captureEvents();
    mocks.accountDbExists.mockReturnValue(false);

    expect(authorizeSupabaseUser(user(OTHER_ID, "stranger@example.com")).state).toBe(
      "wrong_account",
    );

    // On an allowlisted deployment this is the only state a stranger can reach: with no
    // store, the identity never gets as far as `wrong_account`. Silence here would mean a
    // deployment whose whole door is the allowlist reports nobody trying it.
    expect(events()).toEqual([
      {
        event: "owner_access_denied",
        outcome: "error",
        reason: "not_invited",
        count: 1,
        account: OTHER_ID,
      },
    ]);

    // The signup page is public, so the rate belongs to whoever is signing up.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      authorizeSupabaseUser(user(OTHER_ID, "stranger@example.com"));
    }
    expect(events()).toHaveLength(1);
  });

  it("distinguishes a provider that supplies no address from an unconfirmed one", () => {
    configureAuth();
    const events = captureEvents();

    const withoutEmail = { ...user(OTHER_ID, "stranger@example.com"), email: undefined } as User;
    expect(authorizeSupabaseUser(withoutEmail).state).toBe("wrong_account");
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com", false)).state).toBe(
      "wrong_account",
    );

    // "Confirm your email" is not advice anyone can act on when the provider never sends
    // one; only whoever configured it can. The two refusals cannot share a reason.
    expect(events()).toEqual([
      {
        event: "owner_access_denied",
        outcome: "error",
        reason: "missing_provider_email",
        count: 1,
        account: OTHER_ID,
      },
    ]);
  });

  it("records a private request refused at the browser origin boundary", async () => {
    const events = captureEvents();

    const access = await getBrowserOwnerAccess(
      new Request("http://attacker.example/api/chat", {
        method: "POST",
        headers: {
          host: "attacker.example",
          origin: "http://attacker.example",
          "sec-fetch-site": "same-origin",
        },
      }),
      "private-mutation",
    );

    expect(access.state).toBe("forbidden_origin");
    expect(events()).toEqual([
      { event: "owner_access_denied", outcome: "error", reason: "forbidden_origin" },
    ]);
  });

  it("stays silent through a signed-out visitor's whole session", async () => {
    configureAuth();
    const events = captureEvents();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: null },
          error: Object.assign(new Error("Auth session missing!"), {
            name: "AuthSessionMissingError",
          }),
        }),
      },
    });

    // One line per page render and per API request would be the loudest thing in the
    // log and the one nobody can act on; "log in" is already the whole resolution.
    for (let request = 0; request < 5; request += 1) {
      expect((await getOwnerAccess()).state).toBe("signed_out");
    }
    expect(events()).toEqual([]);
  });

  it("never lets an email or a display name reach a written line", () => {
    configureAuth();
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe("authorized");
    const events = captureEvents();
    mocks.getAccountDb.mockReturnValue(db);

    const intruder = {
      ...user(OTHER_ID, "jane.okafor@example.com"),
      user_metadata: {
        full_name: "Jane Okafor",
        avatar_url: "https://cdn.example/jane-okafor.png",
      },
    } as User;
    expect(authorizeSupabaseUser(intruder).state).toBe("wrong_account");

    // The denial carries an `AccountSummary`, which names the person three ways. Only
    // the pseudonymous UUID may be written, and the check is on the written line rather
    // than on what the call site passed.
    const serialized = JSON.stringify(events());
    expect(serialized).not.toContain("jane.okafor@example.com");
    expect(serialized).not.toContain("Jane Okafor");
    expect(serialized).not.toContain("cdn.example");
    expect(serialized).toContain(OTHER_ID);
  });
});

describe("auth redirects", () => {
  it("keeps local relative destinations and rejects open redirects", () => {
    expect(safeNextPath("/memory?view=review")).toBe("/memory?view=review");
    expect(safeNextPath("https://attacker.example/path")).toBe("/");
    expect(safeNextPath("//attacker.example/path")).toBe("/");
    expect(safeNextPath("/\\\\attacker.example/path")).toBe("/");
    expect(safeNextPath("/%5C%5Cattacker.example/path")).toBe("/");
    expect(safeNextPath("/%2F%2Fattacker.example/path")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
  });
});

/**
 * Read back the lines the boundary actually wrote. Asserting on the serialized JSON
 * rather than on the call arguments is the point: the allowlist runs during
 * serialization, so only the written line proves what an operator would receive.
 */
function captureEvents(): () => Record<string, unknown>[] {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  return () =>
    stderr.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

function configureAuth() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:3000";
  process.env.ZEUS_OWNER_EMAIL = " Owner@Example.com ";
}

function user(id: string, email: string, verified = true): User {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: verified ? "2026-08-12T00:00:00.000Z" : undefined,
    phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    created_at: "2026-08-12T00:00:00.000Z",
  } as User;
}

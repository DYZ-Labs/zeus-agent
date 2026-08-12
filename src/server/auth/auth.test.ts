import {
  AuthApiError,
  AuthSessionMissingError,
  type User,
} from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openTestDb, type Db } from "@/core/db";
import { getAppOwner } from "@/core/owner";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/auth/supabase", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import {
  authorizeSupabaseUser,
  getBrowserOwnerAccess,
  getOwnerAccess,
  verifyStoreFreeChatAccess,
} from "./access";
import { getAuthConfiguration } from "./config";
import { safeNextPath } from "./paths";

const OWNER_ID = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const OTHER_ID = "12f81434-e99b-4208-a1a2-0a216579e393";
const AUTH_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "ZEUS_OWNER_EMAIL",
] as const;

let db: Db;
const savedEnvironment = Object.fromEntries(
  AUTH_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof AUTH_KEYS)[number], string | undefined>;

beforeEach(() => {
  AUTH_KEYS.forEach((key) => delete process.env[key]);
  db = openTestDb();
  mocks.getDb.mockReturnValue(db);
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
      ownerEmail: "owner@example.com",
      siteUrl: "http://127.0.0.1:3000",
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

  it("binds only the configured, verified owner email", () => {
    const wrong = authorizeSupabaseUser(user(OTHER_ID, "other@example.com"));
    expect(wrong).toMatchObject({ state: "wrong_account", canAccessPrivateData: false });
    expect(wrong.message).not.toContain("owner@example.com");
    expect(getAppOwner(db)).toBeNull();

    const unverified = authorizeSupabaseUser(user(OWNER_ID, "owner@example.com", false));
    expect(unverified).toMatchObject({ state: "wrong_account", canAccessPrivateData: false });
    expect(unverified.message).not.toContain("owner@example.com");
    expect(getAppOwner(db)).toBeNull();

    const owner = authorizeSupabaseUser(user(OWNER_ID, "owner@example.com"));
    expect(owner).toMatchObject({ state: "authorized", canAccessPrivateData: true });
    expect(getAppOwner(db)?.supabase_user_id).toBe(OWNER_ID);
  });

  it("uses the immutable UUID after binding and never admits another account", () => {
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe("authorized");

    expect(authorizeSupabaseUser(user(OWNER_ID, "changed@example.com")).state).toBe("authorized");
    expect(authorizeSupabaseUser(user(OTHER_ID, "owner@example.com")).state).toBe("wrong_account");
    expect(getAppOwner(db)?.supabase_user_id).toBe(OWNER_ID);
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

  it("reports only an explicit missing session as signed out", async () => {
    configureAuth();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: new AuthSessionMissingError(),
        }),
      },
    });

    const access = await getOwnerAccess();

    expect(access).toMatchObject({ state: "signed_out", canAccessPrivateData: false });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("keeps private memory locked when session verification fails", async () => {
    configureAuth();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: new AuthApiError("verification failed", 503, "unexpected_failure"),
        }),
      },
    });

    const access = await getOwnerAccess();

    expect(access).toMatchObject({ state: "unavailable", canAccessPrivateData: false });
    expect(mocks.getDb).not.toHaveBeenCalled();
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

  it("authorizes local temporary chat without opening the owner store", async () => {
    const access = await verifyStoreFreeChatAccess(
      new Request("http://127.0.0.1:3000/api/chat", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
        },
      }),
    );

    expect(access).toEqual({ allowed: true, state: "local" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("verifies a configured temporary-chat owner without creating a binding", async () => {
    configureAuth();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: user(OWNER_ID, "owner@example.com") }, error: null }) },
    });
    const access = await verifyStoreFreeChatAccess(
      new Request("http://127.0.0.1:3000/api/chat", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
        },
      }),
    );

    expect(access).toEqual({ allowed: true, state: "authorized" });
    expect(mocks.getDb).toHaveBeenCalledOnce();
    expect(getAppOwner(db)).toBeNull();
  });

  it("authorizes a genuine missing session as store-free guest chat", async () => {
    configureAuth();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: new AuthSessionMissingError(),
        }),
      },
    });

    const access = await verifyStoreFreeChatAccess(browserChatRequest());

    expect(access).toEqual({ allowed: true, state: "signed_out" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("fails closed on session verification errors without opening the store", async () => {
    configureAuth();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: new AuthApiError("verification failed", 503, "unexpected_failure"),
        }),
      },
    });

    const access = await verifyStoreFreeChatAccess(browserChatRequest());

    expect(access).toMatchObject({ allowed: false, state: "unavailable" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("does not interpret an unexplained null user as a signed-out guest", async () => {
    configureAuth();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      },
    });

    const access = await verifyStoreFreeChatAccess(browserChatRequest());

    expect(access).toMatchObject({ allowed: false, state: "unavailable" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("blocks an authenticated non-owner without changing the owner binding", async () => {
    configureAuth();
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe(
      "authorized",
    );
    mocks.getDb.mockClear();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: user(OTHER_ID, "other@example.com") },
          error: null,
        }),
      },
    });

    const access = await verifyStoreFreeChatAccess(browserChatRequest());

    expect(access).toMatchObject({ allowed: false, state: "wrong_account" });
    expect(mocks.getDb).toHaveBeenCalledOnce();
    expect(getAppOwner(db)?.supabase_user_id).toBe(OWNER_ID);
  });

  it("preserves temporary chat for the UUID-bound owner after an email change", async () => {
    configureAuth();
    expect(authorizeSupabaseUser(user(OWNER_ID, "owner@example.com")).state).toBe(
      "authorized",
    );
    mocks.getDb.mockClear();
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: user(OWNER_ID, "changed@example.com") },
          error: null,
        }),
      },
    });

    const access = await verifyStoreFreeChatAccess(browserChatRequest());

    expect(access).toEqual({ allowed: true, state: "authorized" });
    expect(mocks.getDb).toHaveBeenCalledOnce();
  });

  it("rejects a hostile guest origin before checking its session or store", async () => {
    configureAuth();
    const access = await verifyStoreFreeChatAccess(
      new Request("http://attacker.example/api/chat", {
        method: "POST",
        headers: {
          host: "attacker.example",
          origin: "http://attacker.example",
          "sec-fetch-site": "same-origin",
        },
      }),
    );

    expect(access).toMatchObject({ allowed: false, state: "forbidden_origin" });
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
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

function configureAuth() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:3000";
  process.env.ZEUS_OWNER_EMAIL = " Owner@Example.com ";
}

function browserChatRequest(): Request {
  return new Request("http://127.0.0.1:3000/api/chat", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
    },
  });
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

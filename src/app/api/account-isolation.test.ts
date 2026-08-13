import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The request path, end to end.
 *
 * Every other route test substitutes `getBrowserOwnerAccess` — the exact boundary those
 * tests exist to protect — so a regression in the access layer, the Proxy matcher, or
 * account-database routing would pass with the unit tests still green. Here the Proxy,
 * the route handlers, the access layer, the signup gate, the account routing, and real
 * on-disk SQLite stores all run for real.
 *
 * Only two things are stubbed, and both are genuinely external: Supabase, which is a
 * network identity provider, and `next/headers`, which is the framework's per-request
 * context. Everything Zeus decides for itself is exercised.
 */

const supabase = vi.hoisted(() => ({
  /** The identity the stubbed provider will report, or null for signed out. */
  user: null as null | Record<string, unknown>,
  createServerClient: vi.fn(),
}));

const requestCookies = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => {
    supabase.createServerClient(...args);
    return {
      auth: {
        getUser: async () =>
          supabase.user
            ? { data: { user: supabase.user }, error: null }
            : { data: { user: null }, error: new Error("signed out") },
        getClaims: async () =>
          supabase.user
            ? { data: { claims: { sub: supabase.user.id } }, error: null }
            : { data: { claims: null }, error: new Error("signed out") },
      },
    };
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () =>
      [...requestCookies.store].map(([name, value]) => ({ name, value })),
    get: (name: string) =>
      requestCookies.store.has(name)
        ? { name, value: requestCookies.store.get(name)! }
        : undefined,
    set: (name: string | { name: string; value: string }, value?: string) => {
      if (typeof name === "string") requestCookies.store.set(name, value ?? "");
      else requestCookies.store.set(name.name, name.value);
    },
  }),
}));

import { appendMessage, createConversation } from "@/core/conversations";
import type { Db } from "@/core/db";
import { createWorkPlan } from "@/core/work-plans";
import { proxy } from "@/proxy";
import { getAccountDb } from "@/server/db";

import { DELETE as deleteWorkPlan, GET as getWorkPlan } from "./work-plans/[id]/route";
import { GET as listWorkPlans } from "./work-plans/route";

const OWNER = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const OTHER = "12f81434-e99b-4208-a1a2-0a216579e393";
const STRANGER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SITE = "https://zeus.example";

const temporaryDirectories: string[] = [];
let storeRoot: string;

type GlobalStores = {
  zeusDb?: Db;
  zeusLatestMigrationId?: string;
  zeusAccountDbs?: Map<string, { db: Db }>;
};

function resetOpenStores(): void {
  const globals = globalThis as unknown as GlobalStores;
  globals.zeusDb?.close();
  for (const cached of globals.zeusAccountDbs?.values() ?? []) cached.db.close();
  delete globals.zeusDb;
  delete globals.zeusLatestMigrationId;
  delete globals.zeusAccountDbs;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetOpenStores();
  requestCookies.store.clear();
  supabase.user = null;
  supabase.createServerClient.mockClear();

  storeRoot = mkdtempSync(join(tmpdir(), "zeus-isolation-"));
  temporaryDirectories.push(storeRoot);
  vi.stubEnv("ZEUS_DB", join(storeRoot, "zeus.db"));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("ZEUS_ALLOWED_SIGNUP_EMAILS", "owner@example.com,other@example.com");
  vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "off");
});

afterEach(() => {
  resetOpenStores();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function signIn(id: string, email: string): void {
  supabase.user = {
    id,
    email,
    email_confirmed_at: "2026-01-01T00:00:00.000Z",
    aud: "authenticated",
    role: "authenticated",
    created_at: "2026-01-01T00:00:00.000Z",
    app_metadata: { provider: "email" },
    user_metadata: {},
    identities: [],
  };
}

function browserRequest(path: string, method = "GET", origin = SITE): NextRequest {
  return new NextRequest(`${SITE}${path}`, {
    method,
    headers: {
      host: "zeus.example",
      origin,
      referer: `${SITE}${path}`,
      "sec-fetch-site": "same-origin",
    },
  });
}

/** The real pipeline: Proxy first, and the route only if Proxy let the request past. */
async function through(
  request: NextRequest,
  handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>,
  id = "0",
): Promise<Response> {
  const gate = await proxy(request);
  if (gate.headers.get("x-middleware-next") !== "1") return gate;
  return handler(request, { params: Promise.resolve({ id }) });
}

/** A plan written straight into a store, so the read path is what is under test. */
function seedPlan(db: Db, objective: string): number {
  const conversation = createConversation(db);
  const source = appendMessage(db, conversation.id, "user", objective);
  return createWorkPlan(db, {
    proposal: {
      objective,
      steps: [
        {
          title: "Recall accepted context",
          instruction: "Recall only accepted memory relevant to the decision.",
          effect_kind: "memory_read",
          depends_on: [],
        },
      ],
      allowed_effects: ["memory_read"],
      completion_criteria: ["A reviewable draft exists"],
      limits: {
        max_model_tool_calls: 4,
        max_retries_per_step: 1,
        max_duration_seconds: 300,
      },
    },
    sourceMessageId: source.id,
    origin: "explicit_request",
  }).plan.id;
}

function storeFor(id: string, email: string): Db {
  return getAccountDb({ supabaseUserId: id, email, legacyOwnerEmail: null });
}

describe("account isolation across the whole request path", () => {
  it("gives two accounts two different databases on disk", async () => {
    signIn(OWNER, "owner@example.com");
    await through(browserRequest("/api/work-plans"), (request) => listWorkPlans(request));
    signIn(OTHER, "other@example.com");
    await through(browserRequest("/api/work-plans"), (request) => listWorkPlans(request));

    // The first verified account claims the primary store; the second gets its own.
    expect(existsSync(join(storeRoot, "zeus.db"))).toBe(true);
    expect(existsSync(join(storeRoot, "accounts", `${OTHER}.db`))).toBe(true);
  });

  it("does not show one account another account's work", async () => {
    signIn(OWNER, "owner@example.com");
    const ownerPlan = seedPlan(storeFor(OWNER, "owner@example.com"), "Owner objective");

    const ownerView = await through(browserRequest("/api/work-plans"), (request) =>
      listWorkPlans(request),
    );
    signIn(OTHER, "other@example.com");
    const otherView = await through(browserRequest("/api/work-plans"), (request) =>
      listWorkPlans(request),
    );

    // Read each body once: a Response body cannot be consumed twice, and a second
    // .json() would throw into a swallowed catch and assert nothing.
    const ownerBody = await ownerView.json();
    const otherBody = await otherView.json();

    expect(ownerBody.plans).toHaveLength(1);
    expect(otherBody.plans).toEqual([]);
    // The single most important property of the multi-account design.
    expect(JSON.stringify(otherBody)).not.toContain("Owner objective");
    expect(ownerPlan).toBeGreaterThan(0);
  });

  it("refuses to read another account's plan by its exact id", async () => {
    signIn(OWNER, "owner@example.com");
    const ownerPlan = seedPlan(storeFor(OWNER, "owner@example.com"), "Owner objective");

    signIn(OTHER, "other@example.com");
    const response = await through(
      browserRequest(`/api/work-plans/${ownerPlan}`),
      (request, context) => getWorkPlan(request, context),
      String(ownerPlan),
    );

    // Guessing an id must not be enough: the id is looked up in the caller's own store.
    expect(response.status).toBe(404);
  });

  it("refuses to cancel another account's plan, and leaves it running", async () => {
    signIn(OWNER, "owner@example.com");
    const ownerStore = storeFor(OWNER, "owner@example.com");
    const ownerPlan = seedPlan(ownerStore, "Owner objective");

    signIn(OTHER, "other@example.com");
    const attack = await through(
      browserRequest(`/api/work-plans/${ownerPlan}`, "DELETE"),
      (request, context) => deleteWorkPlan(request, context),
      String(ownerPlan),
    );

    expect(attack.status).toBe(404);
    signIn(OWNER, "owner@example.com");
    const ownerView = await through(browserRequest("/api/work-plans"), (request) =>
      listWorkPlans(request),
    );
    const [plan] = (await ownerView.json()).plans as Array<{ status: string }>;
    expect(plan?.status).not.toBe("cancelled");
  });
});

describe("the door, exercised for real", () => {
  it("turns a signed-out API request away at the Proxy", async () => {
    const response = await through(browserRequest("/api/work-plans"), (request) =>
      listWorkPlans(request),
    );

    expect(response.status).toBe(401);
    // The route never ran, so nothing opened a store for an anonymous caller.
    expect(existsSync(join(storeRoot, "accounts"))).toBe(false);
  });

  it("lets the health check through while every private route stays closed", async () => {
    const health = await proxy(browserRequest("/api/health"));
    const priv = await proxy(browserRequest("/api/work-plans"));

    expect(health.headers.get("x-middleware-next")).toBe("1");
    expect(priv.status).toBe(401);
  });

  it("refuses a verified account that is not on the signup allowlist", async () => {
    signIn(STRANGER, "stranger@example.com");

    const response = await through(browserRequest("/api/work-plans"), (request) =>
      listWorkPlans(request),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/invite-only/u),
    });
    // The allocation itself must not happen: no database, no migration, no connection.
    expect(existsSync(join(storeRoot, "accounts", `${STRANGER}.db`))).toBe(false);
  });

  it("refuses a cross-origin mutation before it reaches the store", async () => {
    signIn(OWNER, "owner@example.com");
    const ownerPlan = seedPlan(storeFor(OWNER, "owner@example.com"), "Owner objective");

    const response = await through(
      new NextRequest(`${SITE}/api/work-plans/${ownerPlan}`, {
        method: "DELETE",
        headers: {
          host: "zeus.example",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      }),
      (request, context) => deleteWorkPlan(request, context),
      String(ownerPlan),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("hardens even a refused response, so nothing private is framable or cached", async () => {
    const response = await proxy(browserRequest("/api/work-plans"));

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=");
  });
});

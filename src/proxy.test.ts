import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthConfiguration.mockReturnValue(CONFIGURED);
  mocks.getClaims.mockResolvedValue({
    data: { claims: null },
    error: new Error("signed out"),
  });
  mocks.createServerClient.mockReturnValue({ auth: { getClaims: mocks.getClaims } });
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

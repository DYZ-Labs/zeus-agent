import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  getAuthConfiguration: vi.fn(),
  getClaims: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: mocks.getAuthConfiguration,
}));

import { proxy } from "./proxy";

const CONFIGURED = {
  mode: "configured" as const,
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  ownerEmail: "owner@example.com",
  siteUrl: "http://127.0.0.1:3000",
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

describe("proxy public chat exception", () => {
  it("lets a signed-out chat request reach the memory-free route", async () => {
    const response = await proxy(request("/api/chat"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps every other signed-out API private", async () => {
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

function request(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`, { method: "POST" });
}

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeSupabaseUser: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({
  authorizeSupabaseUser: mocks.authorizeSupabaseUser,
}));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: () => ({
    mode: "configured",
    url: "https://project.supabase.co",
    publishableKey: "sb_publishable_test",
    legacyOwnerEmail: "owner@example.com",
    siteUrl: "http://127.0.0.1:3000",
  }),
}));
vi.mock("@/server/auth/supabase", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import { GET } from "./route";

const USER = { id: "019ff232-f8e0-7ce2-8e83-d416444aed06" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: USER }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.createSupabaseServerClient.mockResolvedValue({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      signOut: mocks.signOut,
    },
  });
  mocks.authorizeSupabaseUser.mockReturnValue({
    state: "authorized",
    canAccessPrivateData: true,
  });
});

describe("OAuth callback route", () => {
  it("exchanges the code, restores the destination, and clears the cookie", async () => {
    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/auth/callback?code=auth-code", {
        headers: { cookie: "zeus-auth-next=/today" },
      }),
    );

    expect(mocks.createSupabaseServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "configured" }),
      { cookieWrites: "required" },
    );
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
    const location = new URL(response.headers.get("location") ?? "http://invalid");
    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.pathname).toBe("/today");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("gives a specific same-browser message when the verifier cookie is absent", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: { code: "pkce_code_verifier_not_found" },
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/auth/callback?code=auth-code"),
    );
    const location = new URL(response.headers.get("location") ?? "http://invalid");

    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("error")).toContain("same browser");
  });

  it("signs out an authenticated account that is not the Zeus owner", async () => {
    mocks.authorizeSupabaseUser.mockReturnValue({
      state: "wrong_account",
      canAccessPrivateData: false,
      message: "This Zeus store belongs to another account.",
    });

    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/auth/callback?code=auth-code"),
    );

    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/auth/login?");
  });
});

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeSupabaseUser: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  signOut: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({
  authorizeSupabaseUser: mocks.authorizeSupabaseUser,
}));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: () => ({
    mode: "configured",
    url: "https://project.supabase.co",
    publishableKey: "sb_publishable_test",
    ownerEmail: "owner@example.com",
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
  mocks.verifyOtp.mockResolvedValue({ data: { user: USER }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.createSupabaseServerClient.mockResolvedValue({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      signOut: mocks.signOut,
      verifyOtp: mocks.verifyOtp,
    },
  });
  mocks.authorizeSupabaseUser.mockReturnValue({
    state: "authorized",
    canAccessPrivateData: true,
  });
});

describe("email confirmation route", () => {
  it("exchanges the PKCE code returned by Supabase's default template", async () => {
    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/auth/confirm?code=auth-code",
        { headers: { cookie: "zeus-auth-next=/memory" } },
      ),
    );

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
    expect(mocks.createSupabaseServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "configured" }),
      { cookieWrites: "required" },
    );
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "http://invalid");
    expect(location.origin).toBe("http://127.0.0.1:3000");
    expect(location.pathname).toBe("/memory");
    expect(response.headers.get("set-cookie")).toContain("zeus-auth-next=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("continues to accept direct token hashes from custom templates", async () => {
    const response = await GET(
      new NextRequest(
        "http://127.0.0.1:3000/auth/confirm?token_hash=hash&type=magiclink",
      ),
    );

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "hash",
      type: "magiclink",
    });
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
  });

  it("rejects incomplete links without trying either verification path", async () => {
    const response = await GET(
      new NextRequest("http://127.0.0.1:3000/auth/confirm?next=%2Ftoday"),
    );

    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/auth/login?");
    expect(response.headers.get("location")).toContain("next=%2Ftoday");
  });
});

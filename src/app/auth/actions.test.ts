import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  cookieSet: vi.fn(),
  getAuthConfiguration: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
  signInWithOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: mocks.getAuthConfiguration,
}));
vi.mock("@/server/auth/supabase", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: mocks.cookieSet }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import {
  requestEmailLinkAction,
  startGoogleAuthAction,
  type AuthActionState,
} from "./actions";

const IDLE: AuthActionState = { status: "idle", message: "" };
const CONFIGURATION = {
  mode: "configured" as const,
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  ownerEmail: "owner@example.com",
  siteUrl: "https://zeus.example",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthConfiguration.mockReturnValue(CONFIGURATION);
  mocks.signInWithOtp.mockResolvedValue({ error: null });
  mocks.createSupabaseServerClient.mockResolvedValue({
    auth: {
      signInWithOtp: mocks.signInWithOtp,
      signInWithOAuth: mocks.signInWithOAuth,
    },
  });
});

describe("startGoogleAuthAction", () => {
  it("uses the exact callback URL and remembers the private destination", async () => {
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: "https://project.supabase.co/auth/v1/authorize" },
      error: null,
    });
    const redirected = new Error("redirected");
    mocks.redirect.mockImplementation(() => {
      throw redirected;
    });

    await expect(startGoogleAuthAction(form("", "/today"))).rejects.toBe(redirected);

    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://zeus.example/auth/callback" },
    });
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "zeus-auth-next", value: "/today" }),
    );
    expect(mocks.redirect).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/authorize",
    );
  });

  it("explains in consumer language when Google is unavailable", async () => {
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: null },
      error: { message: "Unsupported provider: provider is not enabled" },
    });
    const redirected = new Error("redirected");
    mocks.redirect.mockImplementation(() => {
      throw redirected;
    });

    await expect(startGoogleAuthAction(form(""))).rejects.toBe(redirected);

    expect(mocks.redirect).toHaveBeenCalledWith(
      expect.stringContaining("Google%20sign-in%20is%20unavailable"),
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});

describe("requestEmailLinkAction", () => {
  it("rejects invalid input without creating a Supabase client", async () => {
    const invalidEmail = await requestEmailLinkAction("login", IDLE, form("not-an-email"));
    const invalidIntent = await requestEmailLinkAction(
      "reset",
      IDLE,
      form("owner@example.com"),
    );

    expect(invalidEmail).toEqual({
      status: "error",
      message: "Enter a valid email address.",
    });
    expect(invalidIntent).toEqual({
      status: "error",
      message: "Enter a valid email address.",
    });
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured installation without calling Supabase", async () => {
    mocks.getAuthConfiguration.mockReturnValue({ mode: "local" });

    const result = await requestEmailLinkAction("login", IDLE, form("owner@example.com"));

    expect(result).toEqual({
      status: "error",
      message: "Account access is not available in this edition.",
    });
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a non-owner email before calling Supabase", async () => {
    const result = await requestEmailLinkAction("signup", IDLE, form("other@example.com"));

    expect(result).toEqual({
      status: "error",
      message: "Use the owner email configured for this Zeus installation.",
    });
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });

  it("starts login without creating a user and uses the configured exact origin", async () => {
    const result = await requestEmailLinkAction(
      "login",
      IDLE,
      form(" Owner@Example.COM ", "/memory?view=review"),
    );

    expect(result).toEqual({
      status: "sent",
      message: "Check your email, then open the newest link in this same browser to log in.",
    });
    expect(mocks.createSupabaseServerClient).toHaveBeenCalledWith(CONFIGURATION, {
      cookieWrites: "required",
    });
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      options: {
        shouldCreateUser: false,
        emailRedirectTo: "https://zeus.example/auth/confirm",
      },
    });
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "zeus-auth-next",
        value: "/memory?view=review",
        httpOnly: true,
        secure: true,
      }),
    );
  });

  it("allows signup to create the configured owner account", async () => {
    const result = await requestEmailLinkAction(
      "signup",
      IDLE,
      form("owner@example.com"),
    );

    expect(result).toEqual({
      status: "sent",
      message:
        "Check your email, then open the newest link in this same browser to finish signup.",
    });
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      options: {
        shouldCreateUser: true,
        emailRedirectTo: "https://zeus.example/auth/confirm",
      },
    });
  });
});

function form(email: string, next = "/"): FormData {
  const data = new FormData();
  data.set("email", email);
  data.set("next", next);
  return data;
}

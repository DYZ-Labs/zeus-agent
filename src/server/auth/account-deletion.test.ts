import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { accountDeletionAvailable } from "./account-deletion";

const configured = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
  NEXT_PUBLIC_SITE_URL: "https://zeus.example.com",
  ZEUS_OWNER_EMAIL: "owner@example.com",
};

describe("account deletion capability", () => {
  it("fails closed without server-side deletion authority", () => {
    expect(accountDeletionAvailable(configured)).toBe(false);
  });

  it("is available only when configured with server-only authority", () => {
    expect(accountDeletionAvailable({
      ...configured,
      SUPABASE_SERVICE_ROLE_KEY: "server-only-secret",
    })).toBe(true);
  });

  it("never enables local mode from a key alone", () => {
    expect(accountDeletionAvailable({ SUPABASE_SERVICE_ROLE_KEY: "secret" })).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getAuthCapabilities } from "./capabilities";

const CONFIGURATION = {
  mode: "configured" as const,
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  legacyOwnerEmail: "owner@example.com",
  siteUrl: "http://127.0.0.1:3000",
  allowedSignupEmails: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("public auth capabilities", () => {
  it("reports whether Google is enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ external: { email: true, google: false } }),
      ),
    );

    await expect(getAuthCapabilities(CONFIGURATION)).resolves.toEqual({
      googleEnabled: false,
    });
  });

  it("degrades to unknown when Supabase settings are unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(getAuthCapabilities(CONFIGURATION)).resolves.toEqual({
      googleEnabled: null,
    });
  });
});

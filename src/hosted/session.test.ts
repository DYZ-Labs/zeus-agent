import { describe, expect, it, vi } from "vitest";

import {
  HostedSessionVerificationError,
  requireVerifiedTenantSession,
  verifiedTenantId,
} from "@/hosted/session";

describe("hosted verified tenant sessions", () => {
  it("derives the tenant from the Auth-verified user", async () => {
    const getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "00000000-0000-4000-8000-00000000a001" } },
      error: null,
    });

    const session = await requireVerifiedTenantSession({ getUser });

    expect(verifiedTenantId(session)).toBe("00000000-0000-4000-8000-00000000a001");
    expect(getUser).toHaveBeenCalledOnce();
  });

  it.each([
    { data: { user: null }, error: null },
    { data: { user: { id: "request-body-tenant" } }, error: null },
    { data: { user: { id: "00000000-0000-4000-8000-00000000a001" } }, error: { message: "expired" } },
  ])("fails closed for an unverified user result", async (result) => {
    await expect(
      requireVerifiedTenantSession({ getUser: async () => result }),
    ).rejects.toBeInstanceOf(HostedSessionVerificationError);
  });

  it("does not expose upstream authentication details", async () => {
    await expect(
      requireVerifiedTenantSession({
        getUser: async () => {
          throw new Error("token=secret-value");
        },
      }),
    ).rejects.toThrow("A verified account session is required.");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOwnerAccess: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({ getOwnerAccess: mocks.getOwnerAccess }));

import { POST as postChat } from "./chat/route";
import { POST as postFollowThrough } from "./follow-through/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnerAccess.mockResolvedValue({
    state: "signed_out",
    canAccessPrivateData: false,
    account: null,
    db: null,
    message: "Log in to access this Zeus memory store.",
  });
});

describe("private API auth guards", () => {
  it("rejects chat writes before parsing or opening the memory store", async () => {
    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", { method: "POST", body: "not-json" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Log in to access this Zeus memory store.",
    });
  });

  it("rejects follow-through mutations for signed-out requests", async () => {
    const response = await postFollowThrough(
      new Request("http://127.0.0.1:3000/api/follow-through", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.getOwnerAccess).toHaveBeenCalledOnce();
  });

  it("distinguishes an authenticated but unlinked account", async () => {
    mocks.getOwnerAccess.mockResolvedValue({
      state: "wrong_account",
      canAccessPrivateData: false,
      account: null,
      db: null,
      message: "This Zeus memory store is already linked to a different account.",
    });

    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(403);
  });
});

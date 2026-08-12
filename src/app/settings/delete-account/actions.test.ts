import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendMessage, createConversation } from "@/core/conversations";
import { openTestDb } from "@/core/db";
import { bindAppOwner, getAppOwner } from "@/core/owner";

const mocks = vi.hoisted(() => ({
  getOwnerAccess: vi.fn(),
  deleteVerifiedAuthAccount: vi.fn(),
  signOut: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/access", () => ({ getOwnerAccess: mocks.getOwnerAccess }));
vi.mock("@/server/auth/account-deletion", () => ({
  accountDeletionAvailable: () => true,
  deleteVerifiedAuthAccount: mocks.deleteVerifiedAuthAccount,
}));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: () => ({ mode: "configured" }),
}));
vi.mock("@/server/auth/supabase", () => ({
  createSupabaseServerClient: async () => ({ auth: { signOut: mocks.signOut } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { deleteAccountAction, initialDeleteAccountState } from "./actions";

const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("account deletion ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.signOut.mockResolvedValue({ error: null });
  });

  it("clears and unbinds the local store before deleting the Auth identity", async () => {
    const db = ownedStore();
    mocks.getOwnerAccess.mockResolvedValue(authorizedAccess(db));
    mocks.deleteVerifiedAuthAccount.mockImplementationOnce(async () => {
      expect(getAppOwner(db)).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS count FROM message").get()).toEqual({ count: 0 });
    });

    await deleteAccountAction(initialDeleteAccountState, confirmation());

    expect(mocks.deleteVerifiedAuthAccount).toHaveBeenCalledWith(USER_ID);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.redirect).toHaveBeenCalledWith("/");
  });

  it("leaves a failed provider deletion recoverable instead of binding to a dead id", async () => {
    const db = ownedStore();
    mocks.getOwnerAccess.mockResolvedValue(authorizedAccess(db));
    mocks.deleteVerifiedAuthAccount.mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await deleteAccountAction(initialDeleteAccountState, confirmation());

    expect(result).toMatchObject({ status: "error" });
    expect(getAppOwner(db)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM message").get()).toEqual({ count: 0 });
    expect(
      bindAppOwner(db, { supabaseUserId: USER_ID, email: "owner@example.com" }).owner
        .supabase_user_id,
    ).toBe(USER_ID);
  });
});

function ownedStore() {
  const db = openTestDb();
  bindAppOwner(db, { supabaseUserId: USER_ID, email: "owner@example.com" });
  const conversation = createConversation(db, { title: "Private" });
  appendMessage(db, conversation.id, "user", "Erase this account data.");
  return db;
}

function authorizedAccess(db: ReturnType<typeof openTestDb>) {
  return {
    state: "authorized" as const,
    canAccessPrivateData: true as const,
    account: {
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
      provider: "email",
    },
    db,
    message: null,
  };
}

function confirmation(): FormData {
  const form = new FormData();
  form.set("confirmation", "DELETE");
  return form;
}

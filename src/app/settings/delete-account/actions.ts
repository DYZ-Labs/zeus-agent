"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { clearZeusData } from "@/core/retention";
import {
  accountDeletionAvailable,
  deleteVerifiedAuthAccount,
} from "@/server/auth/account-deletion";
import { getOwnerAccess } from "@/server/auth/access";
import { getAuthConfiguration } from "@/server/auth/config";
import { createSupabaseServerClient } from "@/server/auth/supabase";

export type DeleteAccountState = { status: "idle" | "error"; message: string };
export const initialDeleteAccountState: DeleteAccountState = { status: "idle", message: "" };

export async function deleteAccountAction(
  _previous: DeleteAccountState,
  formData: FormData,
): Promise<DeleteAccountState> {
  if (String(formData.get("confirmation") ?? "").trim() !== "DELETE") {
    return { status: "error", message: "Type DELETE exactly to confirm." };
  }
  const access = await getOwnerAccess();
  if (access.state !== "authorized" || !access.account) {
    return { status: "error", message: "Log in again before deleting this account." };
  }
  if (!accountDeletionAvailable()) {
    return {
      status: "error",
      message: "Account deletion is temporarily unavailable. No data was changed.",
    };
  }

  try {
    clearZeusData(access.db);
  } catch {
    return {
      status: "error",
      message: "Zeus could not safely clear the account data. No account was deleted.",
    };
  }

  // Unbind locally before the irreversible Auth deletion. If either this write or
  // the provider request fails, the verified account still exists and can safely
  // bind the now-empty store again on the next attempt. The inverse ordering could
  // strand the store behind a UUID that no longer has a login.
  try {
    access.db.prepare("DELETE FROM app_owner WHERE id = 1").run();
  } catch {
    return {
      status: "error",
      message: "Your Zeus data was cleared, but the account could not be unlinked. No account was deleted.",
    };
  }

  try {
    await deleteVerifiedAuthAccount(access.account.id);
  } catch {
    return {
      status: "error",
      message: "Your Zeus data was cleared, but account deletion did not finish. Try again.",
    };
  }

  const configuration = getAuthConfiguration();
  if (configuration.mode === "configured") {
    try {
      const supabase = await createSupabaseServerClient(configuration, { cookieWrites: "required" });
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // The identity is already gone and the local store is unbound. Cookie cleanup
      // is best effort and must not turn a completed deletion into an error page.
    }
  }
  revalidatePath("/", "layout");
  redirect("/");
}

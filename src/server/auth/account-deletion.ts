import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getAuthConfiguration } from "./config";

export function accountDeletionAvailable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    getAuthConfiguration(environment as NodeJS.ProcessEnv).mode === "configured" &&
    Boolean(environment.SUPABASE_SERVICE_ROLE_KEY?.trim())
  );
}

/** Delete only the already-verified current Auth identity. This client is never
 * exported and is not used for application data, which remains behind non-bypass RLS. */
export async function deleteVerifiedAuthAccount(userId: string): Promise<void> {
  const configuration = getAuthConfiguration();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (configuration.mode !== "configured" || !serviceRoleKey) {
    throw new AccountDeletionUnavailableError();
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(userId)) {
    throw new Error("The verified account identity is invalid");
  }

  const admin = createClient(configuration.url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await admin.auth.admin.deleteUser(userId, false);
  if (error) throw new Error("The account provider could not complete deletion");
}

export class AccountDeletionUnavailableError extends Error {
  constructor() {
    super("Account deletion is unavailable");
    this.name = "AccountDeletionUnavailableError";
  }
}

import "server-only";

import { isAuthSessionMissingError, type User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { bindAppOwner, getAppOwner } from "@/core/owner";
import type { Db } from "@/core/db";
import type { AccountSummary } from "@/lib/auth-types";
import { getDb } from "@/server/db";
import { getAuthConfiguration } from "@/server/auth/config";
import {
  checkBrowserBoundary,
  type BrowserCapability,
} from "@/server/auth/browser-origin";
import { createSupabaseServerClient } from "@/server/auth/supabase";

export type OwnerAccessState =
  | "local"
  | "authorized"
  | "signed_out"
  | "wrong_account"
  | "forbidden_origin"
  | "misconfigured"
  | "unavailable";

export type OwnerAccess =
  | {
      state: "local" | "authorized";
      canAccessPrivateData: true;
      account: AccountSummary | null;
      db: Db;
      message: null;
    }
  | {
      state: Exclude<OwnerAccessState, "local" | "authorized">;
      canAccessPrivateData: false;
      account: AccountSummary | null;
      db: null;
      message: string;
    };

export async function getOwnerAccess(): Promise<OwnerAccess> {
  const configuration = getAuthConfiguration();
  if (configuration.mode === "local") {
    const db = getDb();
    if (getAppOwner(db)) {
      return denied(
        "misconfigured",
        "Account access is temporarily unavailable for this Zeus store.",
      );
    }
    return {
      state: "local",
      canAccessPrivateData: true,
      account: null,
      db,
      message: null,
    };
  }
  if (configuration.mode === "misconfigured") {
    return denied("misconfigured", configuration.message);
  }

  try {
    const supabase = await createSupabaseServerClient(configuration);
    const { data, error } = await supabase.auth.getUser();
    if (!data.user && isAuthSessionMissingError(error)) {
      return denied("signed_out", "Log in to access this Zeus memory store.");
    }
    if (error || !data.user) {
      return denied(
        "unavailable",
        "Zeus could not verify the account right now. Private memory stayed locked.",
      );
    }
    return authorizeSupabaseUser(data.user);
  } catch {
    return denied(
      "unavailable",
      "Zeus could not verify the account right now. Private memory stayed locked.",
    );
  }
}

/**
 * Private HTTP routes must cross both boundaries: an allowed browser origin with an
 * explicitly declared capability, then the immutable owner-account check.
 */
export async function getBrowserOwnerAccess(
  request: Pick<Request, "headers" | "method" | "url">,
  capability: BrowserCapability,
): Promise<OwnerAccess> {
  const configuration = getAuthConfiguration();
  // Preserve the more useful fail-closed configuration error; Proxy already blocks
  // the request, and no store can be opened in this state.
  if (configuration.mode === "misconfigured") return getOwnerAccess();
  const boundary = checkBrowserBoundary(request, capability, configuration);
  if (!boundary.allowed) {
    return denied("forbidden_origin", boundary.message);
  }
  return getOwnerAccess();
}

export type StoreFreeChatAccess =
  | { allowed: true; state: "local" | "authorized" | "signed_out" }
  | {
      allowed: false;
      state: "wrong_account" | "forbidden_origin" | "misconfigured" | "unavailable";
      message: string;
    };

/**
 * Authorize temporary chat while keeping signed-out chat completely store-free.
 *
 * A genuine missing session is the guest capability and returns before SQLite can be
 * opened. Authenticated requests read only the owner binding so that a different signed-in
 * account cannot bypass the blocked UI; they never bind an owner or inspect memory here.
 */
export async function verifyStoreFreeChatAccess(
  request: Pick<Request, "headers" | "method" | "url">,
): Promise<StoreFreeChatAccess> {
  const configuration = getAuthConfiguration();
  if (configuration.mode === "misconfigured") {
    return { allowed: false, state: "misconfigured", message: configuration.message };
  }
  const boundary = checkBrowserBoundary(request, "private-mutation", configuration);
  if (!boundary.allowed) {
    return { allowed: false, state: "forbidden_origin", message: boundary.message };
  }
  if (configuration.mode === "local") return { allowed: true, state: "local" };

  try {
    const supabase = await createSupabaseServerClient(configuration);
    const { data, error } = await supabase.auth.getUser();
    if (!data.user && isAuthSessionMissingError(error)) {
      return {
        allowed: true,
        state: "signed_out",
      };
    }
    if (error || !data.user) {
      return {
        allowed: false,
        state: "unavailable",
        message: "Zeus could not verify the account right now.",
      };
    }

    const db = getDb();
    const owner = getAppOwner(db);
    const email = data.user.email?.trim().toLowerCase() ?? "";
    const isOwner = owner
      ? owner.supabase_user_id === data.user.id
      : Boolean(
          email &&
            data.user.email_confirmed_at &&
            email === configuration.ownerEmail,
        );
    if (!isOwner) {
      return {
        allowed: false,
        state: "wrong_account",
        message: "Use the verified owner account configured for this Zeus installation.",
      };
    }

    return { allowed: true, state: "authorized" };
  } catch {
    return {
      allowed: false,
      state: "unavailable",
      message: "Zeus could not verify the account right now.",
    };
  }
}

/**
 * Bind the empty local store only to the configured, verified owner email. Once
 * bound, the immutable Supabase UUID—not mutable email or user metadata—authorizes it.
 */
export function authorizeSupabaseUser(user: User): OwnerAccess {
  const configuration = getAuthConfiguration();
  if (configuration.mode !== "configured") {
    return denied(
      "misconfigured",
      configuration.mode === "local"
        ? "Account access is not configured."
        : configuration.message,
    );
  }

  const account = accountSummary(user);
  const email = user.email?.trim().toLowerCase() ?? "";
  const db = getDb();
  const owner = getAppOwner(db);

  if (owner) {
    return owner.supabase_user_id === user.id
      ? allowed(db, account)
      : denied(
          "wrong_account",
          "This Zeus memory store is already linked to a different account.",
          account,
        );
  }

  if (!email || !user.email_confirmed_at || email !== configuration.ownerEmail) {
    return denied(
      "wrong_account",
      "Use the verified owner account configured for this Zeus installation.",
      account,
    );
  }

  const binding = bindAppOwner(db, { supabaseUserId: user.id, email });
  return binding.owner.supabase_user_id === user.id
    ? allowed(db, account)
    : denied(
        "wrong_account",
        "This Zeus memory store was linked to another account before setup completed.",
        account,
      );
}

export async function requireOwnerDb(): Promise<Db> {
  const access = await getOwnerAccess();
  if (access.canAccessPrivateData) return access.db;
  throw new OwnerAccessError(access.state, access.message);
}

export async function requireOwnerPageDb(): Promise<Db> {
  const access = await getOwnerAccess();
  if (access.canAccessPrivateData) return access.db;

  const query = new URLSearchParams({ error: access.message });
  redirect(`/auth/login?${query.toString()}`);
}

export class OwnerAccessError extends Error {
  constructor(
    readonly state: Exclude<OwnerAccessState, "local" | "authorized">,
    message: string,
  ) {
    super(message);
    this.name = "OwnerAccessError";
  }
}

function accountSummary(user: User): AccountSummary {
  const metadata = user.user_metadata as Record<string, unknown>;
  const name = firstString(metadata.full_name, metadata.name, metadata.display_name);
  const avatarUrl = firstString(metadata.avatar_url, metadata.picture);
  const provider =
    typeof user.app_metadata.provider === "string"
      ? user.app_metadata.provider
      : user.identities?.[0]?.provider ?? "email";

  return {
    id: user.id,
    email: user.email ?? "Unknown email",
    name,
    avatarUrl,
    provider,
  };
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

function allowed(db: Db, account: AccountSummary): OwnerAccess {
  return {
    state: "authorized",
    canAccessPrivateData: true,
    account,
    db,
    message: null,
  };
}

function denied(
  state: Exclude<OwnerAccessState, "local" | "authorized">,
  message: string,
  account: AccountSummary | null = null,
): OwnerAccess {
  return { state, canAccessPrivateData: false, account, db: null, message };
}

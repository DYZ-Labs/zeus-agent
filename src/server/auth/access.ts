import "server-only";

import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

import { bindAppOwner, getAppOwner } from "@/core/owner";
import { logEvent } from "@/core/observability";
import type { Db } from "@/core/db";
import type { AccountSummary } from "@/lib/auth-types";
import { getAuthConfiguration, signupAllowed } from "@/server/auth/config";
import {
  checkBrowserBoundary,
  type BrowserCapability,
} from "@/server/auth/browser-origin";
import { accountDbExists, getAccountDb, getDb } from "@/server/db";
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
        "This Zeus store is account-bound. Restore its Supabase configuration to unlock it.",
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
    if (error || !data.user) {
      return denied("signed_out", "Log in to access this Zeus memory store.");
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

/**
 * Route each verified identity to its isolated personal store, then bind that store to
 * the immutable Supabase UUID—not mutable email or user metadata. The optional legacy
 * email only selects the pre-multi-account database during its one-time transition.
 */
export function authorizeSupabaseUser(user: User): OwnerAccess {
  const configuration = getAuthConfiguration();
  if (configuration.mode !== "configured") {
    return denied(
      "misconfigured",
      configuration.mode === "local"
        ? "Supabase login is not configured."
        : configuration.message,
    );
  }

  const account = accountSummary(user);
  const userId = user.id.trim().toLowerCase();
  const email = user.email?.trim().toLowerCase() ?? "";
  // An identity carrying no address at all is a different refusal from one whose address
  // is merely unconfirmed. Nobody can click a confirmation link that was never sent: a
  // provider configured to release no email is the operator's fault to fix, and filing it
  // under "confirm your email" would hide it behind advice for the visitor.
  if (!email) {
    return denied(
      "wrong_account",
      "This login provider did not supply an email address, and Zeus needs one to identify the account.",
      account,
      "missing_provider_email",
    );
  }
  if (!user.email_confirmed_at) {
    return denied(
      "wrong_account",
      "Use a Supabase account with a verified email address.",
      account,
      "unverified_email",
    );
  }

  const identity = {
    supabaseUserId: userId,
    email,
    legacyOwnerEmail: configuration.legacyOwnerEmail,
  };

  // Gate the *allocation*, not the session. An account that already has a store keeps
  // working regardless of the allowlist, so tightening it can never lock out an
  // established user; only a first-time store creation needs operator consent.
  if (!accountDbExists(identity) && !signupAllowed(email, configuration)) {
    return denied(
      "wrong_account",
      "Zeus is invite-only on this deployment, and this email is not on the allowlist.",
      account,
      "not_invited",
    );
  }

  const db = getAccountDb(identity);
  const owner = getAppOwner(db);

  if (owner) {
    return owner.supabase_user_id === userId
      ? allowed(db, account)
      : denied(
          "wrong_account",
          "This Zeus memory store is already linked to a different account.",
          account,
        );
  }

  const binding = bindAppOwner(db, { supabaseUserId: userId, email });
  return binding.owner.supabase_user_id === userId
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

/**
 * What an operator should conclude from a refusal, which is not always what the caller is
 * told. Four separate conditions return the `wrong_account` state — an identity with no
 * address, an unconfirmed one, an uninvited signup, and a store reached by an identity it
 * is not bound to — and only the last is a boundary being tested. Reported under one name,
 * the most security-relevant event this system can produce would also fire every time
 * somebody has not yet clicked a confirmation link, and an alert that cries wolf is an
 * alert that gets turned off.
 */
type DenialReason =
  | Exclude<OwnerAccessState, "local" | "authorized">
  | "unverified_email"
  | "missing_provider_email"
  | "not_invited";

/**
 * Refusals whose own message is the entire resolution.
 *
 * A signed-out visitor is told to log in and an unconfirmed account is told to confirm its
 * address. In both cases the person reading the message is the only one who can act, so an
 * operator has nothing to do with the line but scroll past it. Silence also keeps the log
 * readable: this check runs on every page render and every API request, so reporting the
 * signed-out state would make the highest-volume line in the deployment the one nobody can
 * act on, and bury the ones that mean a deployment is broken or a boundary was tested.
 *
 * An uninvited signup is deliberately not on this list, self-explaining though its message
 * is. On an invite-only deployment it is the only state a stranger can reach — an identity
 * with no store never reaches `getAccountDb`, so it can never produce `wrong_account` — and
 * "somebody outside the allowlist authenticated here and asked for a store" is exactly what
 * an operator wants to know. It is reported at a bounded rate instead, below.
 */
const SELF_EXPLAINING_DENIALS: ReadonlySet<DenialReason> = new Set([
  "signed_out",
  "unverified_email",
]);

/**
 * Refusals that describe a condition rather than a single act, reported on a window
 * instead of on every occurrence.
 *
 * `getOwnerAccess` runs at least twice per page render — the root layout is dynamic and
 * calls it, then the page calls it again — so a reason that persists is a reason that
 * repeats without end. A deployment whose configuration no longer matches its store would
 * restate that twice a render for as long as it stays broken, and a Supabase outage would
 * restate it on top of Proxy's own `auth_unavailable`. An uninvited signup repeats for a
 * different reason: the signup page is public, so its rate is chosen by whoever is signing
 * up. An operator needs to know a condition started, and roughly how often it is being
 * hit — not that it is still true forty thousand times.
 *
 * The two left out are the refusals that name the account that caused them. A window keeps
 * the first caller and drops the rest, and for a store reached by an identity it is not
 * bound to, that attribution is the entire point of the line.
 */
const WINDOWED_DENIALS: ReadonlySet<DenialReason> = new Set([
  "misconfigured",
  "unavailable",
  "not_invited",
  "missing_provider_email",
]);

/**
 * Short enough that an operator sees a condition within minutes of it starting, long
 * enough that a steady fault costs a handful of lines an hour rather than one per render.
 */
const DENIAL_WINDOW_MS = 5 * 60 * 1000;

/** Keyed by reason, so this cannot grow past the reasons declared above however hard a caller tries. */
const denialWindows = new Map<DenialReason, { openedAt: number; suppressed: number }>();

function denied(
  state: Exclude<OwnerAccessState, "local" | "authorized">,
  message: string,
  account: AccountSummary | null = null,
  reason: DenialReason = state,
): OwnerAccess {
  reportDenial(reason, account);
  return { state, canAccessPrivateData: false, account, db: null, message };
}

/**
 * Reported here rather than at the call sites because every refusal in this module leaves
 * through `denied`; a branch added later is visible without anyone remembering to add a
 * line to it.
 *
 * `error` throughout, deliberately. Nothing reported here is a partial success — private
 * memory is withheld entirely — and each remaining reason describes something an operator
 * has to see: configuration that no longer matches the store, an auth service that stopped
 * answering, a provider that releases no address, a blocked origin, a stranger asking an
 * invite-only deployment for a store, or a store reached by an identity it is not bound
 * to. The failing call's own error class is not repeated here; Proxy stands in front of
 * every one of these requests and already reports an outage with that signature.
 */
function reportDenial(reason: DenialReason, account: AccountSummary | null): void {
  if (SELF_EXPLAINING_DENIALS.has(reason)) return;
  if (!WINDOWED_DENIALS.has(reason)) {
    writeDenial(reason, account);
    return;
  }

  const now = Date.now();
  const open = denialWindows.get(reason);
  if (open && now - open.openedAt < DENIAL_WINDOW_MS) {
    open.suppressed += 1;
    return;
  }
  // The refusals held back since the last line are carried on this one as a count, so a
  // quiet window still reads as a magnitude rather than as nothing having happened.
  denialWindows.set(reason, { openedAt: now, suppressed: 0 });
  writeDenial(reason, account, 1 + (open?.suppressed ?? 0));
}

function writeDenial(
  reason: DenialReason,
  account: AccountSummary | null,
  count?: number,
): void {
  logEvent({
    event: "owner_access_denied",
    outcome: "error",
    reason,
    // How many refusals this line stands for: itself and every one suppressed since the
    // previous line. Absent on the reasons that are reported one for one.
    count,
    // The Supabase UUID alone. `AccountSummary` also carries an email address, a display
    // name, and an avatar URL — three ways to name a person in a file that must not name
    // one. Cased the way `bindAppOwner` stores the id, so the line joins to the owner it
    // is about rather than to a case variant of them. On a windowed line it names the
    // caller that opened the window, not every caller the count covers.
    ...(account ? { account: account.id.trim().toLowerCase() } : {}),
  });
}

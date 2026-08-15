import type { Db } from "./db";
import { now } from "./db";
import { AppOwner, type AppOwner as AppOwnerRow } from "./schema";

const OwnerIdentity = AppOwner.pick({
  supabase_user_id: true,
  email: true,
});

export type BindAppOwnerInput = {
  supabaseUserId: string;
  email: string;
};

export type BindAppOwnerResult = {
  owner: AppOwnerRow;
  /** True only when this call created the immutable first-owner binding. */
  bound: boolean;
};

/** Return the one identity allowed to use this local memory store, if it is bound. */
export function getAppOwner(db: Db): AppOwnerRow | null {
  const row = db
    .prepare<[], unknown>(
      `SELECT id, supabase_user_id, email, bound_at
       FROM app_owner
       WHERE id = 1`,
    )
    .get();
  return row === undefined ? null : AppOwner.parse(row);
}

/**
 * Which account an operational event is about, shaped to spread into `logEvent`.
 *
 * `src/core` takes a `Db`, never an identity, and threading an account through every
 * signature to reach a log line would be both invasive and wrong. It is also
 * unnecessary: a hosted deployment gives each account its own store, so the handle
 * already *is* the identity. `logEvent({ event: "…", ...accountEvent(db) })` therefore
 * attributes an event with no signature changes anywhere.
 *
 * Without it an operator reading an incident cannot tell one broken account from every
 * account broken, which is the first question worth asking.
 */
export type AccountEvent = { account: string } | Record<string, never>;

/**
 * Remembered per handle, and only once an owner is actually found.
 *
 * The binding is written once and never rewritten — a single row that `CHECK (id = 1)`
 * keeps singular, and `bindAppOwner`'s INSERT is the only statement in Zeus that touches
 * the table — so a resolved answer can never go stale. A store with no owner is
 * deliberately not cached: one claimed mid-process starts attributing its events on the
 * very next one, rather than staying anonymous for the life of the handle because of a
 * negative nobody remembered to invalidate.
 */
const accountByDb = new WeakMap<Db, string>();

export function accountEvent(db: Db): AccountEvent {
  const cached = accountByDb.get(db);
  if (cached !== undefined) return { account: cached };

  try {
    const owner = getAppOwner(db);
    // Local single-user mode never binds an owner; there is one person and nothing to
    // disambiguate, so those events are simply unattributed.
    if (!owner) return {};
    accountByDb.set(db, owner.supabase_user_id);
    return { account: owner.supabase_user_id };
  } catch {
    // A logging helper that can throw turns a diagnostic into an outage. A closed
    // handle, or a store that has not yet reached the migration that creates this table,
    // has no attribution to offer — never a reason to lose the event being reported.
    return {};
  }
}

/**
 * Bind an unclaimed store to its first authenticated identity.
 *
 * The immediate transaction serializes the read-before-insert across the web and MCP
 * processes. Once present, the row is returned unchanged even when another identity
 * asks to bind; callers compare its stable UUID with the authenticated UUID and deny
 * access on a mismatch.
 */
export function bindAppOwner(db: Db, input: BindAppOwnerInput): BindAppOwnerResult {
  const identity = OwnerIdentity.parse({
    supabase_user_id: input.supabaseUserId.trim().toLowerCase(),
    email: input.email.trim().toLowerCase(),
  });

  const bind = db.transaction((): BindAppOwnerResult => {
    const existing = getAppOwner(db);
    if (existing) return { owner: existing, bound: false };

    db.prepare<[number, string, string, string]>(
      `INSERT INTO app_owner (id, supabase_user_id, email, bound_at)
       VALUES (?, ?, ?, ?)`,
    ).run(1, identity.supabase_user_id, identity.email, now());

    const owner = getAppOwner(db);
    if (!owner) throw new Error("App owner vanished immediately after binding");
    return { owner, bound: true };
  });

  return bind.immediate();
}

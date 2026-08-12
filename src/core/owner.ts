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

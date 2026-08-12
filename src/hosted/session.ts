import { z } from "zod";

const SupabaseUserId = z.string().uuid();
const verifiedTenantSessionBrand: unique symbol = Symbol("VerifiedTenantSession");

/**
 * A tenant identity that came from Supabase Auth's server-side `getUser()`
 * verification path. There is intentionally no public constructor and no
 * request-body tenant field.
 */
export interface VerifiedTenantSession {
  readonly [verifiedTenantSessionBrand]: true;
}

export interface VerifiedUserProvider {
  getUser(): Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>;
}

export class HostedSessionVerificationError extends Error {
  constructor() {
    super("A verified account session is required.");
    this.name = "HostedSessionVerificationError";
  }
}

/**
 * Call this with a server-side Supabase client. Supabase `getUser()` verifies
 * the token with Auth; `getSession()` is not an acceptable substitute here.
 */
export async function requireVerifiedTenantSession(
  provider: VerifiedUserProvider,
): Promise<VerifiedTenantSession> {
  let result: Awaited<ReturnType<VerifiedUserProvider["getUser"]>>;
  try {
    result = await provider.getUser();
  } catch {
    throw new HostedSessionVerificationError();
  }

  const userId = SupabaseUserId.safeParse(result.data.user?.id);
  if (result.error || !userId.success) {
    throw new HostedSessionVerificationError();
  }

  return Object.freeze({
    [verifiedTenantSessionBrand]: true as const,
    userId: userId.data,
  });
}

/** @internal Used only by the tenant transaction runner. */
export function verifiedTenantId(session: VerifiedTenantSession): string {
  const candidate = session as VerifiedTenantSession & { userId?: unknown };
  const userId = SupabaseUserId.safeParse(candidate.userId);
  if (candidate[verifiedTenantSessionBrand] !== true || !userId.success) {
    throw new HostedSessionVerificationError();
  }
  return userId.data;
}

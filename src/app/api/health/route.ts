import { appliedMigrationLedger } from "@/core/db";
import { embeddingStatus } from "@/core/embed";
import { MIGRATIONS } from "@/core/migrations";
import { errorSignature, logEvent } from "@/core/observability";
import { hasCredentials } from "@/core/openai";
import { getAuthConfiguration } from "@/server/auth/config";
import { getDb } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this process can actually serve, not merely whether it is listening.
 *
 * The distinction is the point: a Zeus process whose volume vanished still answers
 * `/` with a 200 while every private route fails. This opens the store and reads its
 * migration ledger, so an unopenable or unmigrated database reports `503` and a
 * platform health check can act on it.
 *
 * Unauthenticated, and therefore deliberately empty of user data: no paths, no counts
 * of memory, no account list. Schema version and subsystem availability only.
 */
export async function GET(): Promise<Response> {
  const started = Date.now();
  const store = storeHealth();
  const configuration = getAuthConfiguration();
  const embeddings = embeddingStatus();
  const healthy = store.status === "ok";

  logEvent({
    event: "health_check",
    outcome: healthy ? "ok" : "error",
    status: healthy ? 200 : 503,
    duration_ms: Date.now() - started,
    mode: configuration.mode,
    ...(healthy ? {} : { reason: "store_unavailable" }),
  });

  return Response.json(
    {
      status: healthy ? "ok" : "unavailable",
      store,
      auth: configuration.mode,
      // "degraded" is honest rather than reassuring: retrieval silently falls back to
      // full-text when the local model cannot load, and that is worth surfacing.
      embeddings,
      model: hasCredentials() ? "configured" : "absent",
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

type StoreHealth =
  | { status: "ok"; migrations_applied: number; migrations_expected: number }
  | { status: "error"; error_name: string; error_site?: string };

function storeHealth(): StoreHealth {
  try {
    const applied = appliedMigrationLedger(getDb());
    return {
      status: "ok",
      migrations_applied: applied.length,
      migrations_expected: MIGRATIONS.length,
    };
  } catch (error) {
    // The class and code location are safe to return; a message might not be.
    return { status: "error", ...errorSignature(error) };
  }
}

import "server-only";

import { EMBEDDING_MODEL, embeddingsDisabled, warmEmbeddings } from "@/core/embed";
import { logEvent } from "@/core/observability";
import { getAuthConfiguration } from "@/server/auth/config";

/**
 * Load the embedding model at startup instead of inside a user's first search.
 *
 * The model is a ~140MB download from a public CDN on a cache miss. Lazily loading it
 * meant whichever request searched first paid for that download while someone waited,
 * and a cold cache on a fresh container made that the *first* search after every
 * deploy. Warming moves the cost to boot, where nobody is waiting for it.
 *
 * On by default only for a hosted deployment: `next dev` should not pull 140MB the
 * moment a contributor starts the server, and locally the first search is a reasonable
 * place to decide the download is wanted. `ZEUS_WARM_EMBEDDINGS` overrides either way.
 */
export type WarmupDecision = {
  enabled: boolean;
  reason: "hosted" | "explicitly_enabled" | "explicitly_disabled" | "not_hosted" | "embeddings_off";
};

export function embeddingWarmupDecision(
  configuration: { mode: string } = getAuthConfiguration(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WarmupDecision {
  if (embeddingsDisabled()) return { enabled: false, reason: "embeddings_off" };

  const configured = environment.ZEUS_WARM_EMBEDDINGS?.trim().toLowerCase();
  if (configured === "off") return { enabled: false, reason: "explicitly_disabled" };
  if (configured === "on") return { enabled: true, reason: "explicitly_enabled" };
  if (configured !== undefined && configured !== "") {
    throw new Error("ZEUS_WARM_EMBEDDINGS must be 'on' or 'off'");
  }

  const hosted =
    configuration.mode === "configured" && environment.NODE_ENV === "production";
  return { enabled: hosted, reason: hosted ? "hosted" : "not_hosted" };
}

/**
 * Start the warm-up without waiting for it.
 *
 * Returns the decision rather than the load, so startup is never delayed by a model
 * download and a failed warm-up can never keep the server from serving. Search still
 * works while this runs; it just answers from full-text until the model is ready.
 */
export function startEmbeddingWarmup(): WarmupDecision {
  const decision = embeddingWarmupDecision();
  if (!decision.enabled) return decision;

  void (async () => {
    const started = Date.now();
    const status = await warmEmbeddings();
    logEvent({
      event: "embeddings_warmed",
      outcome: status === "ready" ? "ok" : "degraded",
      reason: status === "ready" ? "model_ready" : "model_unavailable",
      model: EMBEDDING_MODEL,
      duration_ms: Date.now() - started,
    });
  })();

  return decision;
}

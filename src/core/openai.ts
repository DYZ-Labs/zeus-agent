import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";

import { logEvent } from "./observability";

/**
 * The single OpenAI client. Constructed lazily so the store, tests, and curation
 * UI continue to work without credentials; only model-backed paths require a key.
 */
export const MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";
export const OPENAI_TIMEOUT_MS = 75_000;
export const OPENAI_MAX_RETRIES = 1;

const globalForOpenAI = globalThis as typeof globalThis & {
  zeusResolvedOpenAIModelLogged?: boolean;
};

const sdkLogger = {
  // Do not forward SDK diagnostics: some parser errors can include response chunks.
  // Callers still receive the thrown error through the ordinary request boundary.
  error() {},
  warn() {},
  info(message: string) {
    // The SDK logs terminal retry state at info level. Keep normal request metadata
    // quiet and emit a stable diagnostic that cannot contain prompts or responses.
    if (message.includes("error; no more retries left")) {
      logEvent({
        event: "openai_retries_exhausted",
        outcome: "error",
        reason: "retry_budget_exhausted",
        count: OPENAI_MAX_RETRIES + 1,
      });
    }
  },
  debug() {},
};

let client: OpenAI | null = null;

export function openai(): OpenAI {
  if (!hasCredentials()) throw new MissingCredentialsError();
  client ??= new OpenAI({
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
    logger: sdkLogger,
    logLevel: "info",
  });
  return client;
}

/** Log configuration without constructing a client or requiring credentials. */
export function logResolvedModelOnce(): void {
  if (globalForOpenAI.zeusResolvedOpenAIModelLogged) return;
  globalForOpenAI.zeusResolvedOpenAIModelLogged = true;
  logEvent({ event: "startup", outcome: "ok", model: MODEL });
}

export function hasCredentials(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export class MissingCredentialsError extends Error {
  constructor() {
    super("No OpenAI credentials found. Set OPENAI_API_KEY in .env.local.");
    this.name = "MissingCredentialsError";
  }
}

export class RefusedError extends Error {
  constructor(explanation?: string | null) {
    super(explanation?.trim() || "OpenAI declined this request.");
    this.name = "RefusedError";
  }
}

/** Turn response-level failures into explicit errors before callers read output. */
export function assertResponseComplete(response: Response): void {
  for (const item of response.output) {
    if (item.type !== "message") continue;
    const refusal = item.content.find((content) => content.type === "refusal");
    if (refusal?.type === "refusal") throw new RefusedError(refusal.refusal);
  }

  if (response.status && response.status !== "completed") {
    const detail =
      response.error?.message ??
      response.incomplete_details?.reason ??
      `response ended with status ${response.status}`;
    throw new Error(`OpenAI ${detail}.`);
  }
}

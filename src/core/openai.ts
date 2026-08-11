import OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";

/**
 * The single OpenAI client. Constructed lazily so the store, tests, and curation
 * UI continue to work without credentials; only model-backed paths require a key.
 */
export const MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5.5";

let client: OpenAI | null = null;

export function openai(): OpenAI {
  if (!hasCredentials()) throw new MissingCredentialsError();
  client ??= new OpenAI();
  return client;
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

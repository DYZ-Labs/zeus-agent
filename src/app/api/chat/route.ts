import { z } from "zod";

import { BUDGET_MESSAGES, checkModelBudget, logBudgetDenial } from "@/core/budget";
import { streamTurn } from "@/core/chat";
import { createConversation, getConversation } from "@/core/conversations";
import type { Db } from "@/core/db";
import { errorSignature, logEvent } from "@/core/observability";
import { MissingCredentialsError, RefusedError, hasCredentials } from "@/core/openai";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 32_768;

const Body = z
  .object({
    input: z.string().trim().min(1).max(4_000),
    conversationId: z.number().int().nullable().optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isIanaTimezone, "Expected an IANA timezone")
      .optional(),
  })
  .strict();

/**
 * Streams a turn as newline-delimited JSON events:
 *   {"type":"meta","conversationId":N}
 *   {"type":"delta","text":"..."}
 *   {"type":"done","accepted":N,"pending":N,"recalled":N}
 *   {"type":"error","message":"..."}
 *
 * NDJSON rather than SSE because the client is our own fetch reader, and the terminal
 * "done" frame carries what Zeus learned — which the UI shows so the user can see the
 * memory changing rather than having to trust that it did.
 */
export async function POST(request: Request): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-mutation");
  if (!access.canAccessPrivateData) {
    return Response.json(
      { error: access.message },
      {
        status:
          access.state === "signed_out"
            ? 401
            : access.state === "wrong_account" || access.state === "forbidden_origin"
              ? 403
              : 503,
      },
    );
  }

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  const parsed = Body.safeParse(await boundedJson(request));
  if (!parsed.success) {
    return Response.json(
      { error: "Expected a message up to 4,000 characters and an optional conversation id." },
      { status: 400 },
    );
  }

  if (!hasCredentials()) {
    return Response.json({ error: new MissingCredentialsError().message }, { status: 503 });
  }

  const db = access.db;
  // Refuse before any model work, not after: the point of the ceiling is that the
  // request that exceeds it costs nothing.
  const budget = checkModelBudget(db);
  if (!budget.allowed) {
    logBudgetDenial("/api/chat", budget);
    return budgetResponse(budget);
  }

  const conversation =
    (parsed.data.conversationId ? getConversation(db, parsed.data.conversationId) : null) ??
    createConversation(db, { source: "web" });

  return privateChatResponse(
    db,
    conversation.id,
    parsed.data.input,
    request.signal,
    parsed.data.timezone,
  );
}

function privateChatResponse(
  db: Db,
  conversationId: number,
  input: string,
  requestSignal: AbortSignal,
  timezone?: string,
): Response {
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const turnAbort = new AbortController();
  let cancelled = false;
  const abortFromRequest = () => turnAbort.abort(requestSignal.reason);
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (cancelled || turnAbort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          cancelled = true;
          turnAbort.abort();
        }
      };

      send({ type: "meta", conversationId });

      try {
        const result = await streamTurn(db, {
          conversationId,
          input,
          timezone,
          onDelta: (text) => send({ type: "delta", text }),
          signal: turnAbort.signal,
        });

        send({
          type: "done",
          messageId: result.message.id,
          recalled: result.context.items.length,
          recalledFacts: result.context.items.filter((item) => item.kind === "fact").length,
          recalledEpisodes: result.context.items.filter((item) => item.kind === "episode").length,
          recalledFacets: result.context.items.filter((item) => item.kind === "facet").length,
          accepted:
            (result.learned?.facts.length ?? 0) +
            (result.learned?.goals.length ?? 0) +
            (result.learned?.commitments.length ?? 0) +
            (result.learned?.projects.length ?? 0) +
            (result.learned?.facets.length ?? 0),
          acceptedFacets: result.learned?.facets.length ?? 0,
          learned: result.learned?.facts.length ?? 0,
          goalsUpdated: result.learned?.goals.length ?? 0,
          commitmentsUpdated: result.learned?.commitments.length ?? 0,
          projectsUpdated: result.learned?.projects.length ?? 0,
          pending: result.learned?.candidates.length ?? 0,
          pendingFacets:
            result.learned?.candidates.filter(
              (candidate) => candidate.kind === "facet" && candidate.status === "pending",
            ).length ?? 0,
          superseded: result.learned?.supersededIds.length ?? 0,
          recommendation: result.context.recommendation,
          opportunityId: result.context.recommendation
            ? result.context.opportunityId
            : null,
          workPlan: result.work
            ? {
                id: result.work.planId,
                runId: result.work.run.id,
                status: result.work.run.status,
                errorCode: result.work.run.error_code,
                artifacts: result.work.artifacts.map((artifact) => ({
                  id: artifact.id,
                  title: artifact.title,
                  kind: artifact.kind,
                })),
                pendingEffects: result.work.pendingEffects.map((effect) => ({
                  id: effect.id,
                  previewText: effect.preview_text,
                  payload: effect.payload,
                  payloadHash: effect.payload_hash,
                  expiresAt: effect.expires_at,
                  capabilitySlot: effect.capability.slot,
                  connectorLabel: effect.connector.label,
                })),
                completedEffects: result.work.completedEffects.map((effect) => ({
                  id: effect.id,
                  previewText: effect.preview_text,
                  connectorLabel: effect.connector.label,
                  authorizedByPolicy: effect.confirmation_kind === "standing_policy",
                  reversible: effect.reversal !== null,
                })),
                calendar: result.work.calendarOutcome,
              }
            : null,
          extractionFailed: result.learned === null,
        });
      } catch (error) {
        if (!turnAbort.signal.aborted) {
          // The message goes to the person whose memory it is; the log gets only the
          // error's class and code location.
          logEvent({
            event: "chat_turn",
            outcome: "error",
            reason: error instanceof RefusedError ? "model_refused" : "turn_failed",
            conversation_id: conversationId,
            duration_ms: Date.now() - startedAt,
            ...errorSignature(error),
          });
          send({
            type: "error",
            message:
              error instanceof RefusedError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : "Something went wrong.",
          });
        }
      } finally {
        requestSignal.removeEventListener("abort", abortFromRequest);
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // The browser may have cancelled while OpenAI was stopping.
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      turnAbort.abort();
    },
  });

  return new Response(stream, { headers: streamHeaders() });
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function budgetResponse(
  decision: Extract<ReturnType<typeof checkModelBudget>, { allowed: false }>,
): Response {
  return Response.json(
    { error: BUDGET_MESSAGES[decision.reason], retryAfterSeconds: decision.retryAfterSeconds },
    {
      status: 429,
      headers: {
        "Retry-After": String(decision.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}

function streamHeaders(): HeadersInit {
  return {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

async function boundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

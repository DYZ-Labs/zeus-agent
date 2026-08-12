import { z } from "zod";

import { streamTurn } from "@/core/chat";
import { createConversation, getConversation } from "@/core/conversations";
import type { Db } from "@/core/db";
import { streamGuestTurn, type GuestChatMessage } from "@/core/guest-chat";
import { MissingCredentialsError, RefusedError, hasCredentials } from "@/core/openai";
import { getOwnerAccess } from "@/server/auth/access";
import {
  acquireChatVerification,
  acquireGuestChat,
} from "@/server/guest-chat-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 32_768;

const GuestHistoryMessage = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();

const Body = z
  .object({
    input: z.string().trim().min(1).max(4_000),
    conversationId: z.number().int().nullable().optional(),
    history: z.array(GuestHistoryMessage).max(20).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const historyLength = value.history?.reduce((total, message) => total + message.content.length, 0) ?? 0;
    if (historyLength > 20_000) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "Guest chat history is too long.",
      });
    }
  });

/**
 * Streams a turn as newline-delimited JSON events:
 *   {"type":"meta","conversationId":N}
 *   {"type":"delta","text":"..."}
 *   {"type":"done","accepted":N,"pending":N,"recalled":N}
 *   {"type":"done","guest":true}
 *   {"type":"error","message":"..."}
 *
 * NDJSON rather than SSE because the client is our own fetch reader, and the terminal
 * "done" frame carries what Zeus learned — which the UI shows so the user can see the
 * memory changing rather than having to trust that it did.
 */
export async function POST(request: Request): Promise<Response> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  const parsed = Body.safeParse(await boundedJson(request));
  if (!parsed.success) {
    return Response.json(
      { error: "Expected a message up to 4,000 characters and an optional bounded history." },
      { status: 400 },
    );
  }

  if (!hasCredentials()) {
    return Response.json({ error: new MissingCredentialsError().message }, { status: 503 });
  }

  const verificationLease = acquireChatVerification();
  if (!verificationLease.allowed) {
    return Response.json(
      { error: "Chat is busy. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(verificationLease.retryAfterSeconds) },
      },
    );
  }

  const access = await getOwnerAccess().finally(() => verificationLease.release());
  if (!access.canAccessPrivateData) {
    if (access.state !== "signed_out") {
      return Response.json(
        { error: access.message },
        { status: access.state === "wrong_account" ? 403 : 503 },
      );
    }

    const lease = acquireGuestChat();
    if (!lease.allowed) {
      return Response.json(
        { error: "Guest chat is busy. Try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(lease.retryAfterSeconds) },
        },
      );
    }
    return guestChatResponse(
      parsed.data.input,
      parsed.data.history ?? [],
      request.signal,
      lease.release,
    );
  }

  const db = access.db;
  const conversation =
    (parsed.data.conversationId ? getConversation(db, parsed.data.conversationId) : null) ??
    createConversation(db, { source: "web" });

  return privateChatResponse(
    db,
    conversation.id,
    parsed.data.input,
    request.signal,
  );
}

function privateChatResponse(
  db: Db,
  conversationId: number,
  input: string,
  requestSignal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
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
            (result.learned?.facets.length ?? 0),
          acceptedFacets: result.learned?.facets.length ?? 0,
          learned: result.learned?.facts.length ?? 0,
          goalsUpdated: result.learned?.goals.length ?? 0,
          commitmentsUpdated: result.learned?.commitments.length ?? 0,
          pending: result.learned?.candidates.length ?? 0,
          pendingFacets:
            result.learned?.candidates.filter(
              (candidate) => candidate.kind === "facet" && candidate.status === "pending",
            ).length ?? 0,
          superseded: result.learned?.supersededIds.length ?? 0,
          recommendation: result.context.recommendation,
          extractionFailed: result.learned === null,
        });
      } catch (error) {
        if (!turnAbort.signal.aborted) {
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

function guestChatResponse(
  input: string,
  history: readonly GuestChatMessage[],
  requestSignal: AbortSignal,
  release: () => void,
): Response {
  const encoder = new TextEncoder();
  const guestAbort = new AbortController();
  let cancelled = false;
  let released = false;

  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const abortFromRequest = () => guestAbort.abort(requestSignal.reason);
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (cancelled || guestAbort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          cancelled = true;
          guestAbort.abort();
        }
      };

      try {
        await streamGuestTurn({
          input,
          history,
          onDelta: (text) => send({ type: "delta", text }),
          signal: guestAbort.signal,
        });
        send({ type: "done", guest: true });
      } catch (error) {
        if (!guestAbort.signal.aborted) {
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
        releaseOnce();
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // The browser may have cancelled the response while OpenAI was stopping.
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      guestAbort.abort();
    },
  });

  return new Response(stream, { headers: streamHeaders() });
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

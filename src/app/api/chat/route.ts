import { z } from "zod";

import { ChatMode } from "@/core/contracts";
import { streamTurn } from "@/core/chat";
import { createConversation, getConversation } from "@/core/conversations";
import type { Db } from "@/core/db";
import { getExperienceSettings } from "@/core/experience";
import { EXTRACTION_PROMPT_VERSION } from "@/core/extract";
import { streamGuestTurn, type GuestChatMessage } from "@/core/guest-chat";
import { createMemoryJob } from "@/core/memory-jobs";
import { RefusedError, hasCredentials } from "@/core/openai";
import { blockMessageRecall } from "@/core/passages";
import { numericResourceId, resourceId } from "@/core/resource-id";
import { getBrowserOwnerAccess, verifyStoreFreeChatAccess } from "@/server/auth/access";
import {
  acquireChatVerification,
  acquireGuestChat,
} from "@/server/guest-chat-limit";
import { wakeMemoryJobRunner } from "@/server/memory-job-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_REQUEST_BYTES = 32_768;

const TemporaryHistoryMessage = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4_000),
  })
  .strict();

const Body = z
  .object({
    input: z.string().trim().min(1).max(4_000),
    conversationId: z.string().trim().min(3).max(120).nullable().optional(),
    mode: ChatMode.default("standard"),
    temporaryHistory: z.array(TemporaryHistoryMessage).max(20).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const historyLength =
      value.temporaryHistory?.reduce(
        (total, message) => total + message.content.length,
        0,
      ) ?? 0;
    if (historyLength > 20_000) {
      context.addIssue({
        code: "custom",
        path: ["temporaryHistory"],
        message: "Temporary chat history is too long.",
      });
    }
    if (value.mode === "temporary" && value.conversationId != null) {
      context.addIssue({
        code: "custom",
        path: ["conversationId"],
        message: "Temporary chat cannot use a saved conversation.",
      });
    }
    if (value.mode === "standard" && value.temporaryHistory !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["temporaryHistory"],
        message: "Saved chat cannot accept browser-supplied history.",
      });
    }
  });

/** Streams newline-delimited protocol events defined by the consumer chat contract. */
export async function POST(request: Request): Promise<Response> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json(
      { error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  const parsed = Body.safeParse(await boundedJson(request));
  if (!parsed.success) {
    return Response.json(
      {
        error:
          "Expected a message up to 4,000 characters, a chat mode, and only temporary browser history.",
      },
      { status: 400 },
    );
  }

  if (!hasCredentials()) {
    return Response.json(
      { error: "Chat is temporarily unavailable." },
      { status: 503 },
    );
  }

  // The temporary path intentionally performs no owner lookup and never opens the
  // process-wide store. This property is stronger than merely "no writes".
  if (parsed.data.mode === "temporary") {
    const access = await verifyStoreFreeChatAccess(request);
    if (!access.allowed) {
      return Response.json(
        { error: access.message },
        {
          status:
            access.state === "wrong_account" ||
            access.state === "forbidden_origin"
              ? 403
              : 503,
        },
      );
    }
    return acquireTemporaryChat(
      parsed.data.input,
      parsed.data.temporaryHistory ?? [],
      request.signal,
    );
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

  const access = await getBrowserOwnerAccess(request, "private-mutation").finally(
    () => verificationLease.release(),
  );
  if (!access.canAccessPrivateData) {
    return Response.json(
      { error: access.message },
      {
        status:
          access.state === "signed_out"
            ? 401
            : access.state === "wrong_account" ||
                access.state === "forbidden_origin"
              ? 403
              : 503,
      },
    );
  }

  const db = access.db;
  const requestedConversationId = parsed.data.conversationId
    ? numericResourceId(parsed.data.conversationId, "conversation")
    : null;
  if (parsed.data.conversationId != null && requestedConversationId === null) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  const requestedConversation = requestedConversationId
    ? getConversation(db, requestedConversationId)
    : null;
  if (parsed.data.conversationId != null && !requestedConversation) {
    return Response.json({ error: "Conversation not found." }, { status: 404 });
  }
  const conversation =
    requestedConversation ?? createConversation(db, { source: "web" });
  const experience = getExperienceSettings(db);

  return privateChatResponse(
    db,
    conversation.id,
    parsed.data.input,
    experience.rememberingMode,
    experience.labsEnabled,
    request.signal,
  );
}

function privateChatResponse(
  db: Db,
  conversationId: number,
  input: string,
  rememberingMode: "automatic" | "confirm" | "off",
  labsEnabled: boolean,
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

      send({
        type: "conversation",
        conversationId: resourceId("conversation", conversationId),
      });

      try {
        const result = await streamTurn(db, {
          conversationId,
          input,
          rememberingMode,
          labsEnabled,
          onDelta: (text) => send({ type: "text_delta", text }),
          signal: turnAbort.signal,
        });

        let memoryJobId: string | null = null;
        let memoryError: string | null = null;
        if (rememberingMode !== "off") {
          try {
            memoryJobId = createMemoryJob(db, {
                conversationId,
                sourceMessageId: result.userMessage.id,
                assistantMessageId: result.message.id,
                promptVersion: EXTRACTION_PROMPT_VERSION,
                rememberingMode,
              }).id;
            wakeMemoryJobRunner(db);
          } catch (error) {
            memoryError = "Memory could not be updated.";
            try {
              blockMessageRecall(db, result.userMessage.id);
            } catch {
              // The answer remains valid even if the local memory store is degraded.
            }
            console.warn(
              `[zeus] memory job could not be created (${error instanceof Error ? error.name : "memory_job_error"})`,
            );
          }
        }

        // This event closes answer generation. The server runner owns the durable job,
        // so the browser can unlock its composer immediately and may safely disappear.
        send({
          type: "response_complete",
          responseId: resourceId("message", result.message.id),
          memoryJobId,
          memoryError,
          recalled: result.context?.items.length ?? 0,
        });
      } catch (error) {
        if (!turnAbort.signal.aborted) {
          send({
            type: "error",
            message: error instanceof RefusedError
              ? "I couldn’t answer that request."
              : "Zeus couldn’t finish that answer. Try again.",
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

function acquireTemporaryChat(
  input: string,
  history: readonly GuestChatMessage[],
  requestSignal: AbortSignal,
): Response {
  const lease = acquireGuestChat();
  if (!lease.allowed) {
    return Response.json(
      { error: "Temporary chat is busy. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(lease.retryAfterSeconds) },
      },
    );
  }
  return temporaryChatResponse(input, history, requestSignal, lease.release);
}

function temporaryChatResponse(
  input: string,
  history: readonly GuestChatMessage[],
  requestSignal: AbortSignal,
  release: () => void,
): Response {
  const encoder = new TextEncoder();
  const temporaryAbort = new AbortController();
  let cancelled = false;
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const abortFromRequest = () => temporaryAbort.abort(requestSignal.reason);
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (cancelled || temporaryAbort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          cancelled = true;
          temporaryAbort.abort();
        }
      };

      try {
        await streamGuestTurn({
          input,
          history,
          onDelta: (text) => send({ type: "text_delta", text }),
          signal: temporaryAbort.signal,
        });
        send({
          type: "response_complete",
          responseId: null,
          memoryJobId: null,
          memoryError: null,
        });
      } catch (error) {
        if (!temporaryAbort.signal.aborted) {
          send({
            type: "error",
            message: error instanceof RefusedError
              ? "I couldn’t answer that request."
              : "Zeus couldn’t finish that answer. Try again.",
          });
        }
      } finally {
        requestSignal.removeEventListener("abort", abortFromRequest);
        releaseOnce();
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
      temporaryAbort.abort();
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

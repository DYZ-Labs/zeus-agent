import { z } from "zod";

import { streamTurn } from "@/core/chat";
import { createConversation, getConversation } from "@/core/conversations";
import { MissingCredentialsError, RefusedError, hasCredentials } from "@/core/openai";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    input: z.string().min(1),
    conversationId: z.number().int().nullable().optional(),
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

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Expected { input: string, conversationId?: number }" }, { status: 400 });
  }

  if (!hasCredentials()) {
    return Response.json({ error: new MissingCredentialsError().message }, { status: 503 });
  }

  const db = access.db;
  const conversation =
    (parsed.data.conversationId ? getConversation(db, parsed.data.conversationId) : null) ??
    createConversation(db, { source: "web" });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      send({ type: "meta", conversationId: conversation.id });

      try {
        const result = await streamTurn(db, {
          conversationId: conversation.id,
          input: parsed.data.input,
          onDelta: (text) => send({ type: "delta", text }),
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
              }
            : null,
          extractionFailed: result.learned === null,
        });
      } catch (error) {
        send({
          type: "error",
          message:
            error instanceof RefusedError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Something went wrong.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

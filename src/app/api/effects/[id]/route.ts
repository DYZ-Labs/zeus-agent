import { z } from "zod";

import {
  confirmEffect,
  declineEffect,
  executeConfirmedEffect,
  getProposedEffect,
  revertEffect,
} from "@/core/effects";
import { appendMessage, createConversation, listConversations } from "@/core/conversations";
import { createSafeWorkExecutor } from "@/core/work-execution";
import { resumeWorkRun } from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";
import type { Db } from "@/core/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Deciding one external request from the conversation it came from.
 *
 * The server actions on `/today` do the same work, but they can only report back by
 * revalidating a page — which does nothing for a chat card holding its turns in client
 * state. That is why confirming in chat used to leave the button sitting there as though
 * nothing had happened. This returns the result instead, so the card can say what became of
 * the request without the user leaving the thread to find out.
 */
const Body = z
  .object({
    action: z.enum(["confirm", "decline", "revert"]),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-mutation");
  if (!access.canAccessPrivateData) {
    return Response.json({ error: access.message }, { status: 403 });
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "Unknown external request." }, { status: 404 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Unrecognized action." }, { status: 400 });
  }
  const effect = getProposedEffect(access.db, id);
  if (!effect) return Response.json({ error: "Unknown external request." }, { status: 404 });

  try {
    if (parsed.data.action === "revert") {
      if (effect.status !== "executed") {
        return Response.json({ error: "Only a completed change can be undone." }, { status: 409 });
      }
      const source = decisionMessage(access.db, `Undo this external change: ${effect.preview_text}`);
      await revertEffect(access.db, id, source.id);
      return Response.json({ effect: getProposedEffect(access.db, id), outcome: "reverted" });
    }

    if (effect.status !== "pending_confirmation") {
      return Response.json({ error: "That request has already been decided." }, { status: 409 });
    }

    if (parsed.data.action === "decline") {
      const source = decisionMessage(
        access.db,
        `Do not send this external request: ${effect.preview_text}`,
      );
      declineEffect(access.db, id, source.id);
      return Response.json({ effect: getProposedEffect(access.db, id), outcome: "declined" });
    }

    if (parsed.data.payloadHash !== effect.payload_hash) {
      return Response.json({ error: "That confirmation does not match this request." }, { status: 409 });
    }
    // The decision is the first line, so nothing echoed back from the payload can change
    // how it reads; the description follows as the record of what was agreed to.
    const source = decisionMessage(
      access.db,
      `I confirm external request ${effect.payload_hash}.\n${effect.preview_text}`,
    );
    confirmEffect(access.db, id, effect.payload_hash, source.id);
    const result = await executeConfirmedEffect(access.db, id);
    if (result.status === "executed") {
      await resumeWorkRun(access.db, effect.work_run_id, {
        executor: createSafeWorkExecutor(access.db),
      }).catch(() => undefined);
    }
    return Response.json({
      effect: getProposedEffect(access.db, id),
      outcome: result.status,
      errorCode: result.errorCode,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "That action could not be completed." },
      { status: 409 },
    );
  }
}

/** A real, stored user message, written into the same thread the server actions use. */
function decisionMessage(db: Db, content: string) {
  const conversation =
    listConversations(db, 100).find((entry) => entry.title === "Memory curation") ??
    createConversation(db, { title: "Memory curation", source: "web" });
  return appendMessage(db, conversation.id, "user", content, {
    origin: "user_action",
    recallState: "blocked",
  });
}

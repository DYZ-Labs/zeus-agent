import { z } from "zod";

import { appendMessage, createConversation, listConversations } from "@/core/conversations";
import { EffectKind, IsoDateTime } from "@/core/schema";
import { authorizeWorkPlan, getWorkPlan } from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    planHash: z.string().length(64),
    allowedEffects: z.array(EffectKind).min(1),
    maxModelToolCalls: z.number().int().min(1).max(20),
    maxRetriesPerStep: z.number().int().min(0).max(2),
    maxDurationSeconds: z.number().int().min(1).max(900),
    expiresAt: IsoDateTime,
    userInstruction: z.string().trim().min(1).max(2000),
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
  const planId = Number((await params).id);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!Number.isInteger(planId) || planId <= 0 || !parsed.success) {
    return Response.json({ error: "Invalid exact authorization." }, { status: 400 });
  }
  if (!getWorkPlan(access.db, planId)) {
    return Response.json({ error: "Work plan not found." }, { status: 404 });
  }
  try {
    const conversation =
      listConversations(access.db, 500).find(
        (entry) => entry.source === "web" && entry.title === "Work requests",
      ) ?? createConversation(access.db, { title: "Work requests", source: "web" });
    const source = appendMessage(
      access.db,
      conversation.id,
      "user",
      parsed.data.userInstruction,
      { origin: "user_action", recallState: "blocked" },
    );
    const authorization = authorizeWorkPlan(access.db, planId, {
      planHash: parsed.data.planHash,
      authorizationKind: "user_approval",
      allowedEffects: parsed.data.allowedEffects,
      maxModelToolCalls: parsed.data.maxModelToolCalls,
      maxRetriesPerStep: parsed.data.maxRetriesPerStep,
      maxDurationSeconds: parsed.data.maxDurationSeconds,
      expiresAt: parsed.data.expiresAt,
      sourceMessageId: source.id,
    });
    return Response.json({ authorization });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Authorization failed." },
      { status: 409 },
    );
  }
}

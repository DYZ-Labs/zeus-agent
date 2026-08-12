import { z } from "zod";

import {
  appendMessage,
  createConversation,
  listConversations,
} from "@/core/conversations";
import { generateWorkPlanProposal } from "@/core/work-execution";
import {
  authorizeWorkPlan,
  createWorkPlan,
  listWorkPlans,
} from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    objective: z.string().trim().min(1).max(2000),
    sourceGoalId: z.number().int().positive().nullable().optional(),
    sourceCommitmentId: z.number().int().positive().nullable().optional(),
    sourceProjectId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-read");
  if (!access.canAccessPrivateData) return denied(access);
  return Response.json({ plans: listWorkPlans(access.db, { includeClosed: true, limit: 100 }) });
}

export async function POST(request: Request): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-mutation");
  if (!access.canAccessPrivateData) return denied(access);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Expected a bounded work objective." }, { status: 400 });
  }

  try {
    const conversation =
      listConversations(access.db, 500).find(
        (entry) => entry.source === "web" && entry.title === "Work requests",
      ) ?? createConversation(access.db, { title: "Work requests", source: "web" });
    const source = appendMessage(access.db, conversation.id, "user", parsed.data.objective, {
      origin: "user_action",
      recallState: "blocked",
    });
    const generated = await generateWorkPlanProposal(access.db, parsed.data.objective);
    const proposal = generated.proposal;
    const detail = createWorkPlan(access.db, {
      proposal,
      sourceMessageId: source.id,
      sourceGoalId: parsed.data.sourceGoalId ?? null,
      sourceCommitmentId: parsed.data.sourceCommitmentId ?? null,
      sourceProjectId: parsed.data.sourceProjectId ?? null,
      origin: "explicit_request",
      generationProvenance: generated.provenance,
    });
    const authorization = authorizeWorkPlan(access.db, detail.plan.id, {
      planHash: detail.plan.plan_hash,
      authorizationKind: "explicit_request",
      allowedEffects: proposal.allowed_effects,
      maxModelToolCalls: detail.plan.max_model_tool_calls,
      maxRetriesPerStep: detail.plan.max_retries_per_step,
      maxDurationSeconds: detail.plan.max_duration_seconds,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      sourceMessageId: source.id,
    });
    return Response.json(
      { ...detail, authorization, status: "authorized" },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create the work plan." },
      { status: 422 },
    );
  }
}

function denied(access: Awaited<ReturnType<typeof getBrowserOwnerAccess>>): Response {
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

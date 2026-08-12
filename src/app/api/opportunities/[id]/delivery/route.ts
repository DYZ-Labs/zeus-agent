import { z } from "zod";

import { getRecommendationCycle, markOpportunityDelivered } from "@/core/stewardship";
import { numericResourceId } from "@/core/resource-id";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    channel: z.enum(["chat", "today"]),
    responseMessageId: z.string().trim().min(3).max(120).nullable().optional(),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const opportunityId = numericResourceId((await params).id, "opportunity");
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (opportunityId === null || !parsed.success) {
    return Response.json({ error: "Invalid opportunity delivery receipt." }, { status: 400 });
  }
  const responseMessageId = parsed.data.responseMessageId
    ? numericResourceId(parsed.data.responseMessageId, "message")
    : null;
  if (parsed.data.responseMessageId && responseMessageId === null) {
    return Response.json({ error: "Invalid opportunity delivery receipt." }, { status: 400 });
  }
  if (!getRecommendationCycle(access.db, opportunityId)) {
    return Response.json({ error: "Opportunity not found." }, { status: 404 });
  }
  const delivery = markOpportunityDelivered(
    access.db,
    opportunityId,
    parsed.data.channel,
    responseMessageId,
  );
  if (!delivery) {
    return Response.json({ error: "Opportunity has no deliverable recommendation." }, { status: 409 });
  }
  return Response.json({ ok: true });
}

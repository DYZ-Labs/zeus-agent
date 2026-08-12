import { z } from "zod";

import { getCommitment } from "@/core/intentions";
import { recordFollowThroughDecision } from "@/core/stewardship";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    commitmentId: z.number().int().positive(),
    decision: z.enum(["accepted", "dismissed", "snoozed", "completed", "regretted"]),
    responseMessageId: z.number().int().positive().nullable().optional(),
    userReason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

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
    return Response.json(
      { error: "Expected a commitment id and follow-through decision." },
      { status: 400 },
    );
  }

  const db = access.db;
  if (!getCommitment(db, parsed.data.commitmentId)) {
    return Response.json({ error: "That commitment no longer exists." }, { status: 404 });
  }
  const event = recordFollowThroughDecision(db, {
    commitmentId: parsed.data.commitmentId,
    decision: parsed.data.decision,
    responseMessageId: parsed.data.responseMessageId ?? null,
    userReason: parsed.data.userReason ?? null,
  });
  if (!event) {
    return Response.json({ error: "That recommendation is no longer actionable." }, { status: 409 });
  }

  return Response.json({ ok: true, eventId: event.id, decision: event.event_type });
}

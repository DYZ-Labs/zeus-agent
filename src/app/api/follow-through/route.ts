import { z } from "zod";

import { getCommitment } from "@/core/intentions";
import {
  recordFollowThroughDecision,
  recordFollowThroughFeedback,
} from "@/core/stewardship";
import { numericResourceId } from "@/core/resource-id";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    commitmentId: z.string().trim().min(3).max(120),
    decision: z.enum(["accepted", "dismissed", "snoozed", "completed", "regretted"]),
    responseMessageId: z.string().trim().min(3).max(120).nullable().optional(),
    userReason: z.string().trim().min(1).max(1000).optional(),
    feedbackOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.feedbackOnly === true &&
      (!value.userReason || !["snoozed", "dismissed"].includes(value.decision))
    ) {
      context.addIssue({
        code: "custom",
        path: ["feedbackOnly"],
        message: "Feedback must follow a saved Later or Not relevant choice.",
      });
    }
  });

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
  const commitmentId = numericResourceId(parsed.data.commitmentId, "commitment");
  const responseMessageId = parsed.data.responseMessageId
    ? numericResourceId(parsed.data.responseMessageId, "message")
    : null;
  if (commitmentId === null || (parsed.data.responseMessageId && responseMessageId === null)) {
    return Response.json({ error: "That recommendation is no longer actionable." }, { status: 404 });
  }
  if (!getCommitment(db, commitmentId)) {
    return Response.json({ error: "That commitment no longer exists." }, { status: 404 });
  }
  const event = parsed.data.feedbackOnly === true
    ? recordFollowThroughFeedback(db, {
        commitmentId,
        decision: parsed.data.decision as "snoozed" | "dismissed",
        userReason: parsed.data.userReason ?? "",
      })
    : recordFollowThroughDecision(db, {
        commitmentId,
        decision: parsed.data.decision,
        responseMessageId,
        userReason: parsed.data.userReason ?? null,
      });
  if (!event) {
    return Response.json({ error: "That recommendation is no longer actionable." }, { status: 409 });
  }

  return Response.json({ ok: true, decision: event.event_type });
}

import { z } from "zod";

import {
  cancelWorkPlan,
  getWorkPlan,
  listToolReceipts,
  listWorkArtifacts,
  listWorkRuns,
} from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.coerce.number().int().positive();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-read");
  if (!access.canAccessPrivateData) return denied(access);
  const id = Params.safeParse((await params).id);
  if (!id.success) return Response.json({ error: "Invalid plan id." }, { status: 400 });
  const detail = getWorkPlan(access.db, id.data);
  if (!detail) return Response.json({ error: "Work plan not found." }, { status: 404 });
  const runs = listWorkRuns(access.db, id.data);
  return Response.json({
    ...detail,
    runs,
    artifacts: listWorkArtifacts(access.db, { planId: id.data }),
    receipts: runs[0] ? listToolReceipts(access.db, runs[0].id) : [],
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-mutation");
  if (!access.canAccessPrivateData) return denied(access);
  const id = Params.safeParse((await params).id);
  if (!id.success) return Response.json({ error: "Invalid plan id." }, { status: 400 });
  const detail = cancelWorkPlan(access.db, id.data);
  return detail
    ? Response.json({ ok: true, ...detail })
    : Response.json({ error: "Work plan not found." }, { status: 404 });
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

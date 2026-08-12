import { createSafeWorkExecutor } from "@/core/work-execution";
import { getWorkPlan, resumeWorkRun, runWorkPlan } from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";
import { labsEnabled, labsUnavailableResponse } from "@/server/labs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-mutation");
  if (!access.canAccessPrivateData) {
    return Response.json({ error: access.message }, { status: 403 });
  }
  if (!labsEnabled(access.db)) return labsUnavailableResponse();
  const planId = Number((await params).id);
  if (!Number.isInteger(planId) || planId <= 0) {
    return Response.json({ error: "Invalid plan id." }, { status: 400 });
  }
  const detail = getWorkPlan(access.db, planId);
  if (!detail) return Response.json({ error: "Work plan not found." }, { status: 404 });
  try {
    const executor = createSafeWorkExecutor(access.db);
    const run = detail.latestRun && detail.authorization?.id === detail.latestRun.authorization_id &&
        ["queued", "running", "paused"].includes(detail.latestRun.status)
      ? await resumeWorkRun(access.db, detail.latestRun.id, { executor })
      : await runWorkPlan(access.db, planId, { executor });
    return Response.json({ run, plan: getWorkPlan(access.db, planId) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Work run failed." },
      { status: 409 },
    );
  }
}

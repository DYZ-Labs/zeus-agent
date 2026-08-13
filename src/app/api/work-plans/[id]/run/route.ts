import { BUDGET_MESSAGES, checkModelBudget, logBudgetDenial } from "@/core/budget";
import { acquireWorkRunSlot } from "@/core/concurrency";
import { createSafeWorkExecutor } from "@/core/work-execution";
import { getWorkPlan, resumeWorkRun, runWorkPlan } from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";

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
  const planId = Number((await params).id);
  if (!Number.isInteger(planId) || planId <= 0) {
    return Response.json({ error: "Invalid plan id." }, { status: 400 });
  }
  const detail = getWorkPlan(access.db, planId);
  if (!detail) return Response.json({ error: "Work plan not found." }, { status: 404 });

  // A run can make up to 20 model calls, so check the ceiling before starting one
  // rather than discovering it partway through and pausing a half-finished run.
  const budget = checkModelBudget(access.db);
  if (!budget.allowed) {
    logBudgetDenial("/api/work-plans/[id]/run", budget);
    return Response.json(
      { error: BUDGET_MESSAGES[budget.reason], retryAfterSeconds: budget.retryAfterSeconds },
      {
        status: 429,
        headers: {
          "Retry-After": String(budget.retryAfterSeconds),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // A run holds this request for up to 900 seconds. Without a cap, a few of them
  // occupy the single Node process and every chat turn queues behind them.
  const releaseSlot = acquireWorkRunSlot();
  if (!releaseSlot) {
    return Response.json(
      {
        error:
          "Zeus is already running as much bounded work as it can at once. " +
          "The run is still authorized; start it again shortly.",
        retryAfterSeconds: 30,
      },
      {
        status: 429,
        headers: { "Retry-After": "30", "Cache-Control": "no-store" },
      },
    );
  }

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
  } finally {
    releaseSlot();
  }
}

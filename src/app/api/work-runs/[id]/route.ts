import { z } from "zod";

import { createSafeWorkExecutor } from "@/core/work-execution";
import {
  cancelWorkRun,
  getWorkRun,
  listToolReceipts,
  listWorkArtifacts,
  resumeWorkRun,
} from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";
import { labsEnabled, labsUnavailableResponse } from "@/server/labs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const Body = z.object({ action: z.enum(["resume", "cancel"]) }).strict();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-read");
  if (!access.canAccessPrivateData) return Response.json({ error: access.message }, { status: 403 });
  if (!labsEnabled(access.db)) return labsUnavailableResponse();
  const runId = Number((await params).id);
  const run = Number.isInteger(runId) ? getWorkRun(access.db, runId) : null;
  if (!run) return Response.json({ error: "Work run not found." }, { status: 404 });
  return Response.json({
    run,
    artifacts: listWorkArtifacts(access.db, { runId }),
    receipts: listToolReceipts(access.db, runId),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-mutation");
  if (!access.canAccessPrivateData) return Response.json({ error: access.message }, { status: 403 });
  if (!labsEnabled(access.db)) return labsUnavailableResponse();
  const runId = Number((await params).id);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!Number.isInteger(runId) || runId <= 0 || !parsed.success) {
    return Response.json({ error: "Invalid work-run action." }, { status: 400 });
  }
  try {
    const run = parsed.data.action === "cancel"
      ? cancelWorkRun(access.db, runId)
      : await resumeWorkRun(access.db, runId, {
          executor: createSafeWorkExecutor(access.db),
        });
    return run
      ? Response.json({ run })
      : Response.json({ error: "Work run not found." }, { status: 404 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Work-run action failed." },
      { status: 409 },
    );
  }
}

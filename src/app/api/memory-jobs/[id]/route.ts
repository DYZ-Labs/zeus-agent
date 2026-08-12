import { getMemoryJob } from "@/core/memory-jobs";
import { getBrowserOwnerAccess } from "@/server/auth/access";
import { wakeMemoryJobRunner } from "@/server/memory-job-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-read");
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

  const { id } = await context.params;
  if (!validJobId(id)) return Response.json({ error: "Memory job not found." }, { status: 404 });
  const existing = getMemoryJob(access.db, id);
  if (!existing) return Response.json({ error: "Memory job not found." }, { status: 404 });
  if (existing.status === "pending" || existing.status === "running") {
    wakeMemoryJobRunner(access.db);
  }
  return Response.json(
    { job: existing },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function validJobId(id: string): boolean {
  return id.length >= 3 && id.length <= 120 && /^[a-zA-Z0-9_-]+$/u.test(id);
}

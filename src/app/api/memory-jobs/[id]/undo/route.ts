import { undoMemoryJob } from "@/core/memory-jobs";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }
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

  const { id } = await context.params;
  if (!validJobId(id)) return Response.json({ error: "Memory job not found." }, { status: 404 });
  const result = undoMemoryJob(access.db, id);
  if (result.outcome === "not_found") {
    return Response.json({ error: "Memory job not found." }, { status: 404 });
  }
  if (result.outcome === "conflict") {
    return Response.json(
      {
        error: "This save has been used or changed since it was created. Correct the affected item instead.",
        job: result.job,
      },
      { status: 409 },
    );
  }
  return Response.json({ job: result.job });
}

function validJobId(id: string): boolean {
  return id.length >= 3 && id.length <= 120 && /^[a-zA-Z0-9_-]+$/u.test(id);
}

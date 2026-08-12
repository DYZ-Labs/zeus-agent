import { getWorkArtifact } from "@/core/work-plans";
import { getBrowserOwnerAccess } from "@/server/auth/access";
import { labsEnabled, labsUnavailableResponse } from "@/server/labs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-read");
  if (!access.canAccessPrivateData) return Response.json({ error: access.message }, { status: 403 });
  if (!labsEnabled(access.db)) return labsUnavailableResponse();
  const artifactId = Number((await params).id);
  if (!Number.isInteger(artifactId) || artifactId <= 0) {
    return Response.json({ error: "Invalid artifact id." }, { status: 400 });
  }
  const artifact = getWorkArtifact(access.db, artifactId);
  return artifact
    ? Response.json({ artifact })
    : Response.json({ error: "Work artifact not found." }, { status: 404 });
}

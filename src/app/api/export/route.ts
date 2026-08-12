import { strToU8, zipSync } from "fflate";

import { generateExportEntries } from "@/core/export-generator";
import { collectSqliteExport } from "@/core/export-sqlite";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-read");
  if (!access.canAccessPrivateData) {
    return Response.json(
      { error: access.message },
      { status: access.state === "signed_out" ? 401 : access.state === "wrong_account" || access.state === "forbidden_origin" ? 403 : 503 },
    );
  }

  const entries = generateExportEntries(collectSqliteExport(access.db));
  const archive = zipSync(
    Object.fromEntries(entries.map((entry) => [entry.path, strToU8(entry.content)])),
    { level: 6 },
  );
  const date = new Date().toISOString().slice(0, 10);
  return new Response(new Blob([archive], { type: "application/zip" }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="zeus-export-${date}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

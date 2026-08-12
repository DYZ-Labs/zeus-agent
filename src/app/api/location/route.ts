import { z } from "zod";

import { getFreshCoarseLocation, recordCoarseLocation } from "@/core/ambient";
import { IsoDateTime } from "@/core/schema";
import { getBrowserOwnerAccess } from "@/server/auth/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    zoneId: z.string().trim().min(1).max(120),
    observedAt: IsoDateTime,
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-read");
  if (!access.canAccessPrivateData) return denied(access);
  return Response.json({ location: getFreshCoarseLocation(access.db) });
}

export async function POST(request: Request): Promise<Response> {
  const access = await getBrowserOwnerAccess(request, "private-mutation");
  if (!access.canAccessPrivateData) return denied(access);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Expected only a named coarse zone and observation time; coordinates are not accepted." },
      { status: 400 },
    );
  }
  try {
    const location = recordCoarseLocation(
      access.db,
      parsed.data.zoneId,
      parsed.data.observedAt,
    );
    return Response.json({ location });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Location sample was rejected." },
      { status: 409 },
    );
  }
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

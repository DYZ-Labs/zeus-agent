import "server-only";

import type { Db } from "@/core/db";
import { getExperienceSettings } from "@/core/experience";

export function labsEnabled(db: Db): boolean {
  return getExperienceSettings(db).labsEnabled;
}

export function labsUnavailableResponse(): Response {
  return Response.json({ error: "This experimental tool is not enabled." }, { status: 404 });
}

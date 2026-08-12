import { redirect } from "next/navigation";

import { requireOwnerPageDb } from "@/server/auth/access";

export default async function TimelinePage() {
  await requireOwnerPageDb();
  redirect("/memory?view=history");
}

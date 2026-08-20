import { redirect } from "next/navigation";

import { requireOwnerPageDb } from "@/server/auth/access";

export default async function TimelinePage() {
  await requireOwnerPageDb();
  redirect("/about-you?view=history");
}

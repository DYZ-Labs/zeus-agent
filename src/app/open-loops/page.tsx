import { redirect } from "next/navigation";

import { requireOwnerPageDb } from "@/server/auth/access";

export default async function OpenLoopsPage() {
  await requireOwnerPageDb();
  redirect("/today#plans");
}

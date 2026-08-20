import { redirect } from "next/navigation";

import { memoryRedirect } from "@/lib/legacy-routes";

export const dynamic = "force-dynamic";

/** Merged into `/about-you`; see `memoryRedirect` for what carries across. */
export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(memoryRedirect(await searchParams));
}

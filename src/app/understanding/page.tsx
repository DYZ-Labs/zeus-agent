import { redirect } from "next/navigation";

import { understandingRedirect } from "@/lib/legacy-routes";

export const dynamic = "force-dynamic";

/** Merged into `/about-you`; see `understandingRedirect` for what carries across. */
export default async function UnderstandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(understandingRedirect(await searchParams));
}

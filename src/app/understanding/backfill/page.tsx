import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Moved under the merged page as `/about-you/backfill`. */
export default async function UnderstandingBackfillPage() {
  redirect("/about-you/backfill");
}

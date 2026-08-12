import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function UnderstandingPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  if (view === "review") redirect("/about-you?view=review");
  if (view === "history") redirect("/about-you?view=history");
  redirect("/about-you");
}

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string; show?: string }>;
}) {
  const params = await searchParams;
  const destination = new URLSearchParams();
  if (params.view === "review" || params.show === "pending") destination.set("view", "review");
  else if (params.view === "history" || params.show === "all") destination.set("view", "history");
  if (params.q?.trim() && destination.get("view") !== "review") {
    destination.set("q", params.q.trim().slice(0, 200));
  }
  redirect(`/about-you${destination.size > 0 ? `?${destination.toString()}` : ""}`);
}

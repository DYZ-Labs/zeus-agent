import { redirect } from "next/navigation";

export default function OpenLoopsPage() {
  redirect("/today#plans");
}

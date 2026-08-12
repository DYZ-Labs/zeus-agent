import Link from "next/link";
import { redirect } from "next/navigation";

import { DeleteAccountForm } from "./delete-account-form";
import { accountDeletionAvailable } from "@/server/auth/account-deletion";
import { getOwnerAccess } from "@/server/auth/access";

export const dynamic = "force-dynamic";

export default async function DeleteAccountPage() {
  const access = await getOwnerAccess();
  if (access.state !== "authorized") redirect("/settings?section=account");

  return (
    <div className="h-full overflow-y-auto px-5 py-10 sm:px-8">
      <main className="mx-auto max-w-[38rem]">
        <Link href="/settings#data" className="text-sm underline underline-offset-4" style={{ color: "var(--shell-muted)" }}>
          Back to Data controls
        </Link>
        <h1 className="mt-8 text-2xl font-semibold tracking-tight">Delete account</h1>
        <p className="mt-4 text-sm leading-6" style={{ color: "var(--shell-muted)" }}>
          This permanently removes your conversations, remembered details, plans, review history,
          and account. It cannot be undone. Export your data first if you want to keep a copy.
        </p>
        <DeleteAccountForm available={accountDeletionAvailable()} />
      </main>
    </div>
  );
}

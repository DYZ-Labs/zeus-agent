import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getOwnerAccess } from "@/server/auth/access";
import { getAuthCapabilities } from "@/server/auth/capabilities";
import { authMode, getAuthConfiguration } from "@/server/auth/config";
import { safeNextPath } from "@/server/auth/paths";

export const dynamic = "force-dynamic";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const configuration = getAuthConfiguration();
  const [access, capabilities] = await Promise.all([
    getOwnerAccess(),
    getAuthCapabilities(configuration),
  ]);
  if (access.state === "authorized") redirect(next);

  return (
    <AuthForm
      intent="signup"
      next={next}
      authMode={authMode(configuration)}
      canonicalSiteUrl={configuration.mode === "configured" ? configuration.siteUrl : null}
      googleEnabled={capabilities.googleEnabled}
      initialMessage={params.error?.slice(0, 500) ?? (access.state === "unavailable" ? access.message : null)}
      blockedAccount={access.state === "wrong_account" ? access.account : null}
    />
  );
}

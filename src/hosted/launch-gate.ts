export interface HostedLaunchReadiness {
  internalDeploymentReady: boolean;
  publicBetaReady: boolean;
  blockers: string[];
}

type HostedEnvironment = Readonly<Record<string, string | undefined>>;

// This changes only when concrete Postgres adapters pass the shared policy
// corpus and hosted integration suite. Environment variables cannot bypass it.
const POSTGRES_ADAPTER_PARITY_IMPLEMENTED = false;

export function hostedLaunchReadiness(
  environment: HostedEnvironment = process.env,
): HostedLaunchReadiness {
  const blockers: string[] = [];

  if (environment.ZEUS_HOSTED_STORE !== "postgres") {
    blockers.push("The tenant-safe Postgres store is not selected.");
  }
  if (environment.ZEUS_HOSTED_RLS_TESTED !== "true") {
    blockers.push("The two-user RLS gate has not passed for this deployment.");
  }
  if (!POSTGRES_ADAPTER_PARITY_IMPLEMENTED) {
    blockers.push("The Postgres domain adapters have not passed policy parity.");
  }
  if (environment.ZEUS_HOSTED_E2E_TESTED !== "true") {
    blockers.push("The hosted end-to-end isolation gate has not passed.");
  }

  return {
    internalDeploymentReady:
      environment.ZEUS_HOSTED_STORE === "postgres" &&
      environment.ZEUS_HOSTED_RLS_TESTED === "true",
    publicBetaReady: blockers.length === 0,
    blockers,
  };
}

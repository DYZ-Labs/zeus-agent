/**
 * The checked-in application still uses one process-wide SQLite store.  It is a
 * local/single-owner edition, never a hosted multi-tenant fallback.
 *
 * Keep this guard independent of Next.js so workers, scripts, and tests can apply
 * the same fail-closed decision before opening the store.
 */
export function assertSqliteDeploymentSafe(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const edition = environment.ZEUS_EDITION?.trim().toLowerCase() || "local";
  const managedPublicRuntime =
    environment.VERCEL === "1" ||
    environment.ZEUS_PUBLIC_HOSTED === "1" ||
    edition === "hosted";

  if (managedPublicRuntime) {
    throw new UnsafeSqliteDeploymentError();
  }
  if (edition !== "local") {
    throw new Error(`Unsupported ZEUS_EDITION value: ${edition}`);
  }
}

export class UnsafeSqliteDeploymentError extends Error {
  constructor() {
    super(
      "The local SQLite edition cannot run as hosted Zeus. Configure the tenant-scoped Postgres service before accepting public traffic.",
    );
    this.name = "UnsafeSqliteDeploymentError";
  }
}

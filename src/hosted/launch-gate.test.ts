import { describe, expect, it } from "vitest";

import { hostedLaunchReadiness } from "@/hosted/launch-gate";

describe("hosted launch gate", () => {
  it("keeps the local/default runtime out of hosted mode", () => {
    const readiness = hostedLaunchReadiness({});

    expect(readiness.internalDeploymentReady).toBe(false);
    expect(readiness.publicBetaReady).toBe(false);
  });

  it("allows an isolated internal schema trial but still blocks public beta", () => {
    const readiness = hostedLaunchReadiness({
      ZEUS_HOSTED_STORE: "postgres",
      ZEUS_HOSTED_RLS_TESTED: "true",
      ZEUS_HOSTED_E2E_TESTED: "true",
    });

    expect(readiness.internalDeploymentReady).toBe(true);
    expect(readiness.publicBetaReady).toBe(false);
    expect(readiness.blockers).toContain(
      "The Postgres domain adapters have not passed policy parity.",
    );
  });
});

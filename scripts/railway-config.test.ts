import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type RailwayConfig = {
  deploy?: {
    startCommand?: string;
    healthcheckPath?: string;
    healthcheckTimeout?: number;
    restartPolicyType?: string;
    restartPolicyMaxRetries?: number;
  };
};

const config = JSON.parse(
  readFileSync(new URL("../railway.json", import.meta.url), "utf8"),
) as RailwayConfig;

describe("Railway deployment configuration", () => {
  it("binds Next to Railway's injected port without an npm process wrapper", () => {
    expect(config.deploy?.startCommand).toBe(
      'node scripts/secure-local-files.mjs && exec ./node_modules/.bin/next start --hostname 0.0.0.0 --port "$PORT"',
    );
    expect(config.deploy?.startCommand).not.toMatch(/\bnpm\b/u);
  });

  it("waits for the store-aware health route before activating a deployment", () => {
    expect(config.deploy).toMatchObject({
      healthcheckPath: "/api/health",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
    });
  });
});

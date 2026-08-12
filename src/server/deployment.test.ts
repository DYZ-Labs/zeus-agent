import { describe, expect, it } from "vitest";

import {
  UnsafeSqliteDeploymentError,
  assertSqliteDeploymentSafe,
} from "./deployment";

describe("SQLite deployment boundary", () => {
  it("keeps the local edition available", () => {
    expect(() => assertSqliteDeploymentSafe({ ZEUS_EDITION: "local" })).not.toThrow();
    expect(() => assertSqliteDeploymentSafe({})).not.toThrow();
  });

  it.each([
    { ZEUS_EDITION: "hosted" },
    { ZEUS_PUBLIC_HOSTED: "1" },
    { VERCEL: "1" },
  ])("fails closed before SQLite is opened for a public runtime", (environment) => {
    expect(() => assertSqliteDeploymentSafe(environment)).toThrow(
      UnsafeSqliteDeploymentError,
    );
  });

  it("rejects unknown editions instead of guessing", () => {
    expect(() => assertSqliteDeploymentSafe({ ZEUS_EDITION: "preview" })).toThrow(
      "Unsupported ZEUS_EDITION value",
    );
  });
});

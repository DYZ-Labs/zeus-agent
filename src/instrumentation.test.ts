import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logResolvedModelOnce: vi.fn(),
}));

vi.mock("./core/openai", () => ({
  logResolvedModelOnce: mocks.logResolvedModelOnce,
}));

import { register } from "./instrumentation";

const originalRuntime = process.env.NEXT_RUNTIME;

afterEach(() => {
  mocks.logResolvedModelOnce.mockClear();
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
});

describe("server instrumentation", () => {
  it("logs the resolved model during Node server startup", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(mocks.logResolvedModelOnce).toHaveBeenCalledOnce();
  });

  it("does not load Node model configuration in the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(mocks.logResolvedModelOnce).not.toHaveBeenCalled();
  });
});

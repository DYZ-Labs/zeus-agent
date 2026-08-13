import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { embeddingWarmupDecision } from "./embedding-warmup";

afterEach(() => vi.unstubAllEnvs());

describe("embedding warm-up policy", () => {
  it("warms a hosted deployment, where a cold cache costs a user's first search", () => {
    expect(
      embeddingWarmupDecision({ mode: "configured" }, { NODE_ENV: "production" }),
    ).toEqual({ enabled: true, reason: "hosted" });
  });

  it("leaves development alone rather than pulling 130MB on npm run dev", () => {
    expect(
      embeddingWarmupDecision({ mode: "configured" }, { NODE_ENV: "development" }),
    ).toEqual({ enabled: false, reason: "not_hosted" });
    expect(
      embeddingWarmupDecision({ mode: "local" }, { NODE_ENV: "production" }),
    ).toEqual({ enabled: false, reason: "not_hosted" });
  });

  it("honours an explicit override in both directions", () => {
    expect(
      embeddingWarmupDecision({ mode: "local" }, { ZEUS_WARM_EMBEDDINGS: "on" }),
    ).toEqual({ enabled: true, reason: "explicitly_enabled" });
    expect(
      embeddingWarmupDecision(
        { mode: "configured" },
        { NODE_ENV: "production", ZEUS_WARM_EMBEDDINGS: "off" },
      ),
    ).toEqual({ enabled: false, reason: "explicitly_disabled" });
    expect(() =>
      embeddingWarmupDecision({ mode: "local" }, { ZEUS_WARM_EMBEDDINGS: "sometimes" }),
    ).toThrow(/'on' or 'off'/u);
  });

  it("never warms a model the deployment has switched off", () => {
    vi.stubEnv("ZEUS_EMBEDDINGS", "off");

    expect(
      embeddingWarmupDecision(
        { mode: "configured" },
        { NODE_ENV: "production", ZEUS_WARM_EMBEDDINGS: "on" },
      ),
    ).toEqual({ enabled: false, reason: "embeddings_off" });
  });
});

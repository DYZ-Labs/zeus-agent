import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The load path, without a 130MB download: `@huggingface/transformers` is mocked so the
 * cache location, the retry cooldown, and the reported status can be exercised for real.
 */
const transformers = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: { cacheDir: "" } as { cacheDir: string },
}));

vi.mock("@huggingface/transformers", () => transformers);

import {
  MODEL_LOAD_RETRY_COOLDOWN_MS,
  embeddingStatus,
  embed,
  modelCacheDirectory,
  resetEmbeddingsForTest,
  warmEmbeddings,
} from "./embed";

const extractor = async () => ({ data: Float32Array.from([1, 0, 0]), dims: [1, 3] });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetEmbeddingsForTest();
  transformers.pipeline.mockReset();
  transformers.env.cacheDir = "";
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetEmbeddingsForTest();
});

describe("model cache location", () => {
  it("resolves an absolute path so the same deployment cannot cache twice", () => {
    expect(modelCacheDirectory()).toBe(resolve(".models"));
    expect(modelCacheDirectory().startsWith("/")).toBe(true);
  });

  it("uses the configured directory, which a volume path makes durable", () => {
    vi.stubEnv("ZEUS_MODEL_CACHE", "/data/models");

    expect(modelCacheDirectory()).toBe("/data/models");
  });

  it("passes that exact directory to the loader", async () => {
    vi.stubEnv("ZEUS_MODEL_CACHE", "/data/models");
    transformers.pipeline.mockResolvedValue(extractor);

    await warmEmbeddings();

    expect(transformers.env.cacheDir).toBe("/data/models");
  });
});

describe("warming and recovery", () => {
  it("reports ready once the model is loaded", async () => {
    transformers.pipeline.mockResolvedValue(extractor);

    expect(embeddingStatus()).toBe("unloaded");
    await expect(warmEmbeddings()).resolves.toBe("ready");
    expect(embeddingStatus()).toBe("ready");
  });

  it("loads once and serves later calls from the same instance", async () => {
    transformers.pipeline.mockResolvedValue(extractor);

    await warmEmbeddings();
    await embed("something");
    await embed("something else");

    expect(transformers.pipeline).toHaveBeenCalledOnce();
  });

  it("keeps working on full-text search when the model cannot load", async () => {
    transformers.pipeline.mockRejectedValue(new Error("ENOTFOUND huggingface.co"));

    await expect(warmEmbeddings()).resolves.toBe("unavailable");
    // The caller gets null, not a thrown error: retrieval degrades, it does not fail.
    await expect(embed("something")).resolves.toBeNull();
  });

  it("does not retry the load on every query while cooling down", async () => {
    transformers.pipeline.mockRejectedValue(new Error("ENOTFOUND huggingface.co"));
    await warmEmbeddings();

    await embed("one");
    await embed("two");
    await embed("three");

    expect(transformers.pipeline).toHaveBeenCalledOnce();
  });

  it("recovers after the cooldown instead of staying degraded until redeploy", async () => {
    vi.useFakeTimers();
    transformers.pipeline.mockRejectedValueOnce(new Error("ENOTFOUND huggingface.co"));
    await warmEmbeddings();
    expect(embeddingStatus()).toBe("unavailable");

    // A CDN blip during boot used to cost this process semantic search permanently.
    transformers.pipeline.mockResolvedValue(extractor);
    vi.advanceTimersByTime(MODEL_LOAD_RETRY_COOLDOWN_MS + 1);

    await expect(warmEmbeddings()).resolves.toBe("ready");
    expect(transformers.pipeline).toHaveBeenCalledTimes(2);
  });

  it("does not load anything when embeddings are switched off", async () => {
    vi.stubEnv("ZEUS_EMBEDDINGS", "off");

    await expect(warmEmbeddings()).resolves.toBe("disabled");
    expect(transformers.pipeline).not.toHaveBeenCalled();
  });
});

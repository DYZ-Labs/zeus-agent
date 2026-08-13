import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as typeof globalThis & {
    zeusResolvedOpenAIModelLogged?: boolean;
  }).zeusResolvedOpenAIModelLogged;
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAI client policy", () => {
  it("uses a bounded timeout and one retry, then logs terminal exhaustion safely", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "private sentinel" } }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "retry-after-ms": "0",
          "x-should-retry": "true",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    // Structured events go to stderr; stdout belongs to the MCP protocol.
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const { OPENAI_MAX_RETRIES, OPENAI_TIMEOUT_MS, openai } = await import("./openai");

    const client = openai();
    expect(client.timeout).toBe(75_000);
    expect(client.maxRetries).toBe(1);
    expect(OPENAI_TIMEOUT_MS).toBe(75_000);
    expect(OPENAI_MAX_RETRIES).toBe(1);
    expect(openai()).toBe(client);

    await expect(
      client.responses.create({ model: "test-model", input: "test", store: false }),
    ).rejects.toMatchObject({ status: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "openai_retries_exhausted",
        outcome: "error",
        reason: "retry_budget_exhausted",
        count: 2,
      }),
    );
    // The SDK's own diagnostics can quote response bodies; ours must not.
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private sentinel");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("logs the trimmed resolved model once without requiring credentials", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_MODEL = "  custom-model  ";
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const { MODEL, logResolvedModelOnce, openai } = await import("./openai");

    expect(MODEL).toBe("custom-model");
    logResolvedModelOnce();
    logResolvedModelOnce();

    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: "startup", outcome: "ok", model: "custom-model" }),
    );
    expect(() => openai()).toThrow("No OpenAI credentials found");
  });
});

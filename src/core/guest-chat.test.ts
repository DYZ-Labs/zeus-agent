import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertResponseComplete: vi.fn(),
  finalResponse: vi.fn(),
  on: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("./openai", () => ({
  MODEL: "test-model",
  assertResponseComplete: mocks.assertResponseComplete,
  openai: () => ({ responses: { stream: mocks.stream } }),
}));

import { streamGuestTurn } from "./guest-chat";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.finalResponse.mockResolvedValue({
    status: "completed",
    output: [],
    output_text: "Guest answer",
  });
  mocks.on.mockImplementation(
    (event: string, listener: (event: { delta: string }) => void) => {
      if (event === "response.output_text.delta") listener({ delta: "Guest " });
    },
  );
  mocks.stream.mockReturnValue({
    on: mocks.on,
    finalResponse: mocks.finalResponse,
  });
});

describe("streamGuestTurn", () => {
  it("uses only the bounded guest transcript and never stores the model response", async () => {
    const deltas: string[] = [];
    const controller = new AbortController();
    const reply = await streamGuestTurn({
      input: "What did I just ask?",
      history: [
        { role: "user", content: "My temporary question" },
        { role: "assistant", content: "A temporary answer" },
      ],
      onDelta: (delta) => deltas.push(delta),
      signal: controller.signal,
    });

    expect(reply).toBe("Guest answer");
    expect(deltas).toEqual(["Guest "]);
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        store: false,
        instructions: expect.stringContaining("no access to this person's Zeus account"),
        input: [
          { role: "user", content: "My temporary question" },
          { role: "assistant", content: "A temporary answer" },
          { role: "user", content: "What did I just ask?" },
        ],
      }),
      { signal: controller.signal },
    );
    expect(mocks.assertResponseComplete).toHaveBeenCalledWith(
      expect.objectContaining({ output_text: "Guest answer" }),
    );
  });
});

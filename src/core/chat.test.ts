import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertResponseComplete: vi.fn(),
  buildContext: vi.fn(),
  extract: vi.fn(),
  extractionContext: vi.fn(),
  extractionSourceMessageIds: vi.fn(),
  finalResponse: vi.fn(),
  finishExtractionRun: vi.fn(),
  intentFieldProvenance: vi.fn(),
  on: vi.fn(),
  openaiStream: vi.fn(),
  recordResponseContext: vi.fn(),
  renderMemoryBlock: vi.fn(() => "<memory />"),
  startExtractionRun: vi.fn(),
}));

vi.mock("./openai", () => ({
  MODEL: "test-model",
  OPENAI_TIMEOUT_MS: 75_000,
  assertResponseComplete: mocks.assertResponseComplete,
  openai: () => ({ responses: { stream: mocks.openaiStream } }),
}));

vi.mock("./context", () => ({
  buildContext: mocks.buildContext,
  intentFieldProvenance: mocks.intentFieldProvenance,
  recordResponseContext: mocks.recordResponseContext,
  renderMemoryBlock: mocks.renderMemoryBlock,
}));

vi.mock("./extract", () => ({
  applyExtraction: vi.fn(),
  extract: mocks.extract,
  extractionContext: mocks.extractionContext,
  extractionSourceMessageIds: mocks.extractionSourceMessageIds,
  finishExtractionRun: mocks.finishExtractionRun,
  startExtractionRun: mocks.startExtractionRun,
}));

import {
  isExplicitBoundedWorkRequest,
  isExplicitCalendarReadRequest,
  streamTurn,
} from "./chat";
import { createConversation, messagesIn } from "./conversations";
import { openTestDb } from "./db";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildContext.mockResolvedValue({
    hits: [],
    plan: {},
    queryVector: null,
    recommendation: null,
  });
  mocks.openaiStream.mockReturnValue({
    on: mocks.on,
    finalResponse: mocks.finalResponse,
  });
  mocks.extractionContext.mockReturnValue({});
  mocks.extractionSourceMessageIds.mockReturnValue([]);
  mocks.finishExtractionRun.mockReturnValue({ status: "failed" });
});

describe("streamTurn cancellation", () => {
  it("passes the signal to OpenAI and does not persist or extract an aborted reply", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const controller = new AbortController();
    mocks.finalResponse.mockImplementation(async () => {
      controller.abort();
      return {
        status: "completed",
        output: [],
        output_text: "This reply arrived after cancellation",
      };
    });

    await expect(
      streamTurn(db, {
        conversationId: conversation.id,
        input: "Stop this turn",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(mocks.openaiStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-model", store: false }),
      { signal: expect.any(AbortSignal) },
    );
    const streamSignal = mocks.openaiStream.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(streamSignal).not.toBe(controller.signal);
    expect(streamSignal.aborted).toBe(true);
    expect(messagesIn(db, conversation.id)).toMatchObject([
      { role: "user", content: "Stop this turn" },
    ]);
    expect(mocks.assertResponseComplete).not.toHaveBeenCalled();
    expect(mocks.recordResponseContext).not.toHaveBeenCalled();
    expect(mocks.startExtractionRun).not.toHaveBeenCalled();
  });

  it("does not persist a user message for a signal that is already aborted", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const controller = new AbortController();
    controller.abort();

    await expect(
      streamTurn(db, {
        conversationId: conversation.id,
        input: "Never start this turn",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(messagesIn(db, conversation.id)).toEqual([]);
    expect(mocks.buildContext).not.toHaveBeenCalled();
    expect(mocks.openaiStream).not.toHaveBeenCalled();
  });

  it("ends the whole stream at the configured deadline without persisting a reply", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let streamSignal: AbortSignal | undefined;
    mocks.openaiStream.mockImplementation(
      (_body: unknown, request: { signal: AbortSignal }) => {
        streamSignal = request.signal;
        return { on: mocks.on, finalResponse: mocks.finalResponse };
      },
    );
    mocks.finalResponse.mockImplementation(async () => {
      deadline.abort();
      streamSignal?.throwIfAborted();
      throw new Error("deadline signal did not abort the stream");
    });

    try {
      await expect(
        streamTurn(db, {
          conversationId: conversation.id,
          input: "Do not store a partial timed-out reply",
        }),
      ).rejects.toMatchObject({
        name: "OpenAIStreamTimeoutError",
        message: "OpenAI streaming timed out after 75 seconds.",
      });
      expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(75_000);
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(messagesIn(db, conversation.id)).toMatchObject([
      { role: "user", content: "Do not store a partial timed-out reply" },
    ]);
    expect(mocks.assertResponseComplete).not.toHaveBeenCalled();
    expect(mocks.recordResponseContext).not.toHaveBeenCalled();
    expect(mocks.startExtractionRun).not.toHaveBeenCalled();
  });

  it("cancels extraction before it can apply memory writes", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const controller = new AbortController();
    mocks.finalResponse.mockResolvedValue({
      status: "completed",
      output: [],
      output_text: "The completed assistant reply",
    });
    mocks.startExtractionRun.mockReturnValue({ id: 11 });
    mocks.extract.mockImplementation(async () => {
      controller.abort();
      return {};
    });

    await expect(
      streamTurn(db, {
        conversationId: conversation.id,
        input: "Remember this unless I leave",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    const storedMessages = messagesIn(db, conversation.id);
    expect(storedMessages).toMatchObject([
      { role: "user", content: "Remember this unless I leave" },
      { role: "assistant", content: "The completed assistant reply" },
    ]);
    expect(storedMessages[0]?.recall_state).toBe("unclassified");
    expect(mocks.extract).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(mocks.finishExtractionRun).toHaveBeenCalledWith(db, 11, "failed", "AbortError");
  });
});

describe("bounded work request authorization", () => {
  it("recognizes direct read-only requests for the user's calendar", () => {
    expect(
      isExplicitCalendarReadRequest(
        "Check my calendar and tell me what do I have tomorrow.",
      ),
    ).toBe(true);
    expect(isExplicitCalendarReadRequest("What's on my schedule next week?")).toBe(true);
    expect(isExplicitCalendarReadRequest("Could you show my Google Calendar for today?")).toBe(
      true,
    );
  });

  it("does not turn calendar writes or indirect mentions into read authorization", () => {
    expect(isExplicitCalendarReadRequest("Add dinner to my calendar tomorrow.")).toBe(false);
    expect(isExplicitCalendarReadRequest("Don't check my calendar.")).toBe(false);
    expect(isExplicitCalendarReadRequest('Quote this: "check my calendar tomorrow".')).toBe(false);
    expect(isExplicitCalendarReadRequest("What if I check my calendar tomorrow?")).toBe(false);
    expect(isExplicitCalendarReadRequest("Check my manager's calendar tomorrow.")).toBe(false);
  });

  it("accepts narrow, direct multi-step requests", () => {
    expect(
      isExplicitBoundedWorkRequest("Research local backup options and draft a recommendation."),
    ).toBe(true);
    expect(
      isExplicitBoundedWorkRequest("Can you compare the vendors, then prepare a brief?"),
    ).toBe(true);
    expect(
      isExplicitBoundedWorkRequest("I need you to investigate this and write a report."),
    ).toBe(true);
  });

  it("does not treat negated, quoted, hypothetical, or third-person text as authorization", () => {
    expect(
      isExplicitBoundedWorkRequest("Don't research this or draft a report."),
    ).toBe(false);
    expect(
      isExplicitBoundedWorkRequest('Quote this: "research the options and draft a recommendation."'),
    ).toBe(false);
    expect(
      isExplicitBoundedWorkRequest("What if we research it and draft a report later?"),
    ).toBe(false);
    expect(
      isExplicitBoundedWorkRequest("My manager will research this and draft a report."),
    ).toBe(false);
  });

  it("keeps single-step or conversational mentions in ordinary chat", () => {
    expect(isExplicitBoundedWorkRequest("Research this topic.")).toBe(false);
    expect(isExplicitBoundedWorkRequest("I read a research report yesterday.")).toBe(false);
    expect(isExplicitBoundedWorkRequest("Draft a report about this.")).toBe(false);
  });
});

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

import { isExplicitBoundedWorkRequest, streamTurn } from "./chat";
import { appendMessage, createConversation, messagesIn } from "./conversations";
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
      { signal: controller.signal },
    );
    expect(messagesIn(db, conversation.id)).toMatchObject([
      { role: "user", content: "Stop this turn", recall_state: "blocked" },
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

  it("returns as soon as the assistant response is persisted without starting extraction", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    const controller = new AbortController();
    mocks.finalResponse.mockResolvedValue({
      status: "completed",
      output: [],
      output_text: "The completed assistant reply",
    });
    mocks.startExtractionRun.mockReturnValue({ id: 11 });
    const result = await streamTurn(db, {
      conversationId: conversation.id,
      input: "Remember this after the reply",
      signal: controller.signal,
    });

    const storedMessages = messagesIn(db, conversation.id);
    expect(storedMessages).toMatchObject([
      { role: "user", content: "Remember this after the reply" },
      { role: "assistant", content: "The completed assistant reply" },
    ]);
    expect(storedMessages[0]?.recall_state).toBe("unclassified");
    expect(result.userMessage.id).toBe(storedMessages[0]?.id);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.startExtractionRun).not.toHaveBeenCalled();
  });

  it("persists a memory-off transcript without reading or tracing saved memory", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    mocks.finalResponse.mockResolvedValue({
      status: "completed",
      output: [],
      output_text: "Transcript-only answer",
    });

    const result = await streamTurn(db, {
      conversationId: conversation.id,
      input: "Do not use or retain this across chats",
      rememberingMode: "off",
    });

    expect(result.context).toBeNull();
    expect(mocks.buildContext).not.toHaveBeenCalled();
    expect(mocks.recordResponseContext).not.toHaveBeenCalled();
    expect(messagesIn(db, conversation.id)).toMatchObject([
      { role: "user", recall_state: "blocked", cross_chat_recall_eligible: 0 },
      { role: "assistant", recall_state: "blocked", cross_chat_recall_eligible: 0 },
    ]);
    expect(mocks.openaiStream).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("No saved memory"),
          }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("keeps prior turns in a memory-off conversation while withholding saved memory", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    appendMessage(db, conversation.id, "user", "My first thought", {
      recallState: "blocked",
      crossChatRecallEligible: false,
    });
    appendMessage(db, conversation.id, "assistant", "A first answer", {
      crossChatRecallEligible: false,
    });
    mocks.finalResponse.mockResolvedValue({
      status: "completed",
      output: [],
      output_text: "A continuing answer",
    });

    await streamTurn(db, {
      conversationId: conversation.id,
      input: "Continue that thought",
      rememberingMode: "off",
    });

    expect(mocks.openaiStream).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([
          { role: "user", content: "My first thought" },
          { role: "assistant", content: "A first answer" },
        ]),
      }),
      expect.any(Object),
    );
  });

  it("does not execute bounded work while Labs is off", async () => {
    const db = openTestDb();
    const conversation = createConversation(db);
    mocks.finalResponse.mockResolvedValue({
      status: "completed",
      output: [],
      output_text: "An ordinary answer",
    });

    const result = await streamTurn(db, {
      conversationId: conversation.id,
      input: "Research backup providers and draft a recommendation.",
      labsEnabled: false,
    });

    expect(result.work).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM work_plan").get()).toEqual({ count: 0 });
  });
});

describe("bounded work request authorization", () => {
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

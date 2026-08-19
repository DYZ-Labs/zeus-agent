import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether the brief actually reaches the model, and only when it was asked for.
 *
 * `brief.test.ts` covers what the block says. This covers the wiring: a block composed
 * correctly and never attached is the same as no brief at all, and a block attached to every
 * turn is prompt growth nobody asked for.
 */

const mocks = vi.hoisted(() => ({
  assertResponseComplete: vi.fn(),
  buildContext: vi.fn(),
  classifyCalendarIntent: vi.fn(),
  finalResponse: vi.fn(),
  generateWorkPlanProposal: vi.fn(),
  on: vi.fn(),
  openaiStream: vi.fn(),
  recordResponseContext: vi.fn(),
  renderMemoryBlock: vi.fn(() => "<memory />"),
}));

vi.mock("./openai", () => ({
  MODEL: "test-model",
  OPENAI_TIMEOUT_MS: 75_000,
  assertResponseComplete: mocks.assertResponseComplete,
  openai: () => ({ responses: { stream: mocks.openaiStream } }),
}));

vi.mock("./context", () => ({
  buildContext: mocks.buildContext,
  intentFieldProvenance: vi.fn(),
  recordResponseContext: mocks.recordResponseContext,
  renderMemoryBlock: mocks.renderMemoryBlock,
}));

vi.mock("./extract", () => ({
  applyExtraction: vi.fn(),
  extract: vi.fn(async () => ({})),
  extractionContext: vi.fn(() => ({})),
  extractionSourceMessageIds: vi.fn(() => []),
  finishExtractionRun: vi.fn(() => ({ status: "completed" })),
  startExtractionRun: vi.fn(() => ({ id: 1 })),
}));

vi.mock("./work-execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./work-execution")>()),
  generateWorkPlanProposal: mocks.generateWorkPlanProposal,
}));

// "what needs my attention today?" carries a temporal word, so the deliberately loose
// calendar prefilter hits it. Answering "not a calendar request" here keeps these tests
// about the brief rather than about how the classifier fails without a model.
vi.mock("./calendar-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./calendar-intent")>()),
  classifyCalendarIntent: mocks.classifyCalendarIntent,
}));

const { streamTurn } = await import("./chat");
const { createConversation, appendMessage } = await import("./conversations");
const { openTestDb } = await import("./db");
const { createCommitment } = await import("./intentions");
type Db = ReturnType<typeof openTestDb>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-19T09:00:00.000Z"));
  vi.clearAllMocks();
  mocks.buildContext.mockResolvedValue({
    hits: [],
    items: [],
    plan: {},
    queryVector: null,
    recommendation: null,
  });
  mocks.openaiStream.mockReturnValue({ on: mocks.on, finalResponse: mocks.finalResponse });
  mocks.finalResponse.mockResolvedValue({ output_text: "Reply." });
  mocks.generateWorkPlanProposal.mockResolvedValue(null);
  mocks.classifyCalendarIntent.mockResolvedValue({ status: "classified", intent: null });
});

/** A store with one thing genuinely overdue, so the brief has something to say. */
function seeded(): Db {
  const db = openTestDb();
  const conversation = createConversation(db);
  const source = appendMessage(db, conversation.id, "user", "I owe Sam the deck", {
    origin: "user_action",
    recallState: "blocked",
  });
  createCommitment(db, {
    title: "Send Sam the deck",
    dueAt: "2026-08-15T09:00:00.000Z",
    sourceMessageId: source.id,
  });
  return db;
}

async function turn(input: string, db: Db) {
  const conversation = createConversation(db);
  await streamTurn(db, { conversationId: conversation.id, input, timezone: "UTC" });
  const body = mocks.openaiStream.mock.calls.at(-1)?.[0] as {
    input: { role: string; content: string }[];
  };
  return body.input.at(-1)?.content ?? "";
}

describe("the brief block on a chat turn", () => {
  it("reaches the model when the user asks what needs their attention", async () => {
    const sentToModel = await turn("what needs my attention today?", seeded());

    expect(sentToModel).toContain("<brief ");
    expect(sentToModel).toContain("NEEDS ATTENTION");
    expect(sentToModel).toContain("Send Sam the deck");
  });

  it("stays off an ordinary turn", async () => {
    const sentToModel = await turn("can you draft a reply to Sarah", seeded());

    expect(sentToModel).not.toContain("<brief ");
  });

  it("renders after the schedule and before memory, as the prompt says it will", async () => {
    // The system prompt states the block order; a block that arrives somewhere else makes
    // that sentence false, and the sentence is what the model uses to read the input.
    const sentToModel = await turn("brief me", seeded());

    expect(sentToModel.indexOf("<capabilities")).toBeLessThan(sentToModel.indexOf("<brief "));
    expect(sentToModel.indexOf("<brief ")).toBeLessThan(sentToModel.indexOf("<memory"));
  });

  it("carries the recommendation the turn already evaluated, without asking for a second one", async () => {
    // Evaluating again inside the brief would open a second recommendation cycle and
    // double-count its delivery, so the brief takes what `buildContext` already selected.
    mocks.buildContext.mockResolvedValue({
      hits: [],
      items: [],
      plan: {},
      queryVector: null,
      recommendation: {
        commitment_id: 1,
        commitment_title: "Send Sam the deck",
        suggested_action: "Send Sam the deck today.",
        why: "It was due four days ago.",
        reason: "overdue",
        requires_confirmation: false,
      },
    });

    const sentToModel = await turn("what needs my attention", seeded());

    expect(mocks.buildContext).toHaveBeenCalledTimes(1);
    expect(sentToModel).toContain("NEXT");
    expect(sentToModel).toContain("Send Sam the deck today.");
  });

  it("says so rather than going quiet when there is nothing to report", async () => {
    const sentToModel = await turn("brief me", openTestDb());

    expect(sentToModel).toContain("<brief ");
    expect(sentToModel).toContain("Nothing today needs");
  });
});

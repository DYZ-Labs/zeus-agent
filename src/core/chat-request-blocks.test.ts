import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The blocks a turn attaches only because the user asked for them.
 *
 * `brief.test.ts` and `meeting-prep.test.ts` cover what each block says. This covers the
 * wiring they share: a block composed correctly and never attached is the same as no feature
 * at all, and a block attached to every turn is prompt growth nobody asked for.
 *
 * The third case matters most. A request that was recognized, found nothing, and attached no
 * block leaves the model to answer about the user's calendar out of memory — which is how
 * "there is no dinner event to reschedule" came to be said about a calendar nothing in the
 * turn had opened.
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
const { cacheCalendarEvents } = await import("./calendar-sync");
const { createConversation, appendMessage } = await import("./conversations");
const { openTestDb } = await import("./db");
const { upsertEntity } = await import("./entities");
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

describe("the meeting prep block on a chat turn", () => {
  /** A store with one upcoming meeting and one attendee Zeus has been told about. */
  function withMeeting(): Db {
    const db = seeded();
    upsertEntity(db, { kind: "person", name: "Sarah Chen" });
    db.exec(`
      INSERT INTO connector (id, label, transport, command, source_message_id, status, enabled,
                             created_at, updated_at)
      VALUES (1, 'Calendar', 'stdio', 'node', 1, 'ready', 1,
              '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
    `);
    cacheCalendarEvents(
      db,
      1,
      {
        events: [
          {
            id: "evt-review",
            title: "Product review",
            starts_at: "2026-08-19T15:00:00Z",
            ends_at: "2026-08-19T16:00:00Z",
            attendees: [{ email: "sarah@example.com", displayName: "Sarah Chen" }],
          },
        ],
      },
      new Date("2026-08-19T09:00:00.000Z"),
    );
    return db;
  }

  it("reaches the model when the user asks to be prepared", async () => {
    const sentToModel = await turn("prep me for my next meeting", withMeeting());

    expect(sentToModel).toContain("<meeting_prep ");
    expect(sentToModel).toContain('status="prepared"');
    expect(sentToModel).toContain("Sarah Chen");
  });

  it("stays off an ordinary turn", async () => {
    const sentToModel = await turn("what did I promise James", withMeeting());

    expect(sentToModel).not.toContain("<meeting_prep ");
  });

  it("attaches a block even when nothing matched, rather than leaving the model to guess", async () => {
    // A recognized request that found nothing and attached no block is how a reply about
    // the user's calendar gets composed out of memory alone.
    const sentToModel = await turn("prep me for my 4 AM", withMeeting());

    expect(sentToModel).toContain('status="no_match"');
    expect(sentToModel).toContain("not a calendar that could not be read");
  });
});

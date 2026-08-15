import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrowserOwnerAccess: vi.fn(),
  streamTurn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/access", () => ({
  getBrowserOwnerAccess: mocks.getBrowserOwnerAccess,
}));
vi.mock("@/core/chat", () => ({ streamTurn: mocks.streamTurn }));

import { openTestDb } from "@/core/db";
import { bindAppOwner } from "@/core/owner";
import { POST } from "./route";

/** A sentence of the kind a turn's own error can quote back. */
const MEMORY_TEXT = "Jane Okafor moved to 12 Elm Street after leaving Acme";

let db: ReturnType<typeof openTestDb>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENAI_API_KEY", "sk-test-key-for-the-route-only");
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  db = openTestDb();
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "local",
    canAccessPrivateData: true,
    account: null,
    db,
    message: null,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function turn(input = "Where do I live?"): Promise<Response> {
  return POST(
    new Request("http://127.0.0.1:3000/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }),
  );
}

function loggedEvents(name: string): Array<Record<string, string | number>> {
  return stderr.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, string | number>)
    .filter((event) => event.event === name);
}

describe("chat turn telemetry", () => {
  it("records a completed turn, so failures have a denominator", async () => {
    mocks.streamTurn.mockImplementation(
      async (_db: unknown, options: { onDelta: (text: string) => void }) => {
        options.onDelta("You live on Elm Street.");
        return {
          message: { id: 7 },
          context: { items: [] },
          learned: null,
          work: null,
        };
      },
    );

    const body = await (await turn()).text();

    expect(body).toContain('"type":"done"');
    const turns = loggedEvents("chat_turn");
    // One line per turn, not per delta: the stream is long and the event is a count.
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      event: "chat_turn",
      outcome: "ok",
      conversation_id: expect.any(Number),
    });
    expect(typeof turns[0]!.duration_ms).toBe("number");
  });

  it("counts a failed turn the same way, and still keeps the error text out", async () => {
    bindAppOwner(db, {
      supabaseUserId: "019ff232-f8e0-7ce2-8e83-d416444aed06",
      email: "jane@example.com",
    });
    mocks.streamTurn.mockRejectedValue(new Error(MEMORY_TEXT));

    const body = await (await turn()).text();

    // The person whose memory it is still gets told what happened.
    expect(body).toContain("Elm Street");
    expect(loggedEvents("chat_turn")).toHaveLength(1);
    // The same line as a completed turn, attribution included: an error rate is read per
    // account, and one that cannot be is read as though every account were broken.
    expect(loggedEvents("chat_turn")[0]).toMatchObject({
      outcome: "error",
      reason: "turn_failed",
      error_name: "Error",
      account: "019ff232-f8e0-7ce2-8e83-d416444aed06",
    });
    expect(
      stderr.mock.calls.map((call) => String(call[0])).join("\n"),
    ).not.toContain("Elm");
  });

  it("attributes a turn to the account whose store answered it", async () => {
    bindAppOwner(db, {
      supabaseUserId: "019ff232-f8e0-7ce2-8e83-d416444aed06",
      email: "jane@example.com",
    });
    mocks.streamTurn.mockResolvedValue({
      message: { id: 7 },
      context: { items: [] },
      learned: null,
      work: null,
    });

    await (await turn()).text();

    expect(loggedEvents("chat_turn")[0]).toMatchObject({
      outcome: "ok",
      account: "019ff232-f8e0-7ce2-8e83-d416444aed06",
    });
    // Pseudonymous by design: the address that identifies the person never travels.
    expect(
      stderr.mock.calls.map((call) => String(call[0])).join("\n"),
    ).not.toContain("jane@example.com");
  });
});

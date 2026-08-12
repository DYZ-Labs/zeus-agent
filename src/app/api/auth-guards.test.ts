import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireChatVerification: vi.fn(),
  acquireGuestChat: vi.fn(),
  createConversation: vi.fn(),
  getBrowserOwnerAccess: vi.fn(),
  getConversation: vi.fn(),
  hasCredentials: vi.fn(),
  streamGuestTurn: vi.fn(),
  streamTurn: vi.fn(),
  releaseGuestChat: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({
  getBrowserOwnerAccess: mocks.getBrowserOwnerAccess,
}));
vi.mock("@/core/chat", () => ({ streamTurn: mocks.streamTurn }));
vi.mock("@/core/conversations", () => ({
  createConversation: mocks.createConversation,
  getConversation: mocks.getConversation,
}));
vi.mock("@/core/guest-chat", () => ({ streamGuestTurn: mocks.streamGuestTurn }));
vi.mock("@/server/guest-chat-limit", () => ({
  acquireChatVerification: mocks.acquireChatVerification,
  acquireGuestChat: mocks.acquireGuestChat,
}));
vi.mock("@/core/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/openai")>();
  return { ...actual, hasCredentials: mocks.hasCredentials };
});

import { POST as postChat } from "./chat/route";
import { POST as postFollowThrough } from "./follow-through/route";
import { GET as getLocation, POST as postLocation } from "./location/route";
import { POST as postOpportunityDelivery } from "./opportunities/[id]/delivery/route";
import { GET as getWorkArtifact } from "./work-artifacts/[id]/route";
import {
  DELETE as deleteWorkPlan,
  GET as getWorkPlan,
} from "./work-plans/[id]/route";
import { POST as postWorkPlanAuthorization } from "./work-plans/[id]/authorize/route";
import { POST as postWorkPlanRun } from "./work-plans/[id]/run/route";
import { GET as getWorkPlans, POST as postWorkPlan } from "./work-plans/route";
import { GET as getWorkRun, POST as postWorkRunAction } from "./work-runs/[id]/route";

const ID_PARAMS = { params: Promise.resolve({ id: "1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasCredentials.mockReturnValue(true);
  mocks.acquireChatVerification.mockReturnValue({
    allowed: true,
    release: vi.fn(),
  });
  mocks.acquireGuestChat.mockReturnValue({
    allowed: true,
    release: mocks.releaseGuestChat,
  });
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "signed_out",
    canAccessPrivateData: false,
    account: null,
    db: null,
    message: "Log in to access this Zeus memory store.",
  });
  mocks.streamGuestTurn.mockImplementation(
    async ({ onDelta }: { onDelta?: (text: string) => void }) => {
      onDelta?.("Temporary reply");
      return "Temporary reply";
    },
  );
});

describe("chat API access boundaries", () => {
  it("streams a bounded, memory-free conversation while signed out", async () => {
    const response = await postChat(
      jsonRequest("/api/chat", {
        input: "Continue this thought",
        conversationId: 42,
        history: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
        ],
      }),
    );

    expect(response.status).toBe(200);
    await expect(ndjson(response)).resolves.toEqual([
      { type: "delta", text: "Temporary reply" },
      { type: "done", guest: true },
    ]);
    expect(mocks.streamGuestTurn).toHaveBeenCalledWith({
      input: "Continue this thought",
      history: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
      onDelta: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(mocks.streamTurn).not.toHaveBeenCalled();
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.releaseGuestChat).toHaveBeenCalledOnce();
  });

  it("validates public chat input before starting a model request", async () => {
    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
    expect(mocks.getBrowserOwnerAccess).not.toHaveBeenCalled();
  });

  it("rejects simple cross-site form content before parsing it", async () => {
    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ input: "Spend the local model quota" }),
      }),
    );

    expect(response.status).toBe(415);
    expect(mocks.getBrowserOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
  });

  it("rejects oversized guest inputs and transcripts at every boundary", async () => {
    const oversizedInput = await postChat(
      jsonRequest("/api/chat", { input: "x".repeat(4_001) }),
    );
    const tooManyMessages = await postChat(
      jsonRequest("/api/chat", {
        input: "hello",
        history: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })),
      }),
    );
    const tooMuchHistory = await postChat(
      jsonRequest("/api/chat", {
        input: "hello",
        history: Array.from({ length: 6 }, () => ({
          role: "user",
          content: "x".repeat(3_500),
        })),
      }),
    );

    expect(oversizedInput.status).toBe(400);
    expect(tooManyMessages.status).toBe(400);
    expect(tooMuchHistory.status).toBe(400);
    expect(mocks.getBrowserOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
  });

  it("does not downgrade an authenticated but unlinked account to guest chat", async () => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "wrong_account",
      canAccessPrivateData: false,
      account: { id: "other", email: "other@example.com" },
      db: null,
      message: "This Zeus memory store is already linked to a different account.",
    });

    const response = await postChat(
      jsonRequest("/api/chat", {
        input: "Read conversation 42",
        conversationId: 42,
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This Zeus memory store is already linked to a different account.",
    });
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.streamTurn).not.toHaveBeenCalled();
  });

  it("returns a retryable limit response before starting guest generation", async () => {
    mocks.acquireGuestChat.mockReturnValue({
      allowed: false,
      retryAfterSeconds: 12,
    });

    const response = await postChat(jsonRequest("/api/chat", { input: "Hello" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
  });

  it("bounds account verification before calling the auth service", async () => {
    mocks.acquireChatVerification.mockReturnValue({
      allowed: false,
      retryAfterSeconds: 9,
    });

    const response = await postChat(jsonRequest("/api/chat", { input: "Hello" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(mocks.getBrowserOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.acquireGuestChat).not.toHaveBeenCalled();
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
  });

  it("aborts guest generation and releases its lease when the client disconnects", async () => {
    const observed: { signal?: AbortSignal } = {};
    let markStarted: () => void = () => {};
    let markAborted: () => void = () => {};
    let rejectTurn: (reason?: unknown) => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = () => resolve();
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = () => resolve();
    });
    mocks.streamGuestTurn.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          observed.signal = signal;
          rejectTurn = reject;
          markStarted();
          signal.addEventListener(
            "abort",
            () => markAborted(),
            { once: true },
          );
        }),
    );

    const response = await postChat(jsonRequest("/api/chat", { input: "Keep going" }));
    await started;
    const cancellation = response.body?.cancel();
    await aborted;

    expect(observed.signal?.aborted).toBe(true);
    expect(mocks.releaseGuestChat).not.toHaveBeenCalled();

    rejectTurn(new DOMException("aborted", "AbortError"));
    await cancellation;
    expect(mocks.releaseGuestChat).toHaveBeenCalledOnce();
  });

  it("does not downgrade temporary account-verification failures to guest chat", async () => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "unavailable",
      canAccessPrivateData: false,
      account: null,
      db: null,
      message: "Zeus could not verify the account right now. Private memory stayed locked.",
    });

    const response = await postChat(jsonRequest("/api/chat", { input: "Remember this" }));

    expect(response.status).toBe(503);
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
  });

  it("ignores client-supplied guest history on the authorized memory path", async () => {
    const db = { private: true };
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "authorized",
      canAccessPrivateData: true,
      account: { id: "owner", email: "owner@example.com" },
      db,
      message: null,
    });
    mocks.createConversation.mockReturnValue({ id: 7 });
    mocks.streamTurn.mockImplementation(
      async (_db: unknown, options: { onDelta: (text: string) => void }) => {
        options.onDelta("Owner reply");
        return {
          message: { id: 9 },
          context: { items: [], recommendation: null },
          learned: null,
        };
      },
    );

    const response = await postChat(
      jsonRequest("/api/chat", {
        input: "Use my saved context",
        history: [{ role: "assistant", content: "Untrusted guest transcript" }],
      }),
    );

    expect(response.status).toBe(200);
    await ndjson(response);
    expect(mocks.streamTurn).toHaveBeenCalledWith(db, {
      conversationId: 7,
      input: "Use my saved context",
      onDelta: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(mocks.streamGuestTurn).not.toHaveBeenCalled();
  });

  it("aborts an authorized turn when its response stream is cancelled", async () => {
    const db = { private: true };
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "authorized",
      canAccessPrivateData: true,
      account: { id: "owner", email: "owner@example.com" },
      db,
      message: null,
    });
    mocks.createConversation.mockReturnValue({ id: 8 });
    let observedSignal: AbortSignal | undefined;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    mocks.streamTurn.mockImplementation(
      (_db: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = options.signal;
          markStarted();
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const response = await postChat(jsonRequest("/api/chat", { input: "Stop" }));
    await started;
    await response.body?.cancel();

    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("private API auth guards", () => {
  it("still rejects follow-through mutations for signed-out requests", async () => {
    const response = await postFollowThrough(
      jsonRequest("/api/follow-through", {}),
    );

    expect(response.status).toBe(401);
    expect(mocks.getBrowserOwnerAccess).toHaveBeenCalledOnce();
  });

  it("distinguishes an authenticated but unlinked account on private mutations", async () => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "wrong_account",
      canAccessPrivateData: false,
      account: null,
      db: null,
      message: "This Zeus memory store is already linked to a different account.",
    });

    const response = await postFollowThrough(
      jsonRequest("/api/follow-through", {}),
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["read location", () => getLocation(request("/api/location", undefined, "GET"))],
    [
      "record location",
      () => postLocation(request("/api/location", "not-json")),
    ],
    [
      "record an opportunity delivery",
      () => postOpportunityDelivery(
        request("/api/opportunities/1/delivery", "not-json"),
        ID_PARAMS,
      ),
    ],
    ["list work plans", () => getWorkPlans(request("/api/work-plans", undefined, "GET"))],
    [
      "create a work plan",
      () => postWorkPlan(request("/api/work-plans", "not-json")),
    ],
    [
      "read a work plan",
      () => getWorkPlan(request("/api/work-plans/1"), ID_PARAMS),
    ],
    [
      "cancel a work plan",
      () => deleteWorkPlan(request("/api/work-plans/1", undefined, "DELETE"), ID_PARAMS),
    ],
    [
      "authorize a work plan",
      () => postWorkPlanAuthorization(
        request("/api/work-plans/1/authorize", "not-json"),
        ID_PARAMS,
      ),
    ],
    [
      "run a work plan",
      () => postWorkPlanRun(request("/api/work-plans/1/run", "not-json"), ID_PARAMS),
    ],
    [
      "read a work run",
      () => getWorkRun(request("/api/work-runs/1"), ID_PARAMS),
    ],
    [
      "resume or cancel a work run",
      () => postWorkRunAction(request("/api/work-runs/1", "not-json"), ID_PARAMS),
    ],
    [
      "read a work artifact",
      () => getWorkArtifact(request("/api/work-artifacts/1"), ID_PARAMS),
    ],
  ])("guards owner-private API before attempting to %s", async (_label, invoke) => {
    const response = await invoke();

    expect([401, 403]).toContain(response.status);
    await expect(response.json()).resolves.toEqual({
      error: "Log in to access this Zeus memory store.",
    });
  });

  it.each([
    ["location", () => getLocation(request("/api/location", undefined, "GET"))],
    ["work plans", () => getWorkPlans(request("/api/work-plans", undefined, "GET"))],
    [
      "work plan detail",
      () => getWorkPlan(request("/api/work-plans/1"), ID_PARAMS),
    ],
    [
      "work run detail",
      () => getWorkRun(request("/api/work-runs/1"), ID_PARAMS),
    ],
    [
      "work artifact detail",
      () => getWorkArtifact(request("/api/work-artifacts/1"), ID_PARAMS),
    ],
  ])("rejects a wrong owner account from %s reads", async (_label, invoke) => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "wrong_account",
      canAccessPrivateData: false,
      account: null,
      db: null,
      message: "This Zeus memory store is already linked to a different account.",
    });

    const response = await invoke();
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This Zeus memory store is already linked to a different account.",
    });
  });
});

function request(path: string, body?: string, method = "POST"): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function ndjson(response: Response): Promise<unknown[]> {
  return (await response.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

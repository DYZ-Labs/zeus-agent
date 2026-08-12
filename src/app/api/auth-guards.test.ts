import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireChatVerification: vi.fn(),
  acquireGuestChat: vi.fn(),
  blockMessageRecall: vi.fn(),
  createConversation: vi.fn(),
  createMemoryJob: vi.fn(),
  getBrowserOwnerAccess: vi.fn(),
  getConversation: vi.fn(),
  getExperienceSettings: vi.fn(),
  hasCredentials: vi.fn(),
  streamGuestTurn: vi.fn(),
  streamTurn: vi.fn(),
  wakeMemoryJobRunner: vi.fn(),
  verifyStoreFreeChatAccess: vi.fn(),
  releaseGuestChat: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({
  getBrowserOwnerAccess: mocks.getBrowserOwnerAccess,
  verifyStoreFreeChatAccess: mocks.verifyStoreFreeChatAccess,
}));
vi.mock("@/core/chat", () => ({ streamTurn: mocks.streamTurn }));
vi.mock("@/core/conversations", () => ({
  createConversation: mocks.createConversation,
  getConversation: mocks.getConversation,
}));
vi.mock("@/core/experience", () => ({
  getExperienceSettings: mocks.getExperienceSettings,
}));
vi.mock("@/core/guest-chat", () => ({ streamGuestTurn: mocks.streamGuestTurn }));
vi.mock("@/core/memory-jobs", () => ({ createMemoryJob: mocks.createMemoryJob }));
vi.mock("@/core/passages", () => ({ blockMessageRecall: mocks.blockMessageRecall }));
vi.mock("@/server/guest-chat-limit", () => ({
  acquireChatVerification: mocks.acquireChatVerification,
  acquireGuestChat: mocks.acquireGuestChat,
}));
vi.mock("@/server/labs", () => ({
  labsEnabled: () => Boolean(mocks.getExperienceSettings()?.labsEnabled),
  labsUnavailableResponse: () => Response.json(
    { error: "This experimental tool is not enabled." },
    { status: 404 },
  ),
}));
vi.mock("@/server/memory-job-runner", () => ({
  wakeMemoryJobRunner: mocks.wakeMemoryJobRunner,
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
  mocks.acquireChatVerification.mockReturnValue({ allowed: true, release: vi.fn() });
  mocks.acquireGuestChat.mockReturnValue({ allowed: true, release: mocks.releaseGuestChat });
  mocks.verifyStoreFreeChatAccess.mockResolvedValue({ allowed: true, state: "local" });
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "signed_out",
    canAccessPrivateData: false,
    account: null,
    db: null,
    message: "Log in to access this Zeus memory store.",
  });
  mocks.getExperienceSettings.mockReturnValue({ rememberingMode: "automatic" });
  mocks.streamGuestTurn.mockImplementation(
    async ({ onDelta }: { onDelta?: (text: string) => void }) => {
      onDelta?.("Temporary reply");
      return "Temporary reply";
    },
  );
  mocks.createMemoryJob.mockReturnValue({ id: "job-safe-id" });
});

describe("chat API protocol and access", () => {
  it("streams temporary chat without touching owner access or conversation storage", async () => {
    const response = await postChat(
      jsonRequest("/api/chat", {
        input: "Continue this thought",
        mode: "temporary",
        temporaryHistory: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
        ],
      }),
    );

    expect(response.status).toBe(200);
    await expect(ndjson(response)).resolves.toEqual([
      { type: "text_delta", text: "Temporary reply" },
      { type: "response_complete", responseId: null, memoryJobId: null, memoryError: null },
    ]);
    expect(mocks.verifyStoreFreeChatAccess).toHaveBeenCalledOnce();
    expect(mocks.getBrowserOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.createMemoryJob).not.toHaveBeenCalled();
  });

  it("rejects conversation ids in temporary mode", async () => {
    const response = await postChat(
      jsonRequest("/api/chat", {
        input: "Do not save this",
        mode: "temporary",
        conversationId: "conversation_16",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.verifyStoreFreeChatAccess).not.toHaveBeenCalled();
  });

  it("rejects browser history on standard mode", async () => {
    const response = await postChat(
      jsonRequest("/api/chat", {
        input: "Use saved context",
        mode: "standard",
        temporaryHistory: [{ role: "assistant", content: "Untrusted" }],
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.getBrowserOwnerAccess).not.toHaveBeenCalled();
  });

  it("enforces bounded temporary transcripts", async () => {
    const response = await postChat(
      jsonRequest("/api/chat", {
        input: "hello",
        mode: "temporary",
        temporaryHistory: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("emits completion and a durable job before any extraction is processed", async () => {
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
          userMessage: { id: 8 },
          message: { id: 9 },
          context: { items: [], recommendation: null },
          work: null,
        };
      },
    );

    const response = await postChat(
      jsonRequest("/api/chat", { input: "Remember this", mode: "standard" }),
    );

    await expect(ndjson(response)).resolves.toEqual([
      { type: "conversation", conversationId: "conversation_7" },
      { type: "text_delta", text: "Owner reply" },
      {
        type: "response_complete",
        responseId: "message_9",
        memoryJobId: "job-safe-id",
        memoryError: null,
        recalled: 0,
      },
    ]);
    expect(mocks.createMemoryJob).toHaveBeenCalledWith(db, {
      conversationId: 7,
      sourceMessageId: 8,
      assistantMessageId: 9,
      promptVersion: "understanding-v1",
      rememberingMode: "automatic",
    });
    expect(mocks.wakeMemoryJobRunner).toHaveBeenCalledWith(db);
  });

  it("creates no memory job when remembering is off", async () => {
    const db = { private: true };
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "authorized",
      canAccessPrivateData: true,
      account: null,
      db,
      message: null,
    });
    mocks.getExperienceSettings.mockReturnValue({ rememberingMode: "off" });
    mocks.createConversation.mockReturnValue({ id: 3 });
    mocks.streamTurn.mockResolvedValue({
      userMessage: { id: 4 },
      message: { id: 5 },
      context: null,
      work: null,
    });

    const response = await postChat(jsonRequest("/api/chat", { input: "Do not remember" }));
    const events = await ndjson(response);
    expect(events.at(-1)).toMatchObject({
      type: "response_complete",
      responseId: "message_5",
      memoryJobId: null,
    });
    expect(mocks.streamTurn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ rememberingMode: "off" }),
    );
    expect(mocks.createMemoryJob).not.toHaveBeenCalled();
    expect(mocks.wakeMemoryJobRunner).not.toHaveBeenCalled();
  });

  it("preserves response completion when durable job creation fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = { private: true };
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "authorized",
      canAccessPrivateData: true,
      account: null,
      db,
      message: null,
    });
    mocks.createConversation.mockReturnValue({ id: 3 });
    mocks.streamTurn.mockResolvedValue({
      userMessage: { id: 4 },
      message: { id: 5 },
      context: { items: [], recommendation: null },
      work: null,
    });
    mocks.createMemoryJob.mockImplementation(() => {
      throw new Error("store unavailable");
    });

    const response = await postChat(jsonRequest("/api/chat", { input: "Keep the answer" }));
    expect((await ndjson(response)).at(-1)).toMatchObject({
      type: "response_complete",
      responseId: "message_5",
      memoryJobId: null,
      memoryError: "Memory could not be updated.",
    });
    expect(mocks.blockMessageRecall).toHaveBeenCalledWith(db, 4);
    warning.mockRestore();
  });

  it("returns a retryable temporary-chat limit response", async () => {
    mocks.acquireGuestChat.mockReturnValue({ allowed: false, retryAfterSeconds: 12 });
    const response = await postChat(
      jsonRequest("/api/chat", { input: "Hello", mode: "temporary" }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
  });

  it("aborts temporary generation and releases its lease on stream cancellation", async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted: () => void = () => {};
    let rejectTurn: (reason?: unknown) => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    mocks.streamGuestTurn.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          observedSignal = signal;
          rejectTurn = reject;
          markStarted();
        }),
    );
    const response = await postChat(
      jsonRequest("/api/chat", { input: "Keep going", mode: "temporary" }),
    );
    await started;
    const cancellation = response.body?.cancel();
    expect(observedSignal?.aborted).toBe(true);
    rejectTurn(new DOMException("aborted", "AbortError"));
    await cancellation;
    expect(mocks.releaseGuestChat).toHaveBeenCalledOnce();
  });
});

// Keep the cross-route access regression coverage colocated here. The chat protocol
// changed substantially, but private Labs endpoints must retain the same owner guard.
describe("private API auth guards", () => {
  it("keeps experimental endpoints unavailable until Labs is enabled", async () => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "authorized",
      canAccessPrivateData: true,
      account: { id: "owner", email: "owner@example.com" },
      db: { private: true },
      message: null,
    });
    mocks.getExperienceSettings.mockReturnValue({
      rememberingMode: "automatic",
      labsEnabled: false,
    });

    const [work, location] = await Promise.all([
      getWorkPlans(request("/api/work-plans", undefined, "GET")),
      getLocation(request("/api/location", undefined, "GET")),
    ]);
    expect(work.status).toBe(404);
    expect(location.status).toBe(404);
  });

  it("still rejects follow-through mutations for signed-out requests", async () => {
    const response = await postFollowThrough(jsonRequest("/api/follow-through", {}));

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

    const response = await postFollowThrough(jsonRequest("/api/follow-through", {}));
    expect(response.status).toBe(403);
  });

  it.each([
    ["read location", () => getLocation(request("/api/location", undefined, "GET"))],
    ["record location", () => postLocation(request("/api/location", "not-json"))],
    [
      "record an opportunity delivery",
      () =>
        postOpportunityDelivery(
          request("/api/opportunities/1/delivery", "not-json"),
          ID_PARAMS,
        ),
    ],
    ["list work plans", () => getWorkPlans(request("/api/work-plans", undefined, "GET"))],
    ["create a work plan", () => postWorkPlan(request("/api/work-plans", "not-json"))],
    ["read a work plan", () => getWorkPlan(request("/api/work-plans/1"), ID_PARAMS)],
    [
      "cancel a work plan",
      () => deleteWorkPlan(request("/api/work-plans/1", undefined, "DELETE"), ID_PARAMS),
    ],
    [
      "authorize a work plan",
      () =>
        postWorkPlanAuthorization(
          request("/api/work-plans/1/authorize", "not-json"),
          ID_PARAMS,
        ),
    ],
    [
      "run a work plan",
      () => postWorkPlanRun(request("/api/work-plans/1/run", "not-json"), ID_PARAMS),
    ],
    ["read a work run", () => getWorkRun(request("/api/work-runs/1"), ID_PARAMS)],
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
    ["work plan detail", () => getWorkPlan(request("/api/work-plans/1"), ID_PARAMS)],
    ["work run detail", () => getWorkRun(request("/api/work-runs/1"), ID_PARAMS)],
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
    headers: {
      "Content-Type": "application/json",
      Host: "127.0.0.1:3000",
      Origin: "http://127.0.0.1:3000",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

async function ndjson(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

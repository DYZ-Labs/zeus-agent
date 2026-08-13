import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  getBrowserOwnerAccess: vi.fn(),
  getConversation: vi.fn(),
  hasCredentials: vi.fn(),
  streamTurn: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({
  getBrowserOwnerAccess: mocks.getBrowserOwnerAccess,
}));
vi.mock("@/core/chat", () => ({ streamTurn: mocks.streamTurn }));
vi.mock("@/core/conversations", () => ({
  createConversation: mocks.createConversation,
  getConversation: mocks.getConversation,
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
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "signed_out",
    canAccessPrivateData: false,
    account: null,
    db: null,
    message: "Log in to access this Zeus memory store.",
  });
});

describe("chat API access boundaries", () => {
  it("rejects signed-out chat before parsing or starting model work", async () => {
    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", {
        method: "POST",
        body: "not-json",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Log in to access this Zeus memory store.",
    });
    expect(mocks.getBrowserOwnerAccess).toHaveBeenCalledWith(
      expect.any(Request),
      "private-mutation",
    );
    expect(mocks.hasCredentials).not.toHaveBeenCalled();
    expect(mocks.streamTurn).not.toHaveBeenCalled();
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it("fails closed for an unavailable account check", async () => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "unavailable",
      canAccessPrivateData: false,
      account: null,
      db: null,
      message: "Zeus could not verify the account right now. Private memory stayed locked.",
    });

    const response = await postChat(
      jsonRequest("/api/chat", { input: "Remember this" }),
    );

    expect(response.status).toBe(503);
    expect(mocks.streamTurn).not.toHaveBeenCalled();
  });

  it("rejects non-JSON content after authorization", async () => {
    authorizeChat({ private: true });
    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ input: "Spend the local model quota" }),
      }),
    );

    expect(response.status).toBe(415);
    expect(mocks.getBrowserOwnerAccess).toHaveBeenCalledOnce();
    expect(mocks.streamTurn).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized, and transcript-bearing payloads", async () => {
    authorizeChat({ private: true });
    const malformed = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    const oversizedInput = await postChat(
      jsonRequest("/api/chat", { input: "x".repeat(4_001) }),
    );
    const transcript = await postChat(
      jsonRequest("/api/chat", {
        input: "hello",
        history: [{ role: "assistant", content: "Client-supplied transcript" }],
      }),
    );

    expect(malformed.status).toBe(400);
    expect(oversizedInput.status).toBe(400);
    expect(transcript.status).toBe(400);
    expect(mocks.hasCredentials).not.toHaveBeenCalled();
    expect(mocks.streamTurn).not.toHaveBeenCalled();
  });

  it("rejects an authenticated account that does not own the store", async () => {
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
    expect(mocks.getConversation).not.toHaveBeenCalled();
    expect(mocks.streamTurn).not.toHaveBeenCalled();
  });

  it("checks model credentials only after authorizing and validating the request", async () => {
    authorizeChat({ private: true });
    mocks.hasCredentials.mockReturnValue(false);

    const response = await postChat(jsonRequest("/api/chat", { input: "Hello" }));

    expect(response.status).toBe(503);
    expect(mocks.hasCredentials).toHaveBeenCalledOnce();
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.streamTurn).not.toHaveBeenCalled();
  });

  it("streams an authorized turn through the durable-memory path", async () => {
    const db = { private: true };
    authorizeChat(db);
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
      }),
    );

    expect(response.status).toBe(200);
    await expect(ndjson(response)).resolves.toEqual([
      { type: "meta", conversationId: 7 },
      { type: "delta", text: "Owner reply" },
      expect.objectContaining({
        type: "done",
        messageId: 9,
        recalled: 0,
        extractionFailed: true,
      }),
    ]);
    expect(mocks.streamTurn).toHaveBeenCalledWith(db, {
      conversationId: 7,
      input: "Use my saved context",
      onDelta: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
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

function authorizeChat(db: unknown): void {
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "authorized",
    canAccessPrivateData: true,
    account: { id: "owner", email: "owner@example.com" },
    db,
    message: null,
  });
}

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

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrowserOwnerAccess: vi.fn(),
  getMemoryJob: vi.fn(),
  undoMemoryJob: vi.fn(),
  wakeMemoryJobRunner: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({
  getBrowserOwnerAccess: mocks.getBrowserOwnerAccess,
}));
vi.mock("@/core/memory-jobs", () => ({
  getMemoryJob: mocks.getMemoryJob,
  undoMemoryJob: mocks.undoMemoryJob,
}));
vi.mock("@/server/memory-job-runner", () => ({
  wakeMemoryJobRunner: mocks.wakeMemoryJobRunner,
}));

import { GET } from "./[id]/route";
import { POST as undo } from "./[id]/undo/route";

const context = { params: Promise.resolve({ id: "job_safe_id" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "authorized",
    canAccessPrivateData: true,
    account: null,
    db: { private: true },
    message: null,
  });
});

describe("memory job API", () => {
  it("guards reads before looking up a job", async () => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "signed_out",
      canAccessPrivateData: false,
      account: null,
      db: null,
      message: "Log in.",
    });
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(401);
    expect(mocks.getMemoryJob).not.toHaveBeenCalled();
  });

  it("returns a pending job immediately and wakes the server runner", async () => {
    mocks.getMemoryJob.mockReturnValue({ id: "job_safe_id", status: "pending" });
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      job: { id: "job_safe_id", status: "pending" },
    });
    expect(mocks.wakeMemoryJobRunner).toHaveBeenCalledWith(
      expect.objectContaining({ private: true }),
    );
  });

  it("returns 409 when deterministic undo detects a later touch", async () => {
    mocks.undoMemoryJob.mockReturnValue({
      outcome: "conflict",
      job: {
        id: "job_safe_id",
        status: "completed",
        items: [],
        canUndo: false,
        undone: false,
        error: null,
      },
    });
    const response = await undo(request("POST"), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      job: { canUndo: false },
    });
  });

  it("returns the completed job after a safe undo", async () => {
    mocks.undoMemoryJob.mockReturnValue({
      outcome: "undone",
      job: {
        id: "job_safe_id",
        status: "completed",
        items: [],
        canUndo: false,
        undone: true,
        error: null,
      },
    });
    const response = await undo(request("POST"), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ job: { undone: true } });
  });
});

function request(method: "GET" | "POST"): Request {
  return new Request("http://127.0.0.1:3000/api/memory-jobs/job_safe_id", {
    method,
    headers: {
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      Host: "127.0.0.1:3000",
      Origin: "http://127.0.0.1:3000",
      "Sec-Fetch-Site": "same-origin",
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

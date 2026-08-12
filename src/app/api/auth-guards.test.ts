import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrowserOwnerAccess: vi.fn(),
}));

vi.mock("@/server/auth/access", () => ({
  getBrowserOwnerAccess: mocks.getBrowserOwnerAccess,
}));

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
  mocks.getBrowserOwnerAccess.mockResolvedValue({
    state: "signed_out",
    canAccessPrivateData: false,
    account: null,
    db: null,
    message: "Log in to access this Zeus memory store.",
  });
});

describe("private API auth guards", () => {
  it("rejects chat writes before parsing or opening the memory store", async () => {
    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", { method: "POST", body: "not-json" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Log in to access this Zeus memory store.",
    });
  });

  it("rejects follow-through mutations for signed-out requests", async () => {
    const response = await postFollowThrough(
      new Request("http://127.0.0.1:3000/api/follow-through", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.getBrowserOwnerAccess).toHaveBeenCalledOnce();
  });

  it("distinguishes an authenticated but unlinked account", async () => {
    mocks.getBrowserOwnerAccess.mockResolvedValue({
      state: "wrong_account",
      canAccessPrivateData: false,
      account: null,
      db: null,
      message: "This Zeus memory store is already linked to a different account.",
    });

    const response = await postChat(
      new Request("http://127.0.0.1:3000/api/chat", { method: "POST", body: "{}" }),
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

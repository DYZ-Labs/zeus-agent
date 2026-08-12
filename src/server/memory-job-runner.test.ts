import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasUnfinishedMemoryJobs: vi.fn(),
  processPendingMemoryJobs: vi.fn(),
  recoverInterruptedMemoryJobs: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/core/memory-jobs", () => mocks);

import { wakeMemoryJobRunner } from "./memory-job-runner";

describe("memory job runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recoverInterruptedMemoryJobs.mockReturnValue(1);
    mocks.processPendingMemoryJobs.mockResolvedValue(0);
    mocks.hasUnfinishedMemoryJobs.mockReturnValue(false);
  });

  it("releases restart leases once and drains work off-request", async () => {
    const db = { local: true };
    wakeMemoryJobRunner(db as never);

    await vi.waitFor(() => {
      expect(mocks.processPendingMemoryJobs).toHaveBeenCalledWith(db);
    });
    expect(mocks.recoverInterruptedMemoryJobs).toHaveBeenCalledOnce();
  });
});

import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logResolvedModelOnce: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./core/openai", () => ({
  logResolvedModelOnce: mocks.logResolvedModelOnce,
}));

import {
  resetSnapshotScheduler,
  snapshotSchedulerStatus,
} from "./server/snapshot-scheduler";
import { register } from "./instrumentation";

const originalRuntime = process.env.NEXT_RUNTIME;

afterEach(() => {
  mocks.logResolvedModelOnce.mockClear();
  resetSnapshotScheduler();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
});

describe("server instrumentation", () => {
  it("logs the resolved model during Node server startup", async () => {
    process.env.NEXT_RUNTIME = "nodejs";

    await register();

    expect(mocks.logResolvedModelOnce).toHaveBeenCalledOnce();
  });

  it("does not load Node model configuration in the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(mocks.logResolvedModelOnce).not.toHaveBeenCalled();
  });

  it("still comes up, loudly, when the snapshot directory is unusable", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ZEUS_DB", join(tmpdir(), "zeus-instrumentation", "zeus.db"));
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "on");
    // Rejected outright: the likeliest mistake when the documented workstation path
    // moves onto a container.
    vi.stubEnv("ZEUS_SNAPSHOT_DIR", "relative/not/absolute");

    await expect(register()).resolves.toBeUndefined();

    // A backup directory Zeus cannot use is serious, and it does not stop this process
    // serving the person whose memory it holds. Refusing to boot over it would be the
    // same mistake the health endpoint exists to stop making — so it is loud instead,
    // in the log and on /api/health, and the server still comes up.
    expect(snapshotSchedulerStatus().state).toBe("misconfigured");
    const events = stderr.mock.calls.map(([line]) => String(line));
    expect(events).toContainEqual(
      expect.stringContaining('"reason":"invalid_snapshot_directory"'),
    );
    // The rest of startup still ran, rather than stopping at the backup.
    expect(mocks.logResolvedModelOnce).toHaveBeenCalledOnce();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  embeddingStatus: vi.fn(),
  hasCredentials: vi.fn(),
  getAuthConfiguration: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/core/embed", () => ({ embeddingStatus: mocks.embeddingStatus }));
vi.mock("@/core/openai", () => ({ hasCredentials: mocks.hasCredentials }));
vi.mock("@/server/auth/config", () => ({
  getAuthConfiguration: mocks.getAuthConfiguration,
}));

import { openTestDb } from "@/core/db";
import { MIGRATIONS } from "@/core/migrations";
import {
  resetSnapshotScheduler,
  startSnapshotScheduler,
} from "@/server/snapshot-scheduler";
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getDb.mockReturnValue(openTestDb());
  mocks.embeddingStatus.mockReturnValue("ready");
  mocks.hasCredentials.mockReturnValue(true);
  mocks.getAuthConfiguration.mockReturnValue({ mode: "configured" });
});

afterEach(() => {
  resetSnapshotScheduler();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("health check", () => {
  it("reports the schema version and subsystem state when the store opens", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      store: {
        status: "ok",
        migrations_applied: MIGRATIONS.length,
        migrations_expected: MIGRATIONS.length,
      },
      auth: "configured",
      embeddings: "ready",
      model: "configured",
      // A backup that quietly stopped is the failure the subsystem exists to prevent.
      snapshots: {
        state: "not_started",
        intervalHours: null,
        lastResult: null,
        lastRunAt: null,
      },
    });
  });

  it("surfaces a scheduler that has stopped backing stores up", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_SCHEDULER", "off");
    startSnapshotScheduler();

    const body = await (await GET()).json();

    // Still serving, so still 200 — but the backups are visibly not running.
    expect(body.status).toBe("ok");
    expect(body.snapshots.state).toBe("disabled");
  });

  it("fails with 503 when the store cannot be opened", async () => {
    // The case the check exists for: the process is listening, the volume is not there.
    mocks.getDb.mockImplementation(() => {
      throw new Error("unable to open database file: /data/zeus.db");
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("unavailable");
    expect(body.store.status).toBe("error");
    // A path is operational detail, but the message may not be ours to repeat.
    expect(JSON.stringify(body)).not.toContain("/data/zeus.db");
    expect(body.store.error_name).toBe("Error");
  });

  it("surfaces a silent retrieval downgrade rather than reporting plain health", async () => {
    mocks.embeddingStatus.mockReturnValue("unavailable");

    const response = await GET();

    // Still serving, so still 200 — but an operator can see recall got worse.
    expect(response.status).toBe(200);
    expect((await response.json()).embeddings).toBe("unavailable");
  });

  it("answers while auth itself is misconfigured", async () => {
    mocks.getAuthConfiguration.mockReturnValue({
      mode: "misconfigured",
      message: "Supabase login needs a project URL",
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).auth).toBe("misconfigured");
  });

  it("never reports whether a key exists beyond a boolean-ish label", async () => {
    mocks.hasCredentials.mockReturnValue(false);

    const body = await (await GET()).json();

    expect(body.model).toBe("absent");
    expect(JSON.stringify(body)).not.toMatch(/sk-|key/iu);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ambientRefreshSettings } from "@/core/ambient";
import { openDb } from "@/core/db";
import {
  ambientSchedulerStatus,
  resetAmbientScheduler,
  runDueSignalRefresh,
  startAmbientScheduler,
} from "./ambient-scheduler";

const ACCOUNT = "019ff232-f8e0-7ce2-8e83-d416444aed06";
const temporaryDirectories: string[] = [];

let primary: string;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const base = mkdtempSync(join(tmpdir(), "zeus-ambient-"));
  temporaryDirectories.push(base);
  primary = join(base, "zeus.db");
  openDb(primary).close();
  mkdirSync(join(base, "accounts"));
  openDb(join(base, "accounts", `${ACCOUNT}.db`)).close();
  vi.stubEnv("ZEUS_DB", primary);
});

afterEach(() => {
  resetAmbientScheduler();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("who is responsible for refreshing signals", () => {
  it("stays off locally, where a LaunchAgent already does it", () => {
    expect(ambientRefreshSettings({ mode: "local" }, { NODE_ENV: "production" })).toMatchObject({
      enabled: false,
      reason: "not_hosted",
    });
  });

  it("runs on a hosted deployment, where nothing else would", () => {
    expect(
      ambientRefreshSettings({ mode: "configured" }, { NODE_ENV: "production" }),
    ).toMatchObject({ enabled: true, reason: "hosted" });
  });

  it("can be forced either way, and refuses a setting it cannot read", () => {
    expect(
      ambientRefreshSettings({ mode: "local" }, { ZEUS_SIGNAL_REFRESH: "on" }),
    ).toMatchObject({ enabled: true, reason: "explicitly_enabled" });
    expect(
      ambientRefreshSettings(
        { mode: "configured" },
        { NODE_ENV: "production", ZEUS_SIGNAL_REFRESH: "off" },
      ),
    ).toMatchObject({ enabled: false, reason: "explicitly_disabled" });
    expect(() => ambientRefreshSettings({ mode: "local" }, { ZEUS_SIGNAL_REFRESH: "maybe" }))
      .toThrow(/must be 'on' or 'off'/u);
  });

  it("clamps an unreasonable interval and refuses one that is not a number", () => {
    expect(ambientRefreshSettings({ mode: "local" }, { ZEUS_SIGNAL_REFRESH_MINUTES: "1" })
      .intervalMinutes).toBe(5);
    expect(ambientRefreshSettings({ mode: "local" }, { ZEUS_SIGNAL_REFRESH_MINUTES: "9000" })
      .intervalMinutes).toBe(180);
    expect(() =>
      ambientRefreshSettings({ mode: "local" }, { ZEUS_SIGNAL_REFRESH_MINUTES: "half an hour" }),
    ).toThrow(/whole number/u);
  });
});

describe("the hosted refresh tick", () => {
  it("does not start when it is not this process's job", () => {
    vi.stubEnv("ZEUS_SIGNAL_REFRESH", "off");
    const settings = startAmbientScheduler();

    expect(settings.enabled).toBe(false);
    expect(ambientSchedulerStatus()).toMatchObject({ enabled: false });
  });

  it("visits every store and reports a clean pass", async () => {
    vi.stubEnv("ZEUS_SIGNAL_REFRESH", "on");
    startAmbientScheduler();
    await runDueSignalRefresh();

    // Neither store has a calendar connected, which is the ordinary case and not a
    // failure: the pass is clean and the detectors ran over an empty cache.
    expect(ambientSchedulerStatus()).toMatchObject({ enabled: true, lastResult: "ok" });
    expect(ambientSchedulerStatus()?.lastRunAt).not.toBeNull();
  });

  it("keeps going when one store cannot be opened", async () => {
    vi.stubEnv("ZEUS_SIGNAL_REFRESH", "on");
    // Still a regular file, so it is listed as a store and genuinely attempted — which is
    // what makes this a test of the per-store isolation rather than of the enumeration.
    writeFileSync(primary, "this is not a database");
    startAmbientScheduler();
    await runDueSignalRefresh();

    // The account store still got its pass; only the primary failed.
    expect(ambientSchedulerStatus()?.lastResult).toBe("partial");
  });

  it("joins a run already in flight instead of starting a rival one", async () => {
    vi.stubEnv("ZEUS_SIGNAL_REFRESH", "on");
    startAmbientScheduler();
    const first = runDueSignalRefresh();
    const second = runDueSignalRefresh();

    expect(second).toBe(first);
    await first;
  });

  it("leaves no timer behind when started twice", () => {
    vi.stubEnv("ZEUS_SIGNAL_REFRESH", "on");
    const clear = vi.spyOn(globalThis, "clearInterval");
    startAmbientScheduler();
    startAmbientScheduler();

    expect(clear).toHaveBeenCalled();
  });
});

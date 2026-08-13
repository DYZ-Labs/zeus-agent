import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CONCURRENT_WORK_RUNS,
  acquireWorkRunSlot,
  activeWorkRuns,
  configuredMaxConcurrentWorkRuns,
  resetWorkRunSlots,
} from "./concurrency";

afterEach(() => resetWorkRunSlots());

describe("bounded work run capacity", () => {
  it("hands out slots up to the limit and then refuses", () => {
    const first = acquireWorkRunSlot(2);
    const second = acquireWorkRunSlot(2);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(activeWorkRuns()).toBe(2);
    // A 900-second run must not be able to occupy the process without limit.
    expect(acquireWorkRunSlot(2)).toBeNull();
  });

  it("frees capacity when a run finishes", () => {
    const release = acquireWorkRunSlot(1);
    expect(acquireWorkRunSlot(1)).toBeNull();

    release!();

    expect(activeWorkRuns()).toBe(0);
    expect(acquireWorkRunSlot(1)).not.toBeNull();
  });

  it("ignores a repeated release rather than inventing capacity", () => {
    const release = acquireWorkRunSlot(2);
    acquireWorkRunSlot(2);

    release!();
    release!();
    release!();

    // One release, one slot back — not three.
    expect(activeWorkRuns()).toBe(1);
  });

  it("reads the limit from the environment and rejects a nonsense value", () => {
    expect(configuredMaxConcurrentWorkRuns({})).toBe(DEFAULT_MAX_CONCURRENT_WORK_RUNS);
    expect(configuredMaxConcurrentWorkRuns({ ZEUS_MAX_CONCURRENT_WORK_RUNS: "5" })).toBe(5);
    expect(() =>
      configuredMaxConcurrentWorkRuns({ ZEUS_MAX_CONCURRENT_WORK_RUNS: "0" }),
    ).toThrow(/positive integer/u);
  });
});

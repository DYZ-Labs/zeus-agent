import { logEvent } from "./observability";

/**
 * How many bounded work runs this process will execute at once.
 *
 * A run holds its request open for up to 900 seconds while it makes model and tool
 * calls. Zeus serves from a single Node process, so a handful of concurrent runs starve
 * ordinary chat traffic behind them — the slow path crowding out the interactive one.
 *
 * Deliberately in memory, unlike the spend counters: this bounds *this process's*
 * capacity, and a restart really does free every slot. It follows that the cap is per
 * process, so running more than one instance multiplies it.
 */
export const DEFAULT_MAX_CONCURRENT_WORK_RUNS = 2;

const globalForRuns = globalThis as typeof globalThis & {
  zeusActiveWorkRuns?: number;
};

export function configuredMaxConcurrentWorkRuns(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.ZEUS_MAX_CONCURRENT_WORK_RUNS?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_WORK_RUNS;
  if (!/^\d+$/u.test(raw)) {
    throw new Error("ZEUS_MAX_CONCURRENT_WORK_RUNS must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("ZEUS_MAX_CONCURRENT_WORK_RUNS must be a positive integer");
  }
  return value;
}

export function activeWorkRuns(): number {
  return globalForRuns.zeusActiveWorkRuns ?? 0;
}

/**
 * Take a run slot, or return null when the process is already at capacity.
 *
 * The returned release is idempotent so a caller can put it in a `finally` without
 * worrying whether an earlier path already released it; double-release would otherwise
 * leak capacity that does not exist.
 */
export function acquireWorkRunSlot(limit = configuredMaxConcurrentWorkRuns()): null | (() => void) {
  const active = activeWorkRuns();
  if (active >= limit) {
    logEvent({
      event: "work_run_rejected",
      outcome: "error",
      reason: "at_capacity",
      count: active,
    });
    return null;
  }

  globalForRuns.zeusActiveWorkRuns = active + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalForRuns.zeusActiveWorkRuns = Math.max(0, activeWorkRuns() - 1);
  };
}

/** Tests only: forget any slot a failed assertion left held. */
export function resetWorkRunSlots(): void {
  globalForRuns.zeusActiveWorkRuns = 0;
}

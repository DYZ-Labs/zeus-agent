import "server-only";

import type { Db } from "@/core/db";
import {
  hasUnfinishedMemoryJobs,
  processPendingMemoryJobs,
  recoverInterruptedMemoryJobs,
} from "@/core/memory-jobs";

const RECOVERY_INTERVAL_MS = 30_000;

type RunnerState = {
  initialized: boolean;
  running: boolean;
  rerunRequested: boolean;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
};

const globalForMemoryJobs = globalThis as unknown as {
  zeusMemoryJobRunner?: RunnerState;
};

function runnerState(): RunnerState {
  globalForMemoryJobs.zeusMemoryJobRunner ??= {
    initialized: false,
    running: false,
    rerunRequested: false,
    recoveryTimer: null,
  };
  return globalForMemoryJobs.zeusMemoryJobRunner;
}

/**
 * Wake the process-local durable worker and return immediately.
 *
 * Work ownership lives in SQLite rather than this process: a restart loses only this
 * scheduling hint. The next server entrypoint calls this function again, while the
 * recovery timer keeps checking leased work after transient failures or stale claims.
 */
export function wakeMemoryJobRunner(db: Db): void {
  const state = runnerState();
  if (!state.initialized) {
    // Only this process can own a local worker. On a real process restart, every
    // persisted running lease belongs to the dead predecessor and is resumable now.
    recoverInterruptedMemoryJobs(db);
    state.initialized = true;
  }
  state.rerunRequested = true;
  if (state.running) return;
  state.running = true;
  queueMicrotask(() => void run(db, state));
}

async function run(db: Db, state: RunnerState): Promise<void> {
  try {
    do {
      state.rerunRequested = false;
      const processed = await processPendingMemoryJobs(db);
      if (processed > 0 && hasUnfinishedMemoryJobs(db)) {
        state.rerunRequested = true;
      }
    } while (state.rerunRequested);
  } catch (error) {
    console.warn(
      `[zeus] background memory worker paused (${error instanceof Error ? error.name : "memory_job_runner_error"})`,
    );
  } finally {
    state.running = false;
    if (state.rerunRequested) wakeMemoryJobRunner(db);
    else scheduleRecovery(db, state);
  }
}

function scheduleRecovery(db: Db, state: RunnerState): void {
  if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
  state.recoveryTimer = null;
  if (!hasUnfinishedMemoryJobs(db)) return;
  state.recoveryTimer = setTimeout(() => {
    state.recoveryTimer = null;
    wakeMemoryJobRunner(db);
  }, RECOVERY_INTERVAL_MS);
  state.recoveryTimer.unref?.();
}

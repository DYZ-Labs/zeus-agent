import "server-only";

import { openDb } from "@/core/db";
import { errorSignature, logEvent } from "@/core/observability";
import {
  SNAPSHOT_CHECK_INTERVAL_MS,
  snapshotScheduleSettings,
  storesDueForSnapshot,
  type SnapshotScheduleSettings,
} from "@/core/snapshot-schedule";
import { createVerifiedSnapshot } from "@/core/snapshots";
import { getAuthConfiguration } from "@/server/auth/config";

/**
 * Run the backup the hosted deployment otherwise never runs.
 *
 * A backup job must not be able to take the server down with it, so every failure here
 * is caught and reported: one unreadable store does not stop the others, and no
 * snapshot problem ever reaches a user's request. The timer is unref'd so it cannot
 * hold the process open during a shutdown.
 */

type SchedulerState = {
  settings: SnapshotScheduleSettings;
  timer: ReturnType<typeof setInterval> | null;
  /** The run in flight, so a second caller joins it instead of starting a rival one. */
  pending: Promise<void> | null;
  lastRunAt: string | null;
  lastResult: "ok" | "partial" | "failed" | null;
};

const globalForScheduler = globalThis as typeof globalThis & {
  zeusSnapshotScheduler?: SchedulerState;
};

export function startSnapshotScheduler(): SnapshotScheduleSettings {
  const settings = snapshotScheduleSettings(getAuthConfiguration());

  // Next.js re-evaluates modules on hot reload; without this each edit would leave
  // another timer running against the same store.
  const existing = globalForScheduler.zeusSnapshotScheduler;
  if (existing?.timer) clearInterval(existing.timer);

  const state: SchedulerState = {
    settings,
    timer: null,
    pending: null,
    lastRunAt: existing?.lastRunAt ?? null,
    lastResult: existing?.lastResult ?? null,
  };
  globalForScheduler.zeusSnapshotScheduler = state;

  if (!settings.enabled) {
    logEvent({
      event: "snapshot_scheduler_disabled",
      outcome: "ok",
      reason: settings.reason,
    });
    return settings;
  }

  const timer = setInterval(() => {
    void runDueSnapshots();
  }, SNAPSHOT_CHECK_INTERVAL_MS);
  // Never keep the process alive for a backup check.
  timer.unref?.();
  state.timer = timer;

  logEvent({
    event: "snapshot_scheduler_started",
    outcome: "ok",
    reason: settings.reason,
    count: settings.intervalHours,
  });

  // A process that was down overnight should back up now, not in an hour.
  void runDueSnapshots();
  return settings;
}

/**
 * Snapshot every store whose newest copy is older than the interval.
 *
 * Exported so the state is observable and a test can drive a tick directly rather than
 * waiting an hour for one.
 */
export function runDueSnapshots(): Promise<void> {
  const state = globalForScheduler.zeusSnapshotScheduler;
  if (!state) return Promise.resolve();
  // A slow run must not overlap the next tick and snapshot the same store twice. A
  // second caller joins the run in flight rather than being told "no" — so awaiting
  // this always means "the work is done", whoever started it.
  state.pending ??= executeDueSnapshots(state).finally(() => {
    state.pending = null;
  });
  return state.pending;
}

async function executeDueSnapshots(state: SchedulerState): Promise<void> {
  try {
    const due = storesDueForSnapshot({ intervalHours: state.settings.intervalHours });
    if (due.length === 0) return;

    let failed = 0;
    for (const store of due) {
      try {
        const db = openDb(store.path);
        try {
          const result = createVerifiedSnapshot(db);
          logEvent({
            event: "snapshot_created",
            outcome: "ok",
            store: store.kind,
            count: result.pruned,
          });
        } finally {
          db.close();
        }
      } catch (error) {
        // One unreadable store must not cost every other account its backup.
        failed += 1;
        logEvent({
          event: "snapshot_failed",
          outcome: "error",
          reason: "snapshot_error",
          store: store.kind,
          ...errorSignature(error),
        });
      }
    }

    state.lastRunAt = new Date().toISOString();
    state.lastResult = failed === 0 ? "ok" : failed === due.length ? "failed" : "partial";
  } catch (error) {
    // Scheduling itself failing is a bug, not a backup problem; report and keep serving.
    state.lastResult = "failed";
    logEvent({
      event: "snapshot_scheduler_error",
      outcome: "error",
      reason: "schedule_failed",
      ...errorSignature(error),
    });
  }
}

export type SnapshotSchedulerStatus = {
  state: "running" | "disabled" | "not_started";
  intervalHours: number | null;
  lastResult: "ok" | "partial" | "failed" | null;
  lastRunAt: string | null;
};

/** Reported by the health endpoint so a silent backup failure is visible. */
export function snapshotSchedulerStatus(): SnapshotSchedulerStatus {
  const state = globalForScheduler.zeusSnapshotScheduler;
  if (!state) {
    return { state: "not_started", intervalHours: null, lastResult: null, lastRunAt: null };
  }
  return {
    state: state.settings.enabled ? "running" : "disabled",
    intervalHours: state.settings.intervalHours,
    lastResult: state.lastResult,
    lastRunAt: state.lastRunAt,
  };
}

/** Tests only: stop the timer and forget any recorded run. */
export function resetSnapshotScheduler(): void {
  const state = globalForScheduler.zeusSnapshotScheduler;
  if (state?.timer) clearInterval(state.timer);
  delete globalForScheduler.zeusSnapshotScheduler;
}

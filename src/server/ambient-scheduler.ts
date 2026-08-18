import "server-only";

import {
  ambientRefreshSettings,
  refreshExternalSignals,
  type AmbientRefreshSettings,
} from "@/core/ambient";
import { openDb } from "@/core/db";
import { errorSignature, logEvent } from "@/core/observability";
import { listStores } from "@/core/stores";

/**
 * Keep the cached calendar — and therefore the standing schedule block and the detectors —
 * current on every deployment.
 *
 * `refreshExternalSignals` had exactly one caller: a macOS LaunchAgent. That is fine on the
 * machine it was written for and leaves a hosted deployment with an `external_signal` table
 * nothing ever writes to — so `calendar_overlap` and its siblings never fired, and Zeus
 * silently lost the half of its stewardship that is supposed to happen without being asked.
 * A chat turn that reads the calendar fills the cache as a side effect, but only for a user
 * who already suspected something; noticing a clash they have not thought about is the
 * whole point.
 *
 * Refresh and detect only. Delivery stays with the worker: `claimAmbientDelivery` and the
 * notifier are about interrupting someone, and a background timer quietly acquiring that
 * power is not a change to make as a side effect of fixing a data-freshness bug.
 *
 * Modelled on the snapshot scheduler, and for the same reasons: a background job must never
 * take the server down with it, one unreadable store must not stop the others, and the timer
 * is unref'd so it cannot hold the process open through a shutdown.
 */

type SchedulerState = {
  settings: AmbientRefreshSettings;
  timer: ReturnType<typeof setInterval> | null;
  /** The run in flight, so a second caller joins it instead of starting a rival one. */
  pending: Promise<void> | null;
  lastRunAt: string | null;
  lastResult: "ok" | "partial" | "failed" | null;
};

const globalForScheduler = globalThis as typeof globalThis & {
  zeusAmbientScheduler?: SchedulerState;
};

export function startAmbientScheduler(): AmbientRefreshSettings {
  let settings: AmbientRefreshSettings;
  try {
    settings = ambientRefreshSettings();
  } catch (error) {
    // A malformed setting is the operator's mistake to see, not a reason to refuse to
    // serve the person whose memory this is. Loud, and off.
    logEvent({
      event: "ambient_scheduler_error",
      outcome: "error",
      reason: "invalid_setting",
      ...errorSignature(error),
    });
    return { enabled: false, intervalMinutes: 0, reason: "invalid_setting" };
  }

  // Next.js re-evaluates modules on hot reload; without this each edit would leave another
  // timer running against the same stores.
  const existing = globalForScheduler.zeusAmbientScheduler;
  if (existing?.timer) clearInterval(existing.timer);

  const state: SchedulerState = {
    settings,
    timer: null,
    pending: null,
    lastRunAt: existing?.lastRunAt ?? null,
    lastResult: existing?.lastResult ?? null,
  };
  globalForScheduler.zeusAmbientScheduler = state;

  if (!settings.enabled) {
    logEvent({
      event: "ambient_scheduler_disabled",
      outcome: "ok",
      reason: settings.reason,
    });
    return settings;
  }

  const timer = setInterval(() => {
    void runDueSignalRefresh();
  }, settings.intervalMinutes * 60_000);
  // Never keep the process alive for a conflict check.
  timer.unref?.();
  state.timer = timer;

  logEvent({
    event: "ambient_scheduler_started",
    outcome: "ok",
    reason: settings.reason,
    count: settings.intervalMinutes,
  });

  // A process that has just come up should look now, not in fifteen minutes.
  void runDueSignalRefresh();
  return settings;
}

/**
 * Refresh every store's calendar cache and re-run the detectors over it.
 *
 * Exported so the state is observable and a test can drive a tick directly rather than
 * waiting a quarter of an hour for one.
 */
export function runDueSignalRefresh(): Promise<void> {
  const state = globalForScheduler.zeusAmbientScheduler;
  if (!state) return Promise.resolve();
  // A slow run must not overlap the next tick and read the same calendar twice against the
  // connector budget. A second caller joins the run in flight rather than being refused.
  state.pending ??= executeSignalRefresh(state).finally(() => {
    state.pending = null;
  });
  return state.pending;
}

async function executeSignalRefresh(state: SchedulerState): Promise<void> {
  try {
    const stores = listStores();
    if (stores.length === 0) return;

    let failed = 0;
    for (const store of stores) {
      try {
        const db = openDb(store.path);
        try {
          const result = await refreshExternalSignals(db);
          // A store with no calendar connected reports `synced: false` and is not a
          // failure — most stores in a deployment will never have one.
          logEvent({
            event: "ambient_signals_refreshed",
            outcome: result.synced ? "ok" : "degraded",
            store: store.kind,
            count: result.detected,
          });
        } finally {
          db.close();
        }
      } catch (error) {
        // One unreadable store must not cost every other account its conflict detection.
        failed += 1;
        logEvent({
          event: "ambient_signals_failed",
          outcome: "error",
          reason: "refresh_error",
          store: store.kind,
          ...errorSignature(error),
        });
      }
    }

    state.lastRunAt = new Date().toISOString();
    state.lastResult = failed === 0 ? "ok" : failed === stores.length ? "failed" : "partial";
  } catch (error) {
    // Scheduling itself failing is a bug, not a calendar problem; report and keep serving.
    state.lastResult = "failed";
    logEvent({
      event: "ambient_scheduler_error",
      outcome: "error",
      reason: "schedule_failed",
      ...errorSignature(error),
    });
  }
}

/** What the last tick did, for tests and for anything that wants to report on it. */
export function ambientSchedulerStatus(): {
  enabled: boolean;
  intervalMinutes: number;
  reason: string;
  lastRunAt: string | null;
  lastResult: "ok" | "partial" | "failed" | null;
} | null {
  const state = globalForScheduler.zeusAmbientScheduler;
  if (!state) return null;
  return {
    enabled: state.settings.enabled,
    intervalMinutes: state.settings.intervalMinutes,
    reason: state.settings.reason,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
  };
}

/** Stop the timer and forget the state, so one test cannot tick into the next. */
export function resetAmbientScheduler(): void {
  const state = globalForScheduler.zeusAmbientScheduler;
  if (state?.timer) clearInterval(state.timer);
  delete globalForScheduler.zeusAmbientScheduler;
}

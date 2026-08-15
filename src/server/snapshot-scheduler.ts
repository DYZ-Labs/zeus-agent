import "server-only";

import { openDb } from "@/core/db";
import { errorSignature, logEvent } from "@/core/observability";
import { replicateSnapshot } from "@/core/snapshot-replication";
import {
  DEFAULT_SNAPSHOT_INTERVAL_HOURS,
  deploymentSnapshotDirectory,
  SNAPSHOT_CHECK_INTERVAL_MS,
  snapshotScheduleSettings,
  storesDueForSnapshot,
  type SnapshotScheduleSettings,
} from "@/core/snapshot-schedule";
import { createVerifiedSnapshot, latestSnapshotTime } from "@/core/snapshots";
import { listStores } from "@/core/stores";
import { getAuthConfiguration } from "@/server/auth/config";

/**
 * Run the backup the hosted deployment otherwise never runs.
 *
 * A backup job must not be able to take the server down with it, so every failure here
 * is caught and reported: one unreadable store does not stop the others, and no
 * snapshot problem ever reaches a user's request. The timer is unref'd so it cannot
 * hold the process open during a shutdown.
 */

/**
 * How far past its interval a store's newest copy may fall before the deployment is
 * reported as degraded.
 *
 * Due-ness is only asked hourly and a store is copied on the tick after it comes due, so
 * an age a little over the interval is ordinary operation rather than a fault. Six hours
 * is several consecutive missed or failed runs — the thing worth waking someone for —
 * while still catching a stopped backup inside the same day.
 */
export const SNAPSHOT_STALE_GRACE_HOURS = 6;

/**
 * How long a freshness reading stands for.
 *
 * The reading costs a directory listing per store, synchronously, on the request thread
 * of an unauthenticated route that a platform, a scheduled workflow and anyone else may
 * poll as often as they like. A minute of reuse takes that cost off the caller without
 * weakening what the reading means: it is still measured from files on the volume rather
 * than from this module's memory of its last run, which is the entire point of not
 * trusting `lastRunAt`, and the thing being measured moves in hours. Anything that
 * changes the volume drops it immediately.
 */
const FRESHNESS_MAX_AGE_MS = 60_000;

type SchedulerState = {
  settings: SnapshotScheduleSettings;
  /**
   * The one directory every side of the schedule names, or null when the configuration
   * cannot name one at all.
   */
  directory: string | null;
  timer: ReturnType<typeof setInterval> | null;
  /** The run in flight, so a second caller joins it instead of starting a rival one. */
  pending: Promise<void> | null;
  lastRunAt: string | null;
  lastResult: "ok" | "partial" | "failed" | null;
};

const globalForScheduler = globalThis as typeof globalThis & {
  zeusSnapshotScheduler?: SchedulerState;
  zeusSnapshotFreshness?: { at: number; freshness: SnapshotFreshness };
};

export function startSnapshotScheduler(): SnapshotScheduleSettings {
  const settings = snapshotScheduleSettings(getAuthConfiguration());

  // Next.js re-evaluates modules on hot reload; without this each edit would leave
  // another timer running against the same store.
  const existing = globalForScheduler.zeusSnapshotScheduler;
  if (existing?.timer) clearInterval(existing.timer);

  const state: SchedulerState = {
    settings,
    directory: resolveSnapshotDirectory(settings),
    timer: null,
    pending: null,
    lastRunAt: existing?.lastRunAt ?? null,
    lastResult: existing?.lastResult ?? null,
  };
  globalForScheduler.zeusSnapshotScheduler = state;
  // A reading taken against the previous start's directory says nothing about this one.
  forgetSnapshotFreshness();

  if (!settings.enabled) {
    logEvent({
      event: "snapshot_scheduler_disabled",
      outcome: "ok",
      reason: settings.reason,
    });
    return settings;
  }

  // Enabled with nowhere to write. Already logged and already reported as
  // `misconfigured`; a timer would only run to no effect.
  if (state.directory === null) return settings;

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
 * Resolve the snapshot directory once, at start, for every side of the schedule.
 *
 * The due check, the write, and the freshness the health endpoint reports are all handed
 * this one string. No side may fall back to its own resolution, because a directory the
 * writer and the reader disagree about is a backup that runs and cannot be found — and a
 * reader that resolves its own follows `ZEUS_SNAPSHOT_DIR` as it stands at request time,
 * which is not necessarily the directory the copies were written into.
 *
 * That is why it happens even for a scheduler that is switched off: the freshness reading
 * still runs on every health check, and the only way it cannot drift is for there to be
 * nothing for it to drift from. A directory a disabled scheduler was never going to write
 * to is not worth an error line, though — that would be an alarm about a decision the
 * operator made — so the failure is reported only when something meant to write there.
 *
 * Resolving at start is also the only place a bad `ZEUS_SNAPSHOT_DIR` can be seen. A
 * relative path and a filesystem root are both refused — the likeliest mistake when moving
 * from a workstation path onto a container — and inside the run that refusal was
 * indistinguishable from "no store is due", so the scheduler reported itself running
 * forever while writing no backup at all.
 *
 * Deliberately not a refusal to start the server, unlike an unusable ZEUS_DB. A backup
 * directory Zeus cannot write to is serious, but it does not stop this process serving the
 * person whose memory it holds, and taking the deployment down over it would be the same
 * mistake the health endpoint exists to stop making. It is loud instead: logged here,
 * reported as `misconfigured`, and degraded on /api/health until it is fixed.
 */
function resolveSnapshotDirectory(settings: SnapshotScheduleSettings): string | null {
  try {
    return deploymentSnapshotDirectory();
  } catch (error) {
    if (settings.enabled) {
      logEvent({
        event: "snapshot_scheduler_error",
        outcome: "error",
        reason: "invalid_snapshot_directory",
        ...errorSignature(error),
      });
    }
    return null;
  }
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
  // The directory the scheduler started with. A run that cannot name one has nowhere to
  // put a copy; it is already reported as misconfigured and must not quietly invent a
  // second destination here.
  const directory = state.directory;
  if (directory === null) return;

  try {
    const due = storesDueForSnapshot({
      intervalHours: state.settings.intervalHours,
      directory,
    });
    if (due.length === 0) return;

    let failed = 0;
    for (const store of due) {
      let replicable: string | null = null;
      try {
        const db = openDb(store.path);
        try {
          const result = createVerifiedSnapshot(db, { directory });
          replicable = result.path;
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

      // Deliberately outside the try, and deliberately not counted in `failed`: the copy
      // leaving the volume is a second, weaker guarantee than the snapshot existing on it.
      // A verified snapshot is already a success, and reporting it as a failure because an
      // off-box upload timed out would make the two indistinguishable in the log — exactly
      // the confusion the health endpoint reports them separately to avoid. The store is
      // closed by now, so a slow upload holds no connection open.
      if (replicable !== null) await replicateSnapshot(replicable);
    }

    state.lastRunAt = new Date().toISOString();
    state.lastResult = failed === 0 ? "ok" : failed === due.length ? "failed" : "partial";
    // The volume just changed. A store that was `never` a moment ago is copied now, and
    // reporting the older reading for the rest of its window would raise a backup alarm
    // about a backup that has just been taken.
    forgetSnapshotFreshness();
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

export type SnapshotFreshness = {
  /**
   * `fresh` and `stale` are measured ages. `never` means at least one store has no copy
   * at all, `unknown` means the volume could not be read to find out, and
   * `not_applicable` means there is no store on disk to copy.
   */
  state: "fresh" | "stale" | "never" | "unknown" | "not_applicable";
  /** Whole hours since the newest copy of the least recently copied store. */
  oldestAgeHours: number | null;
};

export type SnapshotSchedulerStatus = {
  state: "running" | "misconfigured" | "disabled" | "not_started";
  intervalHours: number | null;
  lastResult: "ok" | "partial" | "failed" | null;
  lastRunAt: string | null;
  /** Read from the volume, so a process that has never run a backup cannot look idle. */
  freshness: SnapshotFreshness;
};

/** Reported by the health endpoint so a silent backup failure is visible. */
export function snapshotSchedulerStatus(): SnapshotSchedulerStatus {
  const state = globalForScheduler.zeusSnapshotScheduler;
  if (!state) {
    return {
      state: "not_started",
      intervalHours: null,
      lastResult: null,
      lastRunAt: null,
      // Still measured. A scheduler that never started is exactly the case where the
      // remembered fields above have nothing to say and the volume has everything.
      freshness: snapshotFreshness(),
    };
  }
  return {
    state: schedulerState(state),
    intervalHours: state.settings.intervalHours,
    lastResult: state.lastResult,
    lastRunAt: state.lastRunAt,
    freshness: snapshotFreshness(state),
  };
}

function schedulerState(state: SchedulerState): SnapshotSchedulerStatus["state"] {
  if (!state.settings.enabled) return "disabled";
  // Enabled, but with nowhere to write: it will never produce a copy however long it
  // runs, which is not the same claim as "running".
  return state.directory === null ? "misconfigured" : "running";
}

/**
 * How old the least recently copied store's newest snapshot is, read from disk.
 *
 * Deliberately not this module's memory of its last run. `lastResult: null` means both
 * "nothing has come due yet" and "this process has never run a backup at all", so the one
 * field meant to catch a silently stopped backup could not tell fine from never — and a
 * restart reset it to the reassuring answer. Files on the volume cannot lie about that,
 * and they outlive every restart that clears the state above.
 *
 * Cheap on purpose: it stats snapshot filenames and opens no database, which is what
 * keeps it affordable on a route a platform polls — and reused for a minute on top of
 * that, because the listing is per store and the route is public.
 */
function snapshotFreshness(state?: SchedulerState): SnapshotFreshness {
  const cached = globalForScheduler.zeusSnapshotFreshness;
  if (cached && Date.now() - cached.at < FRESHNESS_MAX_AGE_MS) return cached.freshness;
  const freshness = measureSnapshotFreshness(state);
  globalForScheduler.zeusSnapshotFreshness = { at: Date.now(), freshness };
  return freshness;
}

function measureSnapshotFreshness(state?: SchedulerState): SnapshotFreshness {
  // A scheduler that never started has no settings to read; the default interval is the
  // same one it would have used, and the reported `intervalHours` says it is unknown.
  const intervalHours = state?.settings.intervalHours ?? DEFAULT_SNAPSHOT_INTERVAL_HOURS;
  try {
    const stores = listStores();
    // No store on disk is not a missing backup. An in-memory or not-yet-created store has
    // nothing to copy, and calling that a stopped backup would fire on every developer
    // machine until the field stopped meaning anything.
    if (stores.length === 0) return { state: "not_applicable", oldestAgeHours: null };

    // The string the scheduler resolved at start, with no fallback of its own: see
    // `resolveSnapshotDirectory`. With no scheduler in this process there is no start-time
    // value to inherit and the health endpoint still has to answer, which is the single
    // place resolution happens anywhere else.
    const directory = state ? state.directory : deploymentSnapshotDirectory();
    if (directory === null) return { state: "unknown", oldestAgeHours: null };

    const times: number[] = [];
    for (const store of stores) {
      const latest = latestSnapshotTime(store.path, directory);
      // One store with no copy at all is the whole answer. Averaging it away with the
      // others would hide precisely the account that is unprotected.
      if (latest === null) return { state: "never", oldestAgeHours: null };
      times.push(latest.getTime());
    }

    // A clock that moved backwards leaves a copy dated in the future. The due check
    // already treats that as due, so it corrects itself on the next tick rather than
    // being reported as a fault here.
    const ageMs = Math.max(0, Date.now() - Math.min(...times));
    return {
      state: ageMs >= (intervalHours + SNAPSHOT_STALE_GRACE_HOURS) * 3_600_000
        ? "stale"
        : "fresh",
      oldestAgeHours: Math.floor(ageMs / 3_600_000),
    };
  } catch {
    // Failing to read the volume is not evidence that the backup is fine, so it gets its
    // own state rather than the fresh one.
    return { state: "unknown", oldestAgeHours: null };
  }
}

function forgetSnapshotFreshness(): void {
  delete globalForScheduler.zeusSnapshotFreshness;
}

/** Tests only: stop the timer and forget any recorded run. */
export function resetSnapshotScheduler(): void {
  const state = globalForScheduler.zeusSnapshotScheduler;
  if (state?.timer) clearInterval(state.timer);
  delete globalForScheduler.zeusSnapshotScheduler;
  forgetSnapshotFreshness();
}

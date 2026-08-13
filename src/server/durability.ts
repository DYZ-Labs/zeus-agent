import "server-only";

import { checkpointWal } from "@/core/db";
import { logEvent } from "@/core/observability";
import { openStoreHandles } from "@/server/db";

/**
 * Keep the write-ahead log from growing without bound, and fold it back in on the way
 * out.
 *
 * Nothing previously checkpointed a long-lived server's WAL, so it grew for the life of
 * the process and every restart began with recovery work it did not need to do.
 *
 * Two modes, because the safe choice differs by context. In the background, TRUNCATE
 * empties the WAL file, which needs exclusive access and is worth briefly waiting for.
 * During shutdown, PASSIVE never waits for a reader — a redeploy must not be delayed,
 * and a request still in flight must not find its store yanked away.
 */

export const WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1_000;

type DurabilityState = {
  timer: ReturnType<typeof setInterval> | null;
  shuttingDown: boolean;
};

const globalForDurability = globalThis as typeof globalThis & {
  zeusDurability?: DurabilityState;
};

function state(): DurabilityState {
  return (globalForDurability.zeusDurability ??= { timer: null, shuttingDown: false });
}

export function startDurabilityMaintenance(): void {
  const current = state();
  // Next.js re-evaluates modules on hot reload; without this each edit adds a timer.
  if (current.timer) clearInterval(current.timer);

  const timer = setInterval(() => {
    checkpointOpenStores("TRUNCATE");
  }, WAL_CHECKPOINT_INTERVAL_MS);
  // Never keep the process alive for maintenance.
  timer.unref?.();
  current.timer = timer;

  installShutdownCheckpoint();
}

/**
 * Checkpoint every store this process holds open. Returns how many were folded back in
 * completely; a store that was busy is simply left for the next pass.
 */
export function checkpointOpenStores(mode: "PASSIVE" | "TRUNCATE" = "PASSIVE"): number {
  const handles = openStoreHandles();
  let completed = 0;
  for (const db of handles) {
    if (checkpointWal(db, mode)) completed += 1;
  }
  if (handles.length > 0) {
    logEvent({
      event: "wal_checkpoint",
      outcome: completed === handles.length ? "ok" : "degraded",
      reason: mode === "TRUNCATE" ? "scheduled" : "shutdown",
      count: completed,
    });
  }
  return completed;
}

/**
 * Fold the WAL back in when the process is asked to stop.
 *
 * Registered with `once`, so the listener is gone by the time the body runs. If that
 * leaves no listener at all, this process replaced Node's default action for the
 * signal and must re-raise it to terminate; if another listener remains — the server's
 * own graceful drain — it is left to finish on its own terms.
 *
 * The stores are checkpointed but not closed. Closing them here would pull the database
 * out from under any request still draining, which trades a tidy WAL for a failed turn.
 */
function installShutdownCheckpoint(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      const current = state();
      if (current.shuttingDown) return;
      current.shuttingDown = true;
      if (current.timer) clearInterval(current.timer);

      checkpointOpenStores("PASSIVE");

      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    });
  }
}

/** Tests only: stop the timer and forget the shutdown latch. */
export function resetDurabilityMaintenance(): void {
  const current = globalForDurability.zeusDurability;
  if (current?.timer) clearInterval(current.timer);
  delete globalForDurability.zeusDurability;
}

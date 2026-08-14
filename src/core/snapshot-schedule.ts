import { defaultDbPath } from "./db";
import { defaultSnapshotDirectory, latestSnapshotTime } from "./snapshots";
import { listStores, type StoreLocation } from "./stores";

/**
 * When a hosted Zeus should back itself up.
 *
 * The scheduled snapshot job is a macOS LaunchAgent, which cannot run on the Linux host
 * a hosted deployment actually uses: `npm run snapshot` is portable, but nothing was
 * calling it there. A deployment therefore shipped with a documented, tested backup
 * mechanism that was not running.
 *
 * The scheduler is in-process rather than a platform cron because a mounted volume
 * belongs to one service — a separate cron container would not have the store to copy.
 * Running inside the server that already holds the volume is the only place with both
 * the data and a clock.
 *
 * Due-ness is derived from the newest snapshot on disk rather than from a timer's
 * memory. That is what makes it correct across restarts: a deploy every ten minutes
 * cannot produce a snapshot every ten minutes, and a process that was down all night
 * takes one as soon as it comes back rather than waiting for the next tick.
 */

export const DEFAULT_SNAPSHOT_INTERVAL_HOURS = 24;
/** How often to ask whether a snapshot is due. Cheap: it stats files, opens nothing. */
export const SNAPSHOT_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export type SnapshotScheduleSettings = {
  enabled: boolean;
  intervalHours: number;
  reason: "hosted" | "explicitly_enabled" | "explicitly_disabled" | "not_hosted";
};

/**
 * Enabled by default only for a hosted deployment, which is the case that had no
 * scheduler at all. A developer's machine keeps the explicit LaunchAgent, so `next dev`
 * never grows a surprise background job; `ZEUS_SNAPSHOT_SCHEDULER` overrides either way.
 */
export function snapshotScheduleSettings(
  configuration: { mode: string },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SnapshotScheduleSettings {
  const intervalHours = intervalSetting(environment.ZEUS_SNAPSHOT_INTERVAL_HOURS);
  const configured = environment.ZEUS_SNAPSHOT_SCHEDULER?.trim().toLowerCase();

  if (configured === "off") {
    return { enabled: false, intervalHours, reason: "explicitly_disabled" };
  }
  if (configured === "on") {
    return { enabled: true, intervalHours, reason: "explicitly_enabled" };
  }
  if (configured !== undefined && configured !== "") {
    throw new Error("ZEUS_SNAPSHOT_SCHEDULER must be 'on' or 'off'");
  }

  const hosted =
    configuration.mode === "configured" && environment.NODE_ENV === "production";
  return {
    enabled: hosted,
    intervalHours,
    reason: hosted ? "hosted" : "not_hosted",
  };
}

/**
 * The single directory every store in this deployment snapshots into.
 *
 * Snapshot filenames are scoped by a hash of their source path, so one directory holds
 * every store's copies without one store's retention pruning another's. That scoping is
 * what makes a shared directory the unit an operator replicates off-machine, and it is
 * the layout `npm run snapshot` and `npm run restore` already assume.
 *
 * Resolving it from the *primary* store rather than from each store's own path is the
 * whole point of the function existing. `defaultSnapshotDirectory(store.path)` looks
 * harmless and is what an account store's own path implies, but it puts hosted users'
 * backups in `accounts/snapshots`, where neither the freshness check below nor the
 * documented recovery command looks — a backup that runs, reports success, and cannot
 * be restored. Every side of the schedule must resolve the directory through here.
 */
export function deploymentSnapshotDirectory(primaryPath: string = defaultDbPath()): string {
  return defaultSnapshotDirectory(primaryPath);
}

/**
 * Which stores have gone longer than the interval without a snapshot.
 *
 * Every store is considered independently, so an account added today is backed up today
 * rather than whenever the primary store next comes due.
 */
export function storesDueForSnapshot(
  options: {
    at?: Date;
    intervalHours?: number;
    primaryPath?: string;
    directory?: string;
  } = {},
): StoreLocation[] {
  const at = options.at ?? new Date();
  const intervalMs = (options.intervalHours ?? DEFAULT_SNAPSHOT_INTERVAL_HOURS) * 3_600_000;
  const primaryPath = options.primaryPath ?? defaultDbPath();
  let directory: string;
  try {
    directory = options.directory ?? deploymentSnapshotDirectory(primaryPath);
  } catch {
    return [];
  }

  return listStores(primaryPath).filter((store) => {
    const latest = latestSnapshotTime(store.path, directory);
    if (latest === null) return true;
    // A timestamp in the future means a clock moved backwards, not that a snapshot is
    // fresh forever. Treat it as due rather than letting one bad clock stop backups.
    return latest.getTime() > at.getTime() || at.getTime() - latest.getTime() >= intervalMs;
  });
}

function intervalSetting(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SNAPSHOT_INTERVAL_HOURS;
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error("ZEUS_SNAPSHOT_INTERVAL_HOURS must be a positive integer");
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 365) {
    throw new Error("ZEUS_SNAPSHOT_INTERVAL_HOURS must be between 1 and 8760");
  }
  return value;
}

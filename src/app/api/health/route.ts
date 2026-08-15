import Database from "better-sqlite3";

import { appliedMigrationLedger } from "@/core/db";
import { embeddingStatus } from "@/core/embed";
import { MIGRATIONS } from "@/core/migrations";
import { errorSignature, logEvent } from "@/core/observability";
import { hasCredentials } from "@/core/openai";
import { snapshotReplicationStatus } from "@/core/snapshot-replication";
import { listStores, type StoreLocation } from "@/core/stores";
import { getAuthConfiguration, type AuthConfiguration } from "@/server/auth/config";
import { getDb } from "@/server/db";
import {
  snapshotSchedulerStatus,
  type SnapshotSchedulerStatus,
} from "@/server/snapshot-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this process can actually serve, not merely whether it is listening.
 *
 * The distinction is the point: a Zeus process whose volume vanished still answers `/`
 * with a 200 while every private route fails. So does one whose Supabase variables are
 * wrong, where every `/api/*` returns 503 and every private page redirects to a login
 * that cannot work. A platform reads the status code and nothing else, so a check that
 * answers 200 in those states does worse than nothing: it promotes the broken deployment
 * and retires the working one.
 *
 * Three answers, and the middle one carries the weight. `503` is reserved for states
 * where this process cannot serve anybody and a rollback or a restart is the right
 * response. `200` with `status: "degraded"` is for a real fault that a rollback would not
 * fix — one account's store, or a backup that stopped — because retiring the deployment
 * over it would take everyone down for one tenant without repairing that tenant. `200`
 * with `status: "ok"` is the only reassuring answer, and it is the honest one.
 *
 * Unauthenticated, answering before auth — reporting that auth is broken requires not
 * depending on it — and therefore deliberately empty of user data: fault counts and
 * states only, never a path, an account id, a store list, or how many people this
 * deployment holds memory for.
 */
export async function GET(request: Request): Promise<Response> {
  const started = Date.now();
  const health = storeHealth();
  const configuration = getAuthConfiguration();
  const snapshots = snapshotSchedulerStatus();
  const embeddings = embeddingStatus();
  const verdict = healthVerdict(health.report, configuration, snapshots, request);
  const status = verdict.status === "unavailable" ? 503 : 200;

  logEvent({
    event: "health_check",
    outcome: verdict.outcome,
    status,
    duration_ms: Date.now() - started,
    mode: configuration.mode,
    // How many stores this deployment holds, reported here rather than in the body: the
    // number is genuinely operational, and it is also a live count of people that ticks
    // up when somebody signs up. This stream belongs to the operator; the body is
    // answered to whoever asks.
    count: health.stores,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  });

  return Response.json(
    {
      status: verdict.status,
      store: health.report,
      // Part of the verdict above, not merely a label: a deployment whose auth cannot
      // work is unusable however healthy its store is.
      auth: configuration.mode,
      // "degraded" is honest rather than reassuring: retrieval silently falls back to
      // full-text when the local model cannot load, and that is worth surfacing.
      embeddings,
      model: hasCredentials() ? "configured" : "absent",
      // A backup that quietly stopped running is the failure this whole subsystem
      // exists to prevent, so its state is reported rather than assumed.
      snapshots,
      // A snapshot that only ever exists beside the store is not yet a backup: the
      // volume that loses one loses both. Whether a copy is configured to leave the box,
      // and whether the last one did, are reported so a monitor can alert on either.
      replication: snapshotReplicationStatus(),
    },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

/**
 * The store section of the body.
 *
 * Every count here is a count of *faults*: stores that would not open, stores still
 * waiting for a migration, stores this request declined to wait for. A monitor needs to
 * know that something is broken and how much of it, which none of these numbers can
 * answer without also being small. A tenant count would answer a different question, so
 * it is not here — see the log line above.
 */
type StoreReport = {
  status: "ok" | "degraded" | "error";
  /** Null when the store this process serves from could not be opened at all. */
  migrations_applied: number | null;
  migrations_expected: number;
  unopenable: number;
  behind: number;
  /**
   * Stores this request stopped short of measuring, because another connection held the
   * lock or the probe budget ran out. Reported rather than folded into `unopenable`: a
   * store nobody looked at is not a store that failed, and quietly counting it as one
   * would degrade the deployment every time a snapshot or a source deletion ran.
   */
  unmeasured: number;
  error_name?: string;
  error_site?: string;
};

type StoreHealth = {
  report: StoreReport;
  /** Primary plus accounts. Logged, never answered. */
  stores: number;
};

function storeHealth(): StoreHealth {
  const probe = accountStoreProbe();
  let applied: number | null = null;
  let failure: { error_name: string; error_site?: string } | undefined;

  try {
    applied = appliedMigrationLedger(getDb()).length;
  } catch (error) {
    // The class and code location are safe to return; a message might not be. The
    // machine code the error carried goes to the log, where the field allowlist has the
    // last word on its shape — this body is answered to anyone who asks, so it stays
    // exactly the fields declared above.
    const { error_name, error_site } = errorSignature(error);
    failure = { error_name, ...(error_site ? { error_site } : {}) };
  }

  return {
    report: {
      // The primary store failing means nothing can be served and a rollback may
      // genuinely fix it. An account store failing means one person's private routes
      // fail, which a rollback does not repair, so it is reported as degraded rather
      // than used to pull the whole deployment.
      status: failure ? "error" : probe.unopenable > 0 ? "degraded" : "ok",
      migrations_applied: applied,
      migrations_expected: MIGRATIONS.length,
      unopenable: probe.unopenable + (failure ? 1 : 0),
      behind: probe.behind + (applied !== null && applied < MIGRATIONS.length ? 1 : 0),
      unmeasured: probe.unmeasured,
      ...failure,
    },
    // The primary store is counted whether or not it opened; it exists either way.
    stores: probe.accounts + 1,
  };
}

type AccountStoreProbe = {
  accounts: number;
  unopenable: number;
  behind: number;
  unmeasured: number;
};

/**
 * How long a probe stands for.
 *
 * This is polled every fifteen minutes by a workflow and again on every deployment, so
 * the window collapses bursts — a platform probe, a workflow run and someone's curl
 * during an incident landing together — rather than hiding anything from the poll.
 *
 * It is not the remembered answer this endpoint stopped trusting: a cold process holds no
 * probe, so the first call after every restart measures the volume, and a miss always
 * re-reads it. A cache that can only be too *new* is the safe direction.
 */
const PROBE_MAX_AGE_MS = 60_000;

/**
 * What one request will spend measuring account stores, and what one store may cost it.
 *
 * better-sqlite3 is synchronous and waits five seconds for a lock by default, and Zeus
 * takes those locks from other processes on purpose: `npm run snapshot` runs VACUUM INTO,
 * source deletion runs `VACUUM` and `wal_checkpoint(TRUNCATE)`, `npm run reindex` walks
 * every store. Inheriting that default would let a health check park the single Node
 * thread it shares with every request — instrumentation stalling the thing it exists to
 * report on, ending with the platform's own probe timing out and retiring a deployment
 * that was serving.
 *
 * So the worst case is a property of this file rather than of a library default: with N
 * accounts and every store contended, a request spends at most the budget before it stops
 * probing, plus the one open already in flight — about 1.25 s, whatever N is.
 */
const PROBE_BUDGET_MS = 1_000;
const PROBE_LOCK_TIMEOUT_MS = 250;

/**
 * On globalThis rather than module scope so the bound above is one per process. Next
 * gives instrumentation, route handlers and the scheduler their own module registries,
 * and a per-registry cache would quietly re-probe once per registry per minute.
 */
const globalForProbe = globalThis as typeof globalThis & {
  zeusHealthStoreProbe?: { at: number; probe: AccountStoreProbe };
};

function accountStoreProbe(): AccountStoreProbe {
  const cached = globalForProbe.zeusHealthStoreProbe;
  if (cached && Date.now() - cached.at < PROBE_MAX_AGE_MS) return cached.probe;
  const probe = openEveryAccountStore();
  globalForProbe.zeusHealthStoreProbe = { at: Date.now(), probe };
  return probe;
}

/**
 * The state of every account store, not only the one this process happens to hold open.
 *
 * A deployment serves the primary store plus one isolated database per account, so a
 * check that opened `getDb()` alone reported a healthy 200 while an account's store was
 * corrupt, truncated, or gone and that person's every private route failed.
 *
 * Existence and count are answered by stat alone; whether a store *opens*, and how far
 * its schema has got, are not, and opening a database is the most expensive thing this
 * endpoint does, which is what the window above buys back. Signup is operator-gated, so
 * the fleet is small by construction; if it ever stops being small, that window and the
 * budget below are the knobs.
 */
function openEveryAccountStore(): AccountStoreProbe {
  const probe: AccountStoreProbe = {
    accounts: 0,
    unopenable: 0,
    behind: 0,
    unmeasured: 0,
  };
  let stores: StoreLocation[];
  try {
    stores = listStores();
  } catch {
    // The accounts directory could not be enumerated, which means the volume itself is
    // unreadable — the primary store's own probe reports that, and inventing account
    // counts from a failed listing would be worse than reporting none.
    return probe;
  }

  const started = Date.now();
  const deadline = started + PROBE_BUDGET_MS;
  for (const store of stores) {
    // The primary store is measured through the handle this process actually serves
    // from, which is both free and the more honest probe of the two.
    if (store.kind !== "account") continue;
    probe.accounts += 1;
    // Counting rather than opening, once the budget is spent. A measurement that reports
    // itself partial is honest; a request that keeps paying is the stall this bound
    // exists to prevent.
    if (Date.now() >= deadline) {
      probe.unmeasured += 1;
      continue;
    }
    try {
      if (accountMigrationsApplied(store.path) < MIGRATIONS.length) probe.behind += 1;
    } catch (error) {
      if (writerContention(error)) probe.unmeasured += 1;
      else probe.unopenable += 1;
    }
  }

  // Only a probe that gave up is worth its own line; one per healthy poll would bury it.
  // The endpoint's own `duration_ms` already shows a probe that was merely slow.
  if (probe.unmeasured > 0) {
    logEvent({
      event: "health_store_probe",
      outcome: "degraded",
      reason: "probe_incomplete",
      count: probe.unmeasured,
      duration_ms: Date.now() - started,
    });
  }

  return probe;
}

/**
 * Whether SQLite refused because somebody else held the lock.
 *
 * A store being written to right now is a store that is fine. Reporting contention as a
 * fault would put the deployment in `degraded` for the length of every snapshot run and
 * every source deletion, and a status that goes amber during ordinary operation is one
 * an operator learns to scroll past.
 */
function writerContention(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * Read one account store's migration ledger without migrating it.
 *
 * Never `openDb()`: opening a store the ordinary way runs migrations, and a health check
 * must not change a database on its way to asking a question about it. The claim is that
 * one and no wider — a WAL reader still needs the `-shm` and `-wal` sidecars and creates
 * them beside the store when they are absent, and a read-only connection cannot take the
 * exclusive lock that would remove them again, so they remain. They inherit the store's
 * own `0600`, hold nothing of their own, and `listStores()` ignores them. Where that does
 * show is a read-only or full volume, which refuses to create them: the open fails and the
 * store is reported unopenable, which is the right verdict by a roundabout route, because
 * an account whose store cannot be written to cannot be served either.
 *
 * Account stores are migrated on their owner's first request, so one that is behind
 * immediately after a deploy is waiting rather than broken — which is why the count is
 * reported and does not degrade the endpoint on its own.
 */
function accountMigrationsApplied(path: string): number {
  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
    timeout: PROBE_LOCK_TIMEOUT_MS,
  });
  try {
    return appliedMigrationLedger(db).length;
  } finally {
    db.close();
  }
}

/**
 * Why the check came out the way it did.
 *
 * A closed set, enumerated here rather than assembled at the call sites, because it is
 * logged: the event stream carries only codes this file authored, and the counts that
 * explain one of them stay in the body where nothing has to be sanitized.
 */
type HealthReason =
  | "store_unavailable"
  | "auth_misconfigured"
  | "auth_local_off_loopback"
  | "account_store_unavailable"
  | "snapshots_stale"
  | "snapshots_missing"
  | "snapshot_directory_unresolved";

type HealthVerdict = {
  status: "ok" | "degraded" | "unavailable";
  outcome: "ok" | "degraded" | "error";
  reason?: HealthReason;
};

function healthVerdict(
  store: StoreReport,
  configuration: AuthConfiguration,
  snapshots: SnapshotSchedulerStatus,
  request: Request,
): HealthVerdict {
  if (store.status === "error") return unavailable("store_unavailable");

  // Every `/api/*` returns 503 and every private page redirects to a login that cannot
  // work. The process is listening and can serve nobody.
  if (configuration.mode === "misconfigured") return unavailable("auth_misconfigured");

  // Local mode is not a fault by itself. `npm run start` is a documented loopback
  // production serve, so `NODE_ENV` cannot tell a workstation apart from a hosted
  // deployment whose Supabase variables went missing — both are "local in production",
  // and treating that pair as an outage makes the endpoint cry wolf at the one
  // configuration this repository tells people to run.
  //
  // The request can tell them apart, and without inferring anything: in local mode the
  // browser boundary answers every request that did not arrive on the loopback authority
  // with a bare 403, so a request reaching this process under any other name is not
  // evidence of an outage, it is the outage arriving. A loopback probe of a loopback
  // serve is left alone.
  if (configuration.mode === "local" && !loopbackAuthority(request)) {
    return unavailable("auth_local_off_loopback");
  }

  if (store.status === "degraded") return degraded("account_store_unavailable");

  const backups = backupVerdict(snapshots);
  return backups ? degraded(backups) : { status: "ok", outcome: "ok" };
}

/**
 * Whether this request arrived on the authority local mode actually serves.
 *
 * Deliberately the same rule `checkBrowserBoundary` enforces, down to the literal
 * address: a hostname that merely resolves to loopback is not equivalent there, and a
 * health verdict written to a looser rule would report a deployment as able to serve
 * requests it answers 403. An absent Host is refused there too, so it is off-loopback
 * here for the same reason.
 */
function loopbackAuthority(request: Request): boolean {
  return /^127\.0\.0\.1(?::\d{1,5})?$/u.test(request.headers.get("host") ?? "");
}

function backupVerdict(snapshots: SnapshotSchedulerStatus): HealthReason | null {
  // An operator who switched the scheduler off is making a standing choice, not
  // regressing, and does not need telling about it every fifteen minutes. Every other
  // scheduler state is judged on what is actually on the volume, so a scheduler that
  // never started, or started and stopped copying, is caught by the same measurement.
  if (snapshots.state === "disabled") return null;

  // What the scheduler says about itself, before what the volume says. A scheduler with
  // nowhere to write will never produce a copy however long it runs, and reaching that
  // verdict through the freshness reading instead leaves it resting on a second
  // measurement failing for the same reason — which it does not always do. With no store
  // on disk yet, freshness answers `not_applicable`, and the body would report a
  // deployment that can never back anything up as `ok` while saying `misconfigured`
  // inside itself.
  if (snapshots.state === "misconfigured") return "snapshot_directory_unresolved";

  switch (snapshots.freshness.state) {
    case "stale":
      return "snapshots_stale";
    case "never":
      return "snapshots_missing";
    case "unknown":
      return "snapshot_directory_unresolved";
    default:
      return null;
  }
}

function unavailable(reason: HealthReason): HealthVerdict {
  return { status: "unavailable", outcome: "error", reason };
}

function degraded(reason: HealthReason): HealthVerdict {
  return { status: "degraded", outcome: "degraded", reason };
}

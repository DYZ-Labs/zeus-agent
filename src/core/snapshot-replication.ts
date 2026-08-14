import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import { errorSignature, logEvent } from "./observability";

/**
 * Hand a verified snapshot to an operator-configured command that can put a copy of it
 * somewhere the store's own volume cannot take with it.
 *
 * A hosted Zeus keeps the store, its pre-migration backups, and its snapshots on one
 * mounted volume — which is precisely the thing a snapshot exists to survive. A deleted
 * volume, a corrupted filesystem, or a mistaken teardown loses the original and every
 * copy of it in the same moment. On a workstation the operator runs the snapshot command
 * and chains `restic backup` after it themselves; inside a server taking snapshots on a
 * timer there is no shell to chain anything to, so this is that hook.
 *
 * `ZEUS_SNAPSHOT_REPLICA_COMMAND` is an **operator** affordance, read from the process
 * environment at the same trust level as the start command itself: whoever can set it
 * already chooses the binary Zeus runs. It is emphatically *not* the user-configurable
 * process spawning Zeus refuses to offer — no signed-in user, no request, no stored row
 * and no model output can reach it, there is no UI for it, and there must never be one.
 * A future reader tidying up "inconsistent" spawning should leave this alone; a future
 * reader tempted to expose it in the connector UI is reintroducing exactly the hole the
 * connector rules close.
 *
 * Zeus still stores no third-party credential for it. restic, rclone and the cloud CLIs
 * read their own secrets from their own environment and files; Zeus neither persists,
 * logs, nor exports any of it.
 *
 * The copy is best effort by design. A snapshot that was created and verified is already
 * a success, so nothing here throws: a failed replication is loud in the log and visible
 * on the health endpoint, and never turns a good backup into a failed one or a server
 * error.
 */

/**
 * How long the command has before the copy is abandoned.
 *
 * Generous enough for a real upload of a multi-gigabyte store over an unremarkable link,
 * bounded because the scheduler awaits this: a command that hangs forever would hold the
 * run open and stop every later store from being backed up at all.
 */
const REPLICATION_TIMEOUT_MS = 10 * 60_000;

/** How long a terminated command has to exit cleanly before it is killed outright. */
const TERMINATION_GRACE_MS = 5_000;

export type SnapshotReplicationFailure =
  | "invalid_snapshot_path"
  | "command_missing"
  | "spawn_failed"
  | "exit_status"
  | "killed_by_signal"
  | "timed_out";

export type SnapshotReplicationOutcome =
  | { status: "not_configured" }
  | { status: "replicated"; durationMs: number }
  | { status: "failed"; reason: SnapshotReplicationFailure };

export type SnapshotReplicationOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  graceMs?: number;
};

export type SnapshotReplicationStatus = {
  state: "configured" | "not_configured";
  lastResult: "ok" | "failed" | null;
  /** A Zeus-authored code from the fixed set above, never a tool's own error text. */
  lastReason: SnapshotReplicationFailure | null;
  lastAttemptAt: string | null;
};

/**
 * The last attempt, on `globalThis` rather than in module scope.
 *
 * Next.js gives instrumentation, route handlers, and the scheduler their own module
 * registries. Held in module scope, the outcome recorded by the timer would live in an
 * instance the health route cannot see, and the endpoint would report "never attempted"
 * forever while replication was failing every night.
 */
type ReplicationRuntime = {
  lastResult: "ok" | "failed" | null;
  lastReason: SnapshotReplicationFailure | null;
  lastAttemptAt: string | null;
};

const globalForReplication = globalThis as typeof globalThis & {
  zeusSnapshotReplication?: ReplicationRuntime;
};

function runtime(): ReplicationRuntime {
  return (globalForReplication.zeusSnapshotReplication ??= {
    lastResult: null,
    lastReason: null,
    lastAttemptAt: null,
  });
}

/**
 * The configured command as argv, or null when replication is not configured.
 *
 * Split on whitespace rather than parsed with shell quoting rules. A half-implemented
 * shell is worse than none: an operator would reasonably expect the other half to work,
 * and the difference between the two would be discovered by a backup that silently
 * stopped leaving the machine. The contract is deliberately dull — each whitespace-run
 * separates one argument, nothing is expanded, and anything that needs quoting, a pipe,
 * or two steps belongs in a script the operator points this at.
 */
export function configuredReplicaCommand(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] | null {
  const configured = environment.ZEUS_SNAPSHOT_REPLICA_COMMAND?.trim();
  if (!configured) return null;
  const argv = configured.split(/\s+/u).filter((entry) => entry.length > 0);
  return argv.length > 0 ? argv : null;
}

/** Reported by the health endpoint so a backup that never leaves the volume is visible. */
export function snapshotReplicationStatus(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SnapshotReplicationStatus {
  const state = configuredReplicaCommand(environment) === null
    ? "not_configured"
    : "configured";
  const recorded = runtime();
  return {
    state,
    lastResult: recorded.lastResult,
    lastReason: recorded.lastReason,
    lastAttemptAt: recorded.lastAttemptAt,
  };
}

/**
 * Copy one published snapshot off the volume, if the operator asked for that.
 *
 * The caller must pass a snapshot that was already created *and verified*: replicating a
 * copy that failed its integrity check would fill the off-box repository with backups
 * that cannot be restored. Never throws, never rejects — the worst outcome is a logged
 * failure and a `failed` status.
 */
export async function replicateSnapshot(
  snapshotPath: string,
  options: SnapshotReplicationOptions = {},
): Promise<SnapshotReplicationOutcome> {
  const argv = configuredReplicaCommand(options.environment ?? process.env);
  if (argv === null) return { status: "not_configured" };

  // A relative path would be resolved against whatever working directory the child
  // happens to inherit, so the command would copy the wrong file or none at all.
  if (!isAbsolute(snapshotPath)) return fail("invalid_snapshot_path", 0);

  const startedAt = Date.now();
  const result = await runReplicaCommand(
    argv,
    snapshotPath,
    options.timeoutMs ?? REPLICATION_TIMEOUT_MS,
    options.graceMs ?? TERMINATION_GRACE_MS,
  );
  const durationMs = Date.now() - startedAt;

  if (result.kind === "ok") {
    logEvent({ event: "snapshot_replicated", outcome: "ok", duration_ms: durationMs });
    return record({ status: "replicated", durationMs });
  }

  return fail(failureReason(result), durationMs, result);
}

/**
 * Report a failed copy loudly and return it as a value.
 *
 * The command's own output is deliberately absent. An exit status is a small integer
 * Zeus's own child returned; a tool's stderr is arbitrary text on somebody else's
 * schedule, and this log stream is an allowlist of fields Zeus wrote itself.
 */
function fail(
  reason: SnapshotReplicationFailure,
  durationMs: number,
  result?: Exclude<CommandResult, { kind: "ok" }>,
): SnapshotReplicationOutcome {
  logEvent({
    event: "snapshot_replication_failed",
    outcome: "error",
    reason,
    duration_ms: durationMs,
    ...(result?.kind === "exited" && result.code !== null ? { exit_code: result.code } : {}),
    ...(result?.kind === "spawn_error" ? errorSignature(result.error) : {}),
  });
  return record({ status: "failed", reason });
}

/** Tests only: forget the recorded attempt. */
export function resetSnapshotReplication(): void {
  delete globalForReplication.zeusSnapshotReplication;
}

type CommandResult =
  | { kind: "ok" }
  | { kind: "timed_out" }
  /** A null code means the machine, an operator, or an OOM killer ended it, not the tool. */
  | { kind: "exited"; code: number | null }
  | { kind: "spawn_error"; error: unknown };

function failureReason(
  result: Exclude<CommandResult, { kind: "ok" }>,
): SnapshotReplicationFailure {
  if (result.kind === "timed_out") return "timed_out";
  if (result.kind === "spawn_error") {
    return errorCode(result.error) === "ENOENT" ? "command_missing" : "spawn_failed";
  }
  return result.code === null ? "killed_by_signal" : "exit_status";
}

function runReplicaCommand(
  argv: readonly string[],
  snapshotPath: string,
  timeoutMs: number,
  graceMs: number,
): Promise<CommandResult> {
  const [command, ...fixedArgs] = argv as readonly [string, ...string[]];

  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...fixedArgs, snapshotPath], {
        // No shell, ever. The snapshot path is appended as its own argv entry rather than
        // pasted into a command line, so a store directory containing a space, a
        // semicolon, or a `$(...)` is one literal argument and not a second command.
        shell: false,
        // The operator's own program, in the environment the operator configured beside
        // it — that is where restic, rclone and the cloud CLIs find their repository and
        // credentials. Deliberately unlike a connector, which gets a filtered environment
        // precisely because a *user* chose what it runs.
        env: process.env,
        // Never "inherit". Zeus's log stream is an allowlist of fields it wrote itself,
        // and in the MCP front door stdout is a protocol channel; a third-party tool's
        // output belongs in a redirect the operator writes inside their own script.
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      // An argv Node refuses outright never reaches the "error" event.
      resolve({ kind: "spawn_error", error });
      return;
    }

    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // A command that ignores termination must not keep the run open regardless; the
      // copy has already missed its window either way.
      killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      killTimer.unref?.();
    }, timeoutMs);
    // Never keep the process alive for a backup copy during a shutdown.
    deadline.unref?.();

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    child.once("error", (error: unknown) => settle({ kind: "spawn_error", error }));
    child.once("close", (code: number | null) => {
      if (timedOut) settle({ kind: "timed_out" });
      else if (code === 0) settle({ kind: "ok" });
      else settle({ kind: "exited", code });
    });
  });
}

function record(outcome: SnapshotReplicationOutcome): SnapshotReplicationOutcome {
  if (outcome.status === "not_configured") return outcome;
  const recorded = runtime();
  recorded.lastResult = outcome.status === "replicated" ? "ok" : "failed";
  recorded.lastReason = outcome.status === "failed" ? outcome.reason : null;
  recorded.lastAttemptAt = new Date().toISOString();
  return outcome;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

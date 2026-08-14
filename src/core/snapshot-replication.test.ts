import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configuredReplicaCommand,
  replicateSnapshot,
  resetSnapshotReplication,
  snapshotReplicationStatus,
} from "./snapshot-replication";

const temporaryDirectories: string[] = [];
let base: string;
let snapshot: string;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  base = mkdtempSync(join(tmpdir(), "zeus-replication-"));
  temporaryDirectories.push(base);
  snapshot = join(base, "zeus.db.zeus-snapshot-0123456789abcdef-copy.db");
  writeFileSync(snapshot, "snapshot bytes", "utf8");
});

/**
 * Where a shell would drop the command substitution below: the working directory the
 * child inherits, not the temporary tree. Cleaned up after the assertion has already
 * failed, so a regression is reported loudly and still leaves the checkout untouched.
 */
const SHELL_SIDE_EFFECT = join(process.cwd(), "pwned");

afterEach(() => {
  resetSnapshotReplication();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(SHELL_SIDE_EFFECT, { force: true });
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A replica command that records the exact argv it was handed.
 *
 * A real child process rather than a mocked `spawn`: the property under test is that no
 * shell ever sees these strings, and only a genuine execution can demonstrate that.
 */
function recordingCommand(receipt: string): string {
  const script = join(base, "record.mjs");
  writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      "const [receipt, ...rest] = process.argv.slice(2);",
      'writeFileSync(receipt, JSON.stringify(rest), "utf8");',
    ].join("\n"),
    "utf8",
  );
  return `${process.execPath} ${script} ${receipt}`;
}

function scriptCommand(name: string, body: readonly string[]): string {
  const script = join(base, name);
  writeFileSync(script, body.join("\n"), "utf8");
  return `${process.execPath} ${script}`;
}

function emittedEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
}

async function until(condition: () => boolean, deadlineMs = 5_000): Promise<boolean> {
  const expiry = Date.now() + deadlineMs;
  while (Date.now() < expiry) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("off-volume snapshot replication", () => {
  it("does nothing at all when no replication command is configured", async () => {
    const outcome = await replicateSnapshot(snapshot);

    expect(outcome).toEqual({ status: "not_configured" });
    // Silent by design: the default deployment is not misconfigured, and the health
    // endpoint is where "no copy is leaving this box" is meant to be visible.
    expect(emittedEvents()).toEqual([]);
    expect(snapshotReplicationStatus()).toEqual({
      state: "not_configured",
      lastResult: null,
      lastReason: null,
      lastAttemptAt: null,
    });
  });

  it("treats a whitespace-only setting as unconfigured rather than as a command", () => {
    expect(configuredReplicaCommand({ ZEUS_SNAPSHOT_REPLICA_COMMAND: "   " })).toBeNull();
    expect(configuredReplicaCommand({})).toBeNull();
    expect(
      configuredReplicaCommand({ ZEUS_SNAPSHOT_REPLICA_COMMAND: " restic  backup --tag zeus " }),
    ).toEqual(["restic", "backup", "--tag", "zeus"]);
  });

  it("runs the configured command with the snapshot path as its final argument", async () => {
    const receipt = join(base, "argv.json");
    vi.stubEnv("ZEUS_SNAPSHOT_REPLICA_COMMAND", recordingCommand(receipt));

    const outcome = await replicateSnapshot(snapshot);

    expect(outcome.status).toBe("replicated");
    // The configured fixed arguments come first, then the one snapshot Zeus just verified.
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([snapshot]);
    expect(snapshotReplicationStatus()).toMatchObject({
      state: "configured",
      lastResult: "ok",
      lastReason: null,
    });
    expect(emittedEvents()).toEqual([
      expect.objectContaining({ event: "snapshot_replicated", outcome: "ok" }),
    ]);
  });

  it("passes a path full of shell metacharacters through as one literal argument", async () => {
    // The security property. Under a shell this name would split on the spaces, truncate
    // at the semicolon, glob on the star, and run the substitution.
    const hostile = join(base, "weird & dir; $(touch pwned) | *");
    mkdirSync(hostile);
    const hostileSnapshot = join(hostile, "zeus snapshot `id`.db");
    writeFileSync(hostileSnapshot, "snapshot bytes", "utf8");
    const receipt = join(base, "argv.json");
    vi.stubEnv("ZEUS_SNAPSHOT_REPLICA_COMMAND", recordingCommand(receipt));

    const outcome = await replicateSnapshot(hostileSnapshot);

    expect(outcome.status).toBe("replicated");
    // Exactly one entry, byte-identical: nothing re-parsed it on the way to the child.
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([hostileSnapshot]);
    expect(existsSync(SHELL_SIDE_EFFECT)).toBe(false);
  });

  it("reports a failing command without failing the snapshot that succeeded", async () => {
    vi.stubEnv(
      "ZEUS_SNAPSHOT_REPLICA_COMMAND",
      scriptCommand("fail.mjs", ["process.exit(3);"]),
    );

    // A verified snapshot is already a success; the copy is best effort on top of it.
    const outcome = await replicateSnapshot(snapshot);

    expect(outcome).toEqual({ status: "failed", reason: "exit_status" });
    expect(snapshotReplicationStatus()).toMatchObject({
      state: "configured",
      lastResult: "failed",
      lastReason: "exit_status",
    });

    const [event] = emittedEvents();
    expect(event).toMatchObject({
      event: "snapshot_replication_failed",
      outcome: "error",
      reason: "exit_status",
      exit_code: 3,
    });
    // The failure is diagnosable without quoting anything Zeus did not write itself.
    const line = JSON.stringify(event);
    expect(line).not.toContain(base);
    expect(line).not.toContain("fail.mjs");
  });

  it("names a replica command that is not installed", async () => {
    vi.stubEnv("ZEUS_SNAPSHOT_REPLICA_COMMAND", join(base, "no-such-replica-tool"));

    expect(await replicateSnapshot(snapshot)).toEqual({
      status: "failed",
      reason: "command_missing",
    });
  });

  it("refuses a snapshot path the child would resolve against its own directory", async () => {
    const receipt = join(base, "argv.json");
    vi.stubEnv("ZEUS_SNAPSHOT_REPLICA_COMMAND", recordingCommand(receipt));

    expect(await replicateSnapshot("snapshots/zeus.db")).toEqual({
      status: "failed",
      reason: "invalid_snapshot_path",
    });
    expect(existsSync(receipt)).toBe(false);
  });

  it("kills a command that hangs instead of holding the backup run open", async () => {
    const pidFile = join(base, "pid");
    vi.stubEnv(
      "ZEUS_SNAPSHOT_REPLICA_COMMAND",
      `${scriptCommand("hang.mjs", [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], String(process.pid), "utf8");',
        // Ignoring termination is the case the escalation exists for.
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1_000);",
      ])} ${pidFile}`,
    );

    const running = replicateSnapshot(snapshot, { timeoutMs: 1_000, graceMs: 200 });
    expect(await until(() => existsSync(pidFile))).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));

    expect(await running).toEqual({ status: "failed", reason: "timed_out" });
    // Bounded for real: the child is gone, not merely stopped being waited on.
    expect(await until(() => !processIsAlive(pid))).toBe(true);
    expect(emittedEvents()).toEqual([
      expect.objectContaining({ event: "snapshot_replication_failed", reason: "timed_out" }),
    ]);
  });
});

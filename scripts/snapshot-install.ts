import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  buildSnapshotLaunchAgentPlist,
  SNAPSHOT_LAUNCH_AGENT_LABEL,
} from "../src/core/snapshot-launch-agent";
import { defaultDbPath } from "../src/core/db";
import {
  configuredSnapshotHour,
  configuredSnapshotRetention,
  defaultSnapshotDirectory,
} from "../src/core/snapshots";
import { loadLocalEnvironment } from "./local-env";

const repositoryRoot = resolve(import.meta.dirname, "..");
loadLocalEnvironment(repositoryRoot);
const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const worker = join(repositoryRoot, "scripts", "snapshot.ts");
const plistPath = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${SNAPSHOT_LAUNCH_AGENT_LABEL}.plist`,
);
const logDirectory = join(homedir(), ".zeus", "logs");
const databasePath = resolve(defaultDbPath());
const snapshotDirectory = defaultSnapshotDirectory(databasePath);

mkdirSync(dirname(plistPath), { recursive: true, mode: 0o700 });
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });

const plist = buildSnapshotLaunchAgentPlist({
  nodePath: process.execPath,
  tsxCliPath: tsxCli,
  workerPath: worker,
  databasePath,
  snapshotDirectory,
  retention: configuredSnapshotRetention(),
  hour: configuredSnapshotHour(),
  stdoutPath: join(logDirectory, "snapshot.log"),
  stderrPath: join(logDirectory, "snapshot-error.log"),
});
writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
chmodSync(plistPath, 0o600);

const domain = `gui/${process.getuid?.() ?? 0}`;
spawnSync("/bin/launchctl", ["bootout", domain, plistPath], {
  shell: false,
  stdio: "ignore",
});
const installed = spawnSync("/bin/launchctl", ["bootstrap", domain, plistPath], {
  encoding: "utf8",
  shell: false,
  stdio: ["ignore", "ignore", "pipe"],
});
if (installed.status !== 0) throw new Error("Could not install the Zeus snapshot LaunchAgent");
process.stdout.write(
  `Installed ${SNAPSHOT_LAUNCH_AGENT_LABEL}; snapshots run at load and daily.\n`,
);

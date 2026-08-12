import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AMBIENT_LAUNCH_AGENT_LABEL,
  buildAmbientLaunchAgentPlist,
} from "../src/core/ambient-launch-agent";
import { defaultDbPath } from "../src/core/db";

const LABEL = AMBIENT_LAUNCH_AGENT_LABEL;
const repositoryRoot = resolve(import.meta.dirname, "..");
const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const worker = join(repositoryRoot, "scripts", "ambient-worker.ts");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logDirectory = join(homedir(), ".zeus", "logs");
const stdoutPath = join(logDirectory, "ambient-worker.log");
const stderrPath = join(logDirectory, "ambient-worker-error.log");
const databasePath = resolve(defaultDbPath());

mkdirSync(dirname(plistPath), { recursive: true, mode: 0o700 });
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });

const plist = buildAmbientLaunchAgentPlist({
  nodePath: process.execPath,
  tsxCliPath: tsxCli,
  workerPath: worker,
  databasePath,
  stdoutPath,
  stderrPath,
});

writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
chmodSync(plistPath, 0o600);

const domain = `gui/${process.getuid?.() ?? 0}`;
// Bootout is intentionally best-effort so reinstalling updates an existing agent.
spawnSync("/bin/launchctl", ["bootout", domain, plistPath], {
  shell: false,
  stdio: "ignore",
});
const installed = spawnSync("/bin/launchctl", ["bootstrap", domain, plistPath], {
  encoding: "utf8",
  shell: false,
  stdio: ["ignore", "ignore", "pipe"],
});
if (installed.status !== 0) {
  throw new Error("Could not install the Zeus ambient LaunchAgent");
}
process.stdout.write(`Installed ${LABEL}; Zeus will evaluate current opportunities every 15 minutes.\n`);

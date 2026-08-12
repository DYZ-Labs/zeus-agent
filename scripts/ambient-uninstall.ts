import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AMBIENT_LAUNCH_AGENT_LABEL } from "../src/core/ambient-launch-agent";

const label = AMBIENT_LAUNCH_AGENT_LABEL;
const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid?.() ?? 0}`;

if (existsSync(plistPath)) {
  spawnSync("/bin/launchctl", ["bootout", domain, plistPath], {
    shell: false,
    stdio: "ignore",
  });
  unlinkSync(plistPath);
}
process.stdout.write(`Uninstalled ${label}. Ambient delivery data remains in Zeus.\n`);

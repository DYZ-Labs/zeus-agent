import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SNAPSHOT_LAUNCH_AGENT_LABEL } from "../src/core/snapshot-launch-agent";

const plistPath = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${SNAPSHOT_LAUNCH_AGENT_LABEL}.plist`,
);
const domain = `gui/${process.getuid?.() ?? 0}`;

if (existsSync(plistPath)) {
  const stopped = spawnSync("/bin/launchctl", ["bootout", domain, plistPath], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (stopped.status !== 0) {
    throw new Error(
      "Could not stop the Zeus snapshot LaunchAgent; its plist was left in place",
    );
  }
  unlinkSync(plistPath);
} else {
  const loaded = spawnSync("/bin/launchctl", ["print", `${domain}/${SNAPSHOT_LAUNCH_AGENT_LABEL}`], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (loaded.status === 0) {
    throw new Error(
      "The Zeus snapshot LaunchAgent is still loaded but its plist is missing; stop it with launchctl before restoring",
    );
  }
}
process.stdout.write(
  `Uninstalled ${SNAPSHOT_LAUNCH_AGENT_LABEL}. Existing snapshots remain available.\n`,
);

import { spawnSync } from "node:child_process";

import type { AmbientNotification, AmbientNotifier } from "./ambient";

const NOTIFICATION_SCRIPT = `on run argv
  set notificationTitle to item 1 of argv
  set notificationBody to item 2 of argv
  display notification notificationBody with title notificationTitle
end run`;

/** macOS notification adapter. Values travel as argv rather than executable AppleScript. */
export class MacOsNotifier implements AmbientNotifier {
  deliver(notification: AmbientNotification): boolean {
    if (process.platform !== "darwin") return false;
    const result = spawnSync(
      "/usr/bin/osascript",
      ["-e", NOTIFICATION_SCRIPT, notification.title, notification.body],
      {
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10_000,
      },
    );
    return result.status === 0 && result.error === undefined;
  }
}

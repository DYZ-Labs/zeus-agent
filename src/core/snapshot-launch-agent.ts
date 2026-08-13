export const SNAPSHOT_LAUNCH_AGENT_LABEL = "com.zeus.snapshot";

export type SnapshotLaunchAgentConfig = {
  nodePath: string;
  tsxCliPath: string;
  workerPath: string;
  databasePath: string;
  snapshotDirectory: string;
  retention: number;
  hour: number;
  stdoutPath: string;
  stderrPath: string;
};

/** Pure plist renderer so every installed path and policy is testable. */
export function buildSnapshotLaunchAgentPlist(config: SnapshotLaunchAgentConfig): string {
  validateHour(config.hour);
  validateRetention(config.retention);
  const argumentsXml = [
    config.nodePath,
    config.tsxCliPath,
    config.workerPath,
    "--db",
    config.databasePath,
    "--directory",
    config.snapshotDirectory,
    "--retention",
    String(config.retention),
  ]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SNAPSHOT_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${config.hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(config.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.stderrPath)}</string>
</dict>
</plist>
`;
}

function validateHour(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 23) {
    throw new Error("Snapshot hour must be an integer from 0 through 23");
  }
}

function validateRetention(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Snapshot retention must be an integer between 1 and 10000");
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

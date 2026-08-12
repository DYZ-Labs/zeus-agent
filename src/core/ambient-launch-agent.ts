export const AMBIENT_LAUNCH_AGENT_LABEL = "com.zeus.ambient";

export type AmbientLaunchAgentConfig = {
  nodePath: string;
  tsxCliPath: string;
  workerPath: string;
  databasePath: string;
  stdoutPath: string;
  stderrPath: string;
};

/** Pure plist renderer so installation paths, including ZEUS_DB overrides, are testable. */
export function buildAmbientLaunchAgentPlist(config: AmbientLaunchAgentConfig): string {
  const argumentsXml = [
    config.nodePath,
    config.tsxCliPath,
    config.workerPath,
    "--db",
    config.databasePath,
  ]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AMBIENT_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

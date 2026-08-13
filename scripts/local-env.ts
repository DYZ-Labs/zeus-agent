import { existsSync } from "node:fs";
import { join } from "node:path";

/** Match the repository's documented .env.local configuration for standalone CLIs. */
export function loadLocalEnvironment(repositoryRoot: string): void {
  const path = join(repositoryRoot, ".env.local");
  if (existsSync(path)) process.loadEnvFile(path);
}

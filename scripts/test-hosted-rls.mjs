import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const databaseUrl = process.env.HOSTED_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("HOSTED_TEST_DATABASE_URL must point to a disposable Postgres database.");
  process.exit(1);
}
if (process.env.ZEUS_ALLOW_DESTRUCTIVE_HOSTED_TESTS !== "1") {
  console.error(
    "Set ZEUS_ALLOW_DESTRUCTIVE_HOSTED_TESTS=1 only after confirming the database is disposable.",
  );
  process.exit(1);
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  path.join(repository, "supabase/migrations/202608120001_consumer_v1.sql"),
  path.join(repository, "supabase/tests/two_user_isolation.sql"),
];

for (const file of files) {
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-f", file],
    {
      cwd: repository,
      env: { ...process.env, PGDATABASE: databaseUrl },
      stdio: "inherit",
    },
  );
  if (result.error) {
    console.error("Could not start psql for the hosted isolation gate.");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

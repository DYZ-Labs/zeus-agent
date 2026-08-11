import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests run against in-memory SQLite via openTestDb(), so nothing here can
    // reach the real store. ZEUS_DB is pinned as a second line of defence.
    env: { ZEUS_DB: ":memory:" },
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});

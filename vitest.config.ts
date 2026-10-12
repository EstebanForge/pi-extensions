import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // contract the auth-heavy suites rely on: no module/state leakage across files
    isolate: true,
    include: ["packages/*/tests/**/*.test.ts"],
    // Release-gate determinism: with parallel workers, a cold vite transform
    // cache under full load let a late module fetch (tool-display -> kit)
    // resolve after per-file teardown, failing `npm run check` with an
    // unhandled EnvironmentTeardownError. Sequential files remove the race.
    fileParallelism: false,
  },
});

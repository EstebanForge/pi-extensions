import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // contract the auth-heavy suites rely on: no module/state leakage across files
    isolate: true,
    include: ["packages/*/tests/**/*.test.ts", "scripts/tests/**/*.test.mjs"],
    // fileParallelism stays at its default (true). It was once pinned false:
    // a cold vite transform cache under full load let a late module fetch
    // (tool-display -> kit) resolve after per-file teardown, failing with an
    // unhandled EnvironmentTeardownError. Re-validated green on the current
    // toolchain, warm and cold cache (~43s vs ~139s sequential). Re-pin only
    // with a reproducer.
  },
});
